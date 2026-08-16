//! Tauri 命令桥接层：把 Rust 能力暴露给前端 invoke。
//! 生成流程：取 key → submit → （异步轮询）→ 下载落盘 → 写历史 → 返回结果，全程 emit 进度事件。

use tauri::{AppHandle, Emitter, State};

use futures_util::StreamExt;

use crate::models::{
    GenRequest, GenerationResultDto, HistoryTaskDto, HttpRecord, LayerCompositionDto, LayerMetaDto,
    ProgressPayload, ProviderInfoDto, SessionRow, TaskHandle, TaskPhase, UserModelRow,
};
use crate::providers::{
    all_providers, dashscope, get_provider, sanitize_body, volcark, GenerationProvider,
};
use crate::storage;

// 审计#12 修正：曾在此引入全局生成并发信号量（上限 4，许可覆盖提交+轮询+下载全生命周期）。
// 实测发现这是队头阻塞——视频任务轮询最长 60 分钟，4 个视频任务可把许可占满一小时，
// 期间后续任务连提交都轮不到。轮询本身是 3~5s 一次的轻量短请求，不应计入并发预算；
// 真正需要约束的是单任务内扇出（volcark 单图提交 buffer_unordered(4)、下载 buffer_unordered(3)），
// 已单独受限。故任务级并发不设全局上限。

#[tauri::command]
pub fn list_providers() -> Vec<ProviderInfoDto> {
    all_providers()
}

#[tauri::command]
pub fn get_app_dir() -> String {
    storage::app_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub async fn save_api_key(provider_id: String, api_key: String) -> Result<(), String> {
    // keys.json 文件 IO，丢阻塞线程池避免占主线程/tokio worker。
    tokio::task::spawn_blocking(move || storage::save_key(&provider_id, &api_key))
        .await
        .map_err(|e| format!("保存密钥异常: {}", e))?
}

#[tauri::command]
pub async fn get_api_key(provider_id: String) -> Result<Option<String>, String> {
    let pid = provider_id.clone();
    // 只回显掩码（存在性 + 首尾 4 位），完整密钥不出后端——前端仅需判断"是否已设置"。
    let key = tokio::task::spawn_blocking(move || storage::get_key(&pid))
        .await
        .map_err(|e| format!("读取密钥异常: {}", e))??;
    Ok(key.map(|k| mask_key(&k)))
}

/// 密钥掩码："sk-abcdefgh1234" → "sk-a...1234"；过短（≤8 字符）统一 "****"。
fn mask_key(k: &str) -> String {
    let n = k.chars().count();
    if n <= 8 {
        return "****".to_string();
    }
    let head: String = k.chars().take(4).collect();
    let tail: String = k.chars().skip(n - 4).collect();
    format!("{}...{}", head, tail)
}

#[tauri::command]
pub async fn delete_api_key(provider_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || storage::delete_key(&provider_id))
        .await
        .map_err(|e| format!("删除密钥异常: {}", e))?
}

// WorkspaceId：业务空间专属域名（https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com）
#[tauri::command]
pub async fn save_workspace_id(provider_id: String, workspace_id: String) -> Result<(), String> {
    let ws = workspace_id.trim();
    // 防误输入污染域名：仅允许字母/数字/连字符（https://{ws}.cn-beijing.maas.aliyuncs.com）
    if !ws.is_empty() && !ws.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("WorkspaceId 只能包含字母、数字与连字符".to_string());
    }
    let ws = ws.to_string();
    let pid = provider_id.clone();
    tokio::task::spawn_blocking(move || storage::save_workspace(&pid, &ws))
        .await
        .map_err(|e| format!("保存 WorkspaceId 异常: {}", e))??;
    // 审计#12：workspace 变更使 dashscope 的 base_url 缓存失效，下次请求即用新域名。
    if provider_id == dashscope::PROVIDER_ID {
        dashscope::invalidate_base_url_cache();
    }
    Ok(())
}

#[tauri::command]
pub async fn get_workspace_id(provider_id: String) -> Result<Option<String>, String> {
    let pid = provider_id.clone();
    tokio::task::spawn_blocking(move || storage::get_workspace(&pid))
        .await
        .map_err(|e| format!("读取 WorkspaceId 异常: {}", e))?
}

#[tauri::command]
pub async fn test_api_key(
    provider_id: String,
    client: State<'_, reqwest::Client>,
) -> Result<String, String> {
    let pid = provider_id.clone();
    let api_key = tokio::task::spawn_blocking(move || storage::get_key(&pid))
        .await
        .map_err(|e| format!("读取密钥异常: {}", e))??
        .ok_or("未设置 API Key")?;
    let provider = get_provider(&provider_id, client.inner().clone()).ok_or("未知的 provider")?;
    provider.test_connectivity(&api_key).await
}

#[tauri::command]
pub async fn generate(
    app: AppHandle,
    mut req: GenRequest,
    client: State<'_, reqwest::Client>,
) -> Result<GenerationResultDto, String> {
    let provider_id = req.provider_id.clone();
    let provider = get_provider(&provider_id, client.inner().clone()).ok_or("未知的 provider")?;
    // keys.json 读取是同步文件 IO，丢阻塞线程池避免占 tokio 工作线程。
    let pid_key = provider_id.clone();
    let api_key = tokio::task::spawn_blocking(move || storage::get_key(&pid_key))
        .await
        .map_err(|e| format!("读取密钥异常: {}", e))??
        .ok_or("未设置 API Key，请先在设置页填入")?;

    // 审计#12 诊断：任务级分阶段计时（毫秒），定位慢任务时间去向（提交/轮询/下载/缩略图）。
    let t_start = std::time::Instant::now();

    let _ = app.emit(
        "gen-progress",
        ProgressPayload {
            task_id: req.task_id.clone(),
            phase: "submitting".to_string(),
            progress: 10,
            message: "正在提交生成请求...".to_string(),
        },
    );

    // 参考图收编：data URL/本地文件/asset URL 统一复制进受管 input 目录（ComfyUI 式），
    // 收编后的路径/URL 写入 params_json.references，重新生成时可直接复用；
    // 公网 URL 原样保留。收编后再归一化为 data URL 提交（厂商只能拿到公网 URL 或 data URL）。
    // 参考图是可达数 MB 的 base64 串，用 mem::take 移出（零拷贝），req2 克隆时已为空，
    // 且收编+归一化合并进同一个 spawn_blocking 内完成，全程只此一份数据。
    let req_refs = std::mem::take(&mut req.references);
    let mut req2 = req.clone();
    let (collected_refs, norm_refs) = tokio::task::spawn_blocking(move || {
        let collected: Vec<String> = req_refs
            .iter()
            .map(|r| storage::save_reference(r))
            .collect::<Result<Vec<_>, _>>()?;
        let normalized = collected
            .iter()
            .map(|r| storage::normalize_reference(r))
            .collect::<Result<Vec<_>, _>>()?;
        Ok::<_, String>((collected, normalized))
    })
    .await
    .map_err(|e| format!("参考图处理异常: {}", e))??;
    req2.references = norm_refs;

    // —— 提交即落库：先写 running 行，成功/失败终态再回写 ——
    // 会话与时间线完全以 SQLite 为权威（前端已无 localStorage 业务数据）：
    // 进行中任务重启后按 running 行恢复为「中断」卡；失败任务也留行，
    // 图库可重新编辑、产物不会因瞬时错误/写库前崩溃而永久丢失。
    let model = req
        .model
        .clone()
        .unwrap_or_else(|| provider.default_model().to_string());
    let mut params_obj = serde_json::json!({
        "size": req.size,
        "n": req.n,
        "aspect_ratio": req.aspect_ratio,
        "quality": req.quality,
        "duration": req.duration,
        // 生图模式（single/group）：重新编辑/重新生成时恢复组图任务需要它
        "mode": req.mode,
        "output_format": req.output_format,
        "optimize_prompt_mode": req.optimize_prompt_mode,
        "background": req.background,
        "web_search": req.web_search,
        "layer_decomposition": req.layer_decomposition,
        // 收编后的参考图路径/URL 数组（本地文件已复制进 inputs 目录，生命周期由应用管理）
        "references": collected_refs,
    });
    // 魔搭自由参数快照（steps/guidance/seed/negative_prompt/loras 等）原样并入
    // params_json：详情页/图库按 params_json 消费完整参数，重新编辑时回填弹层。
    // 结构化字段（size/n/aspect_ratio/quality/duration/mode/output_format/optimize_prompt_mode/
    // background/web_search/layer_decomposition/references）以顶部 json! 为准——用户自建模型
    // 声明同名 key 时跳过，防止污染快照。注意：与前端 src/studios/sessionStore.ts 的
    // STRUCTURED_PARAM_KEYS 保持同步。
    const STRUCTURED_PARAM_KEYS: &[&str] = &[
        "size",
        "n",
        "aspect_ratio",
        "quality",
        "duration",
        "mode",
        "output_format",
        "optimize_prompt_mode",
        "background",
        "web_search",
        "layer_decomposition",
        "references",
    ];
    if let Some(map) = req
        .extra
        .as_ref()
        .and_then(|e| e.get("params"))
        .and_then(|p| p.as_object())
    {
        for (k, v) in map {
            if STRUCTURED_PARAM_KEYS.contains(&k.as_str()) {
                continue;
            }
            params_obj[k] = v.clone();
        }
    }
    let history_id = storage::insert_task(storage::HistoryInsert {
        provider: provider_id.clone(),
        model: model.clone(),
        capability: req.capability.clone(),
        prompt: req.prompt.clone(),
        params_json: Some(params_obj.to_string()),
        status: "running".to_string(),
        local_paths_json: "[]".to_string(),
        remote_urls_json: None,
        thumbnail_path: None,
        request_json: None,
        raw_response: None,
        error: None,
        session_id: req.session_id.clone(),
    })?;

    let handle = match provider.submit(&req2, &api_key).await {
        Ok(h) => h,
        Err(e) => {
            fail_generation(&app, &req.task_id, history_id, &collected_refs, &[], &e)?;
            return Err(e);
        }
    };
    if handle.phase == TaskPhase::Failed {
        let err = handle.error.unwrap_or_else(|| "生成失败".to_string());
        fail_generation(&app, &req.task_id, history_id, &collected_refs, &[], &err)?;
        return Err(err);
    }
    eprintln!(
        "[gen] task={} phase=submit_done elapsed={:?}",
        req.task_id,
        t_start.elapsed()
    );

    // 同步厂商：submit 已置 Succeeded，remote_urls 在 handle 内。
    // 异步厂商：submit 返回 Submitted + task_id，轮询至终态，结果 URL 在 snapshot.remote_urls。
    let (remote_urls, mut http_log, poll_log) = if handle.phase == TaskPhase::Succeeded {
        (handle.remote_urls, handle.http_log, Vec::new())
    } else {
        let (urls, poll_log) = poll_to_finish(
            &app,
            provider.as_ref(),
            &handle,
            &api_key,
            &req.capability,
            &collected_refs,
            history_id,
            &req.task_id,
        )
        .await?;
        (urls, handle.http_log, poll_log)
    };
    // 提交记录 + 终态轮询记录合并（按下标对应）
    http_log.extend(poll_log);
    // 图层拆分：从提交响应中解析 z_index/bounding_box 等元数据，写 sidecar 供详情面板读取。
    // 解析器在 volcark 模块内，响应体已由 sanitize_body 保留 JSON 结构与短字段。
    let layer_metas = if req.layer_decomposition == Some(true) {
        let metas = http_log
            .iter()
            .rev()
            .find_map(|r| volcark::parse_layer_metas_from_body(&r.response_body));
        match metas {
            Some(m) if !m.is_empty() => Some(m),
            _ => {
                let err = "图层拆分响应缺少图层元数据".to_string();
                fail_generation(&app, &req.task_id, history_id, &collected_refs, &[], &err)?;
                return Err(err);
            }
        }
    } else {
        None
    };
    eprintln!(
        "[gen] task={} phase=poll_done elapsed={:?}",
        req.task_id,
        t_start.elapsed()
    );

    let _ = app.emit(
        "gen-progress",
        ProgressPayload {
            task_id: req.task_id.clone(),
            phase: "downloading".to_string(),
            progress: 95,
            message: "正在下载生成结果...".to_string(),
        },
    );

    // 诊断日志：多张并行时确认厂商返回的 URL 是否独立（若出现重复 URL 则是服务端幂等去重）。
    // 审计#12：收敛为计数 + 去重数，不再打印完整 URL 数组（并行任务时刷屏）。
    let unique_urls = remote_urls
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>()
        .len();
    eprintln!(
        "[gen] task={} n={} capability={} remote_urls={} (unique={})",
        req.task_id,
        req.n,
        req.capability,
        remote_urls.len(),
        unique_urls,
    );

    let local_paths = match download_all(client.inner().clone(), &remote_urls, model.clone()).await
    {
        Ok(paths) => paths,
        Err((e, partial)) => {
            fail_generation(
                &app,
                &req.task_id,
                history_id,
                &collected_refs,
                &partial,
                &e,
            )?;
            return Err(e);
        }
    };
    eprintln!(
        "[gen] task={} local_paths={} phase=download_done elapsed={:?}",
        req.task_id,
        local_paths.len(),
        t_start.elapsed()
    );

    // 图库缩略图：仅图像产物生成（视频无首帧能力，前端用占位卡）。
    // 每张图都生成 256px webp 缩略图（{stem}.thumb.webp 命名约定，网格按此渲染），
    // 避免网格直接解码全尺寸原图导致图库量大时卡顿；
    // thumbnail_path 字段存第一张（详情/兼容旧逻辑用）。
    // 原图文件保持下载原样，不做任何重编码。
    // 解码+编码是 CPU 密集，走阻塞线程池（ensure_thumbnails 同款模式）。
    // 审计#12：缩略图彼此独立，原先逐张 await 串行（2K/4K 解码+编码累加耗时）；
    // 改为受控并发（上限 3，buffer_unordered 保持产物顺序，首张仍为 thumbnail_path）。
    let image_paths: Vec<String> = local_paths
        .iter()
        .filter(|p| storage::is_image_path(p))
        .cloned()
        .collect();
    let thumb_futs = image_paths.into_iter().map(make_thumbnail_blocking);
    let thumbs: Vec<Option<String>> = futures_util::stream::iter(thumb_futs)
        .buffer_unordered(3)
        .collect()
        .await;
    let thumbnail_path = thumbs.first().and_then(|t| t.clone());
    eprintln!(
        "[gen] task={} phase=thumbs_done elapsed={:?}",
        req.task_id,
        t_start.elapsed()
    );

    // 图层元数据 sidecar：下载成功后按 history_id 落盘；删除任务与失败路径都会同步清理。
    if let Some(metas) = layer_metas.as_ref() {
        if let Err(e) = storage::save_layer_meta(history_id, metas) {
            fail_generation(
                &app,
                &req.task_id,
                history_id,
                &collected_refs,
                &local_paths,
                &e,
            )?;
            return Err(e);
        }
    }

    let local_json = serde_json::to_string(&local_paths).unwrap_or_else(|_| "[]".to_string());
    let remote_json = serde_json::to_string(&remote_urls).ok();

    // HTTP 调试记录：请求数组与响应数组按下标一一对应（一次任务可能含多次提交/轮询交换）。
    // 请求体写库前统一脱敏：提交体里的 base64 参考图（单张可达数 MB）替换为长度标记，
    // 与厂商侧对响应体做的事一致（mod.rs sanitize_body），保证记录体积有界。
    let http_req_json = serde_json::to_string(
        &http_log
            .iter()
            .map(|r| {
                serde_json::json!({
                    "method": r.method,
                    "url": r.url,
                    "body": r.request_body.as_deref().map(sanitize_body),
                })
            })
            .collect::<Vec<_>>(),
    )
    .ok();
    let http_resp_json = serde_json::to_string(
        &http_log
            .iter()
            .map(|r| {
                serde_json::json!({
                    "method": r.method,
                    "url": r.url,
                    "status": r.status,
                    "body": r.response_body,
                })
            })
            .collect::<Vec<_>>(),
    )
    .ok();

    // 终态回写：running 行 → succeeded（提交即落库，前端时间线/图库以库为准）。
    storage::update_task_result(
        history_id,
        "succeeded",
        &local_json,
        remote_json.as_deref(),
        thumbnail_path.as_deref(),
        Some(&params_obj.to_string()),
        http_req_json.as_deref(),
        http_resp_json.as_deref(),
        None,
    )?;

    let _ = app.emit(
        "gen-progress",
        ProgressPayload {
            task_id: req.task_id.clone(),
            phase: "done".to_string(),
            progress: 100,
            message: "完成".to_string(),
        },
    );

    Ok(GenerationResultDto {
        history_id,
        provider_id,
        model,
        local_paths,
        remote_urls,
        // 写入库的完整参数快照原样返回：重新编辑时前端按这份数据库 JSON 拼接回填，
        // 与图库入口（list_history 的 params_json）同源，不做第二套快照字段。
        params_json: params_obj.to_string(),
    })
}

/// 失败统一收尾：清理已产生的文件 + 写库终态 + 推送 failed 事件。
/// 收敛原先 5 处重复的 cleanup + update_task_result + emit 序列。
fn fail_generation(
    app: &AppHandle,
    task_id: &str,
    history_id: i64,
    refs: &[String],
    paths: &[String],
    err: &str,
) -> Result<(), String> {
    cleanup_files(refs);
    cleanup_files(paths);
    let _ = storage::delete_layer_meta(history_id);
    let _ = storage::update_task_result(
        history_id,
        "failed",
        "[]",
        None,
        None,
        None,
        None,
        None,
        Some(err),
    );
    let _ = app.emit(
        "gen-progress",
        ProgressPayload {
            task_id: task_id.to_string(),
            phase: "failed".to_string(),
            progress: 100,
            message: err.to_string(),
        },
    );
    Ok(())
}

/// 轮询至终态（异步厂商）。含轮询失败重试（状态查询是幂等的 GET，连续 3 次失败才判失败）
/// 与轮询总时长上限（厂商任务卡死时不能无限轮询，图像 20 分钟/视频 60 分钟；
/// 超时后服务端任务可能仍在生成并计费——错误文案提示用户稍后可到图库核对）。
/// 终态前一律经 fail_generation 收尾并返回 Err。
/// 参数来自 generate 的多个来源（app/request/provider/history），各自独立无聚合意义，故允许。
#[allow(clippy::too_many_arguments)]
async fn poll_to_finish(
    app: &AppHandle,
    provider: &dyn GenerationProvider,
    handle: &TaskHandle,
    api_key: &str,
    capability: &str,
    refs: &[String],
    history_id: i64,
    task_id: &str,
) -> Result<(Vec<String>, Vec<HttpRecord>), String> {
    // 视频轮询间隔 5s，图像 3s。
    let is_video = capability == "t2v" || capability == "i2v";
    let interval = if is_video { 5u64 } else { 3u64 };
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_secs(if is_video { 60 * 60 } else { 20 * 60 });
    let mut last_progress = 15i32;
    loop {
        if std::time::Instant::now() >= deadline {
            let err = "任务超时（生成超过时限），请稍后到图库查看是否已生成".to_string();
            fail_generation(app, task_id, history_id, refs, &[], &err)?;
            return Err(err);
        }
        let mut snap = None;
        let mut last_err = String::new();
        for attempt in 0..3u64 {
            match provider.poll(handle, api_key).await {
                Ok(s) => {
                    snap = Some(s);
                    break;
                }
                Err(e) => {
                    last_err = e;
                    tokio::time::sleep(std::time::Duration::from_millis(1200 * (attempt + 1)))
                        .await;
                }
            }
        }
        let snap = match snap {
            Some(s) => s,
            None => {
                fail_generation(app, task_id, history_id, refs, &[], &last_err)?;
                return Err(last_err);
            }
        };
        // 只保留最后一次轮询的交换记录（提交记录在 handle.http_log 中保留）
        let poll_log = snap.http_log.clone();
        match snap.phase {
            TaskPhase::Succeeded => return Ok((snap.remote_urls, poll_log)),
            TaskPhase::Failed => {
                let err = snap.message.unwrap_or_else(|| "生成失败".to_string());
                fail_generation(app, task_id, history_id, refs, &[], &err)?;
                return Err(err);
            }
            _ => {
                // Running / Submitted：优先用原厂进度，缺省则按 15→95 单调递增封顶。
                if snap.progress > 0 {
                    last_progress = snap.progress.min(95);
                } else {
                    last_progress = (last_progress + 10).min(95);
                }
                let _ = app.emit(
                    "gen-progress",
                    ProgressPayload {
                        task_id: task_id.to_string(),
                        phase: "running".to_string(),
                        progress: last_progress,
                        message: snap.message.unwrap_or_else(|| "生成中...".to_string()),
                    },
                );
                tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
            }
        }
    }
}

/// 下载产物，单 URL 重试 3 次（结果 URL 的 GET 幂等，瞬时失败重试不产生额外费用）；
/// 任一 URL 连续失败返回 Err，且携带已下载的部分路径供调用方统一清理。
/// 审计#12：多产物下载彼此独立，原先串行（多图/视频批量总时长线性累加）；改为受控
/// 并发（上限 3，buffer_unordered 保持产物顺序），失败语义不变。client/model 值传入，
/// 每项 future 完全拥有输入数据（reqwest::Client 为 Arc 廉价克隆），消除闭包借用问题。
async fn download_all(
    client: reqwest::Client,
    remote_urls: &[String],
    model: String,
) -> Result<Vec<String>, (String, Vec<String>)> {
    let futs = remote_urls.iter().cloned().map(move |url| {
        let client = client.clone();
        let model = model.clone();
        async move {
            let mut last_err = String::new();
            for attempt in 0..3u64 {
                match storage::save_remote(&client, &url, &model).await {
                    Ok(p) => return Ok::<String, String>(p),
                    Err(e) => {
                        last_err = e;
                        tokio::time::sleep(std::time::Duration::from_millis(1000 * (attempt + 1)))
                            .await;
                    }
                }
            }
            Err(format!("下载失败: {}", last_err))
        }
    });
    let results: Vec<Result<String, String>> = futures_util::stream::iter(futs)
        .buffer_unordered(3)
        .collect()
        .await;
    let mut local_paths = Vec::new();
    let mut first_err: Option<String> = None;
    for r in results {
        match r {
            Ok(p) => local_paths.push(p),
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
    }
    match first_err {
        Some(e) => Err((e, local_paths)),
        None => Ok(local_paths),
    }
}

/// 失败路径尽力清理本次任务已产生的文件（参考图收编副本 / 已下载产物），
/// 避免 inputs/outputs 在失败任务上累积垃圾（成功路径的 inputs 副本保留供重新生成复用）。
fn cleanup_files(paths: &[String]) {
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
}

/// 生成单张缩略图（图像解码+编码 CPU 密集）：在阻塞线程池执行，避免占 tokio 工作线程。
/// 审计#12：形参改值传入（String）——并发流里每项的 future 完全拥有输入数据，
/// 消除「FnOnce 不够泛化」的闭包借用问题。
async fn make_thumbnail_blocking(p: String) -> Option<String> {
    tokio::task::spawn_blocking(move || storage::make_thumbnail(&p))
        .await
        .ok()
        .and_then(|r| r.ok())
}

#[tauri::command]
pub async fn list_sessions() -> Result<Vec<SessionRow>, String> {
    // SQLite 查询是同步 IO，丢阻塞线程池避免占主线程。
    tokio::task::spawn_blocking(storage::list_sessions)
        .await
        .map_err(|e| format!("查询会话异常: {}", e))?
}

#[tauri::command]
pub async fn upsert_session(s: SessionRow) -> Result<(), String> {
    // 会话持久化会被任务进度事件高频触发（前端已按变更检测 + 冷却窗口收敛写入频率），
    // 仍丢阻塞线程池：同步命令跑主线程，SQLite 事务含 fsync，避免任何写库阻塞 UI。
    tokio::task::spawn_blocking(move || storage::upsert_session(&s))
        .await
        .map_err(|e| format!("保存会话异常: {}", e))?
}

#[tauri::command]
pub async fn delete_session(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || storage::delete_session(&id))
        .await
        .map_err(|e| format!("删除会话异常: {}", e))?
}

#[tauri::command]
pub async fn list_history() -> Result<Vec<HistoryTaskDto>, String> {
    // 启动回灌一次读上千行，阻塞线程池执行避免卡 UI。
    tokio::task::spawn_blocking(storage::query_all)
        .await
        .map_err(|e| format!("查询历史异常: {}", e))?
}

#[tauri::command]
pub async fn list_history_page(limit: i64, offset: i64) -> Result<Vec<HistoryTaskDto>, String> {
    // 审计#12：图库渐进加载的分页查询，单次 payload 有界。
    tokio::task::spawn_blocking(move || storage::query_page(limit, offset))
        .await
        .map_err(|e| format!("查询历史异常: {}", e))?
}

#[tauri::command]
pub async fn set_star(id: i64, starred: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || storage::set_starred(id, starred))
        .await
        .map_err(|e| format!("收藏操作异常: {}", e))?
}

#[tauri::command]
pub async fn delete_histories(ids: Vec<i64>) -> Result<(), String> {
    // 文件删除（大视频可达数百 MB）丢阻塞线程池，避免卡住主线程/UI。
    // 审计#12：批量删除走单连接单事务（原先逐条独立连接 + 逐条 fsync）。
    tokio::task::spawn_blocking(move || storage::delete_tasks(&ids))
        .await
        .map_err(|e| format!("删除任务异常: {}", e))?
}

/// 读取图层拆分元数据 sidecar（layers/{history_id}.json）；非图层任务/旧记录返回 None。
#[tauri::command]
pub async fn get_layer_meta(history_id: i64) -> Result<Option<Vec<LayerMetaDto>>, String> {
    tokio::task::spawn_blocking(move || storage::read_layer_meta(history_id))
        .await
        .map_err(|e| format!("读取图层元数据异常: {}", e))?
}

/// 图层画布上下文：本地产物路径 + sidecar 元数据；非图层任务返回 None。
#[tauri::command]
pub async fn get_layer_composition(history_id: i64) -> Result<Option<LayerCompositionDto>, String> {
    tokio::task::spawn_blocking(move || storage::layer_composition(history_id))
        .await
        .map_err(|e| format!("读取图层合成上下文异常: {}", e))?
}

/// 按画布当前顺序与显隐状态合成图层 PNG（CPU 密集，走阻塞线程池），返回产物绝对路径。
#[tauri::command]
pub async fn export_layer_composition(
    history_id: i64,
    order: Vec<usize>,
    visible: Vec<bool>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || storage::compose_layer_image(history_id, &order, &visible))
        .await
        .map_err(|e| format!("合成图层异常: {}", e))?
}

/// 补全历史任务缺失的缩略图（旧数据仅第一张有）。
/// CPU 密集（图像解码+编码），丢到阻塞线程池避免卡住主线程。
#[tauri::command]
pub async fn ensure_thumbnails() -> Result<usize, String> {
    tokio::task::spawn_blocking(storage::ensure_thumbnails)
        .await
        .map_err(|e| format!("缩略图任务异常: {}", e))?
}

// —— 用户自添加模型（内置厂商）——

#[tauri::command]
pub async fn list_user_models() -> Result<Vec<UserModelRow>, String> {
    tokio::task::spawn_blocking(storage::list_user_models)
        .await
        .map_err(|e| format!("查询自添加模型异常: {}", e))?
}

#[tauri::command]
pub async fn save_user_model(
    provider_id: String,
    model_id: String,
    name: String,
    template_model_id: String,
    params_json: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        storage::save_user_model(
            &provider_id,
            &model_id,
            &name,
            &template_model_id,
            params_json.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("保存自添加模型异常: {}", e))?
}

#[tauri::command]
pub async fn delete_user_model(id: i64) -> Result<(), String> {
    tokio::task::spawn_blocking(move || storage::delete_user_model(id))
        .await
        .map_err(|e| format!("删除自添加模型异常: {}", e))?
}
