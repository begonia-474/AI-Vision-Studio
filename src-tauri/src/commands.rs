//! Tauri 命令桥接层：把 Rust 能力暴露给前端 invoke。
//! 生成流程：取 key → submit → （异步轮询）→ 下载落盘 → 写历史 → 返回结果，全程 emit 进度事件。

use tauri::{AppHandle, Emitter, State};

use crate::models::{
    GenRequest, GenerationResultDto, HistoryTaskDto, HttpRecord,
    ProgressPayload, ProviderInfoDto, SessionRow, TaskPhase, UserModelRow,
};
use crate::providers::{all_providers, get_provider, sanitize_body};
use crate::storage;

#[tauri::command]
pub fn list_providers() -> Vec<ProviderInfoDto> {
    all_providers()
}

#[tauri::command]
pub fn save_api_key(provider_id: String, api_key: String) -> Result<(), String> {
    storage::save_key(&provider_id, &api_key)
}

#[tauri::command]
pub fn get_api_key(provider_id: String) -> Result<Option<String>, String> {
    // 只回显掩码（存在性 + 首尾 4 位），完整密钥不出后端——前端仅需判断"是否已设置"。
    Ok(storage::get_key(&provider_id)?.map(|k| mask_key(&k)))
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
pub fn delete_api_key(provider_id: String) -> Result<(), String> {
    storage::delete_key(&provider_id)
}

// WorkspaceId：业务空间专属域名（https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com）
#[tauri::command]
pub fn save_workspace_id(provider_id: String, workspace_id: String) -> Result<(), String> {
    let ws = workspace_id.trim();
    // 防误输入污染域名：仅允许字母/数字/连字符（https://{ws}.cn-beijing.maas.aliyuncs.com）
    if !ws.is_empty() && !ws.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("WorkspaceId 只能包含字母、数字与连字符".to_string());
    }
    storage::save_workspace(&provider_id, ws)
}

#[tauri::command]
pub fn get_workspace_id(provider_id: String) -> Result<Option<String>, String> {
    storage::get_workspace(&provider_id)
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
    let provider = get_provider(&provider_id, client.inner().clone())
        .ok_or("未知的 provider")?;
    provider.test_connectivity(&api_key).await
}

#[tauri::command]
pub async fn generate(
    app: AppHandle,
    req: GenRequest,
    client: State<'_, reqwest::Client>,
) -> Result<GenerationResultDto, String> {
    let provider_id = req.provider_id.clone();
    let provider = get_provider(&provider_id, client.inner().clone())
        .ok_or("未知的 provider")?;
    // keyring 读凭据是同步 IO，丢阻塞线程池避免占 tokio 工作线程。
    let pid_key = provider_id.clone();
    let api_key = tokio::task::spawn_blocking(move || storage::get_key(&pid_key))
        .await
        .map_err(|e| format!("读取密钥异常: {}", e))??
        .ok_or("未设置 API Key，请先在设置页填入")?;

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
    let mut req2 = req.clone();
    // 参考图收编/归一化是同步文件 IO，丢阻塞线程池避免占 tokio 工作线程。
    let req_refs = req.references.clone();
    let collected_refs = tokio::task::spawn_blocking(move || {
        req_refs
            .iter()
            .map(|r| storage::save_reference(r))
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|e| format!("参考图处理异常: {}", e))??;
    let norm_refs = collected_refs.clone();
    req2.references = tokio::task::spawn_blocking(move || {
        norm_refs
            .iter()
            .map(|r| storage::normalize_reference(r))
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|e| format!("参考图处理异常: {}", e))??;

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
        // 收编后的参考图路径/URL 数组（本地文件已复制进 inputs 目录，生命周期由应用管理）
        "references": collected_refs,
    });
    // 魔搭自由参数快照（steps/guidance/seed/negative_prompt/loras 等）原样并入
    // params_json：详情页/图库按 params_json 消费完整参数，重新编辑时回填弹层。
    // 结构化字段（size/n/aspect_ratio/quality/duration/mode/output_format/references）
    // 以顶部 json! 为准——用户自建模型声明同名 key 时跳过，防止污染快照。
    const STRUCTURED_PARAM_KEYS: &[&str] = &[
        "size",
        "n",
        "aspect_ratio",
        "quality",
        "duration",
        "mode",
        "output_format",
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
            cleanup_files(&collected_refs);
            let _ = storage::update_task_result(history_id, "failed", "[]", None, None, None, None, None, Some(&e));
            return Err(e);
        }
    };
    if handle.phase == TaskPhase::Failed {
        let err = handle.error.unwrap_or_else(|| "生成失败".to_string());
        let _ = storage::update_task_result(history_id, "failed", "[]", None, None, None, None, None, Some(&err));
        let _ = app.emit(
            "gen-progress",
            ProgressPayload {
                task_id: req.task_id.clone(),
                phase: "failed".to_string(),
                progress: 100,
                message: err.clone(),
            },
        );
        return Err(err);
    }

    // 同步厂商：submit 已置 Succeeded，remote_urls 在 handle 内。
    // 异步厂商：submit 返回 Submitted + task_id，需轮询至终态，结果 URL 在 snapshot.remote_urls。
    let remote_urls: Vec<String>;
    let mut http_log = handle.http_log.clone();
    let mut poll_log: Vec<HttpRecord> = Vec::new();
    if handle.phase == TaskPhase::Succeeded {
        remote_urls = handle.remote_urls.clone();
    } else {
        // 视频轮询间隔 5s，图像 3s；此处统一按 capability 区分。
        let is_video = req.capability == "t2v" || req.capability == "i2v";
        let interval = if is_video { 5u64 } else { 3u64 };
        // 轮询总时长上限：厂商任务卡死/丢失时不能无限轮询（图像 20 分钟，视频 60 分钟）。
        // 注：超时后服务端任务可能仍在生成并计费——错误文案提示用户稍后可到图库核对。
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(if is_video { 60 * 60 } else { 20 * 60 });
        let mut last_progress = 15i32;
        loop {
            if std::time::Instant::now() >= deadline {
                cleanup_files(&collected_refs);
                let err = "任务超时（生成超过时限），请稍后到图库查看是否已生成".to_string();
                let _ = storage::update_task_result(history_id, "failed", "[]", None, None, None, None, None, Some(&err));
                return Err(err);
            }
            // 轮询失败重试：状态查询是幂等的 GET，网络抖动/厂商瞬断重试不产生额外费用；
            // 连续 3 次失败才判任务失败（原实现单次抖动即整任务失败，结果永久丢失）。
            let mut snap = None;
            let mut last_err = String::new();
            for attempt in 0..3u64 {
                match provider.poll(&handle, &api_key).await {
                    Ok(s) => {
                        snap = Some(s);
                        break;
                    }
                    Err(e) => {
                        last_err = e;
                        tokio::time::sleep(std::time::Duration::from_millis(1200 * (attempt + 1))).await;
                    }
                }
            }
            let snap = match snap {
                Some(s) => s,
                None => {
                    cleanup_files(&collected_refs);
                    let _ = storage::update_task_result(history_id, "failed", "[]", None, None, None, None, None, Some(&last_err));
                    return Err(last_err);
                }
            };
            // 只保留最后一次轮询的交换记录（提交记录在 handle.http_log 中保留）
            poll_log = snap.http_log.clone();
            match snap.phase {
                TaskPhase::Succeeded => {
                    remote_urls = snap.remote_urls;
                    break;
                }
                TaskPhase::Failed => {
                    let err = snap
                        .message
                        .unwrap_or_else(|| "生成失败".to_string());
                    cleanup_files(&collected_refs);
                    let _ = storage::update_task_result(history_id, "failed", "[]", None, None, None, None, None, Some(&err));
                    let _ = app.emit(
                        "gen-progress",
                        ProgressPayload {
                            task_id: req.task_id.clone(),
                            phase: "failed".to_string(),
                            progress: 100,
                            message: err.clone(),
                        },
                    );
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
                            task_id: req.task_id.clone(),
                            phase: "running".to_string(),
                            progress: last_progress,
                            message: snap
                                .message
                                .unwrap_or_else(|| "生成中...".to_string()),
                        },
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
                }
            }
        }
    };
    // 提交记录 + 终态轮询记录合并（按下标对应）
    http_log.extend(poll_log);

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
    eprintln!(
        "[gen] task={} n={} capability={} remote_urls({}) = {:?}",
        req.task_id,
        req.n,
        req.capability,
        remote_urls.len(),
        remote_urls,
    );

    let mut local_paths = Vec::new();
    for url in &remote_urls {
        // 下载重试：结果 URL 的 GET 幂等，瞬时失败重试不产生额外费用；连续失败才整任务报错。
        let mut last_err = String::new();
        let mut ok = false;
        for attempt in 0..3u64 {
            match storage::save_remote(client.inner(), url, &model).await {
                Ok(p) => {
                    local_paths.push(p);
                    ok = true;
                    break;
                }
                Err(e) => {
                    last_err = e;
                    tokio::time::sleep(std::time::Duration::from_millis(1000 * (attempt + 1))).await;
                }
            }
        }
        if !ok {
            cleanup_files(&local_paths);
            cleanup_files(&collected_refs);
            let err = format!("下载失败: {}", last_err);
            let _ = storage::update_task_result(history_id, "failed", "[]", None, None, None, None, None, Some(&err));
            return Err(err);
        }
    }
    eprintln!(
        "[gen] task={} local_paths({}) = {:?}",
        req.task_id,
        local_paths.len(),
        local_paths,
    );

    // 图库缩略图：仅图像产物生成（视频无首帧能力，前端用占位卡）。
    // 每张图都生成 256px webp 缩略图（{stem}.thumb.webp 命名约定，网格按此渲染），
    // 避免网格直接解码全尺寸原图导致图库量大时卡顿；
    // thumbnail_path 字段存第一张（详情/兼容旧逻辑用）。
    // 原图文件保持下载原样，不做任何重编码。
    // 解码+编码是 CPU 密集，走阻塞线程池（ensure_thumbnails 同款模式）。
    let thumbnail_path = match local_paths.first().filter(|p| storage::is_image_path(p)) {
        Some(p) => make_thumbnail_blocking(p).await,
        None => None,
    };
    for p in local_paths.iter().skip(1).filter(|p| storage::is_image_path(p)) {
        let _ = make_thumbnail_blocking(p).await;
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

/// 失败路径尽力清理本次任务已产生的文件（参考图收编副本 / 已下载产物），
/// 避免 inputs/outputs 在失败任务上累积垃圾（成功路径的 inputs 副本保留供重新生成复用）。
fn cleanup_files(paths: &[String]) {
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
}

/// 生成单张缩略图（图像解码+编码 CPU 密集）：在阻塞线程池执行，避免占 tokio 工作线程。
async fn make_thumbnail_blocking(p: &str) -> Option<String> {
    let p = p.to_string();
    tokio::task::spawn_blocking(move || storage::make_thumbnail(&p))
        .await
        .ok()
        .and_then(|r| r.ok())
}

#[tauri::command]
pub fn list_sessions() -> Result<Vec<SessionRow>, String> {
    storage::list_sessions()
}

#[tauri::command]
pub fn upsert_session(s: SessionRow) -> Result<(), String> {
    storage::upsert_session(&s)
}

#[tauri::command]
pub fn delete_session(id: String) -> Result<(), String> {
    storage::delete_session(&id)
}

#[tauri::command]
pub fn list_history() -> Result<Vec<HistoryTaskDto>, String> {
    storage::query_all()
}

#[tauri::command]
pub fn set_star(id: i64, starred: bool) -> Result<(), String> {
    storage::set_starred(id, starred)
}

#[tauri::command]
pub async fn delete_histories(ids: Vec<i64>) -> Result<(), String> {
    // 文件删除（大视频可达数百 MB）丢阻塞线程池，避免卡住主线程/UI。
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        for id in ids {
            storage::delete_task(id)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("删除任务异常: {}", e))?
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
pub fn list_user_models() -> Result<Vec<UserModelRow>, String> {
    storage::list_user_models()
}

#[tauri::command]
pub fn save_user_model(
    provider_id: String,
    model_id: String,
    name: String,
    template_model_id: String,
    params_json: Option<String>,
) -> Result<(), String> {
    storage::save_user_model(
        &provider_id,
        &model_id,
        &name,
        &template_model_id,
        params_json.as_deref(),
    )
}

#[tauri::command]
pub fn delete_user_model(id: i64) -> Result<(), String> {
    storage::delete_user_model(id)
}

