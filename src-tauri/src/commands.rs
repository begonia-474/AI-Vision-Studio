//! Tauri 命令桥接层：把 Rust 能力暴露给前端 invoke。
//! 生成流程：取 key → submit → （异步轮询）→ 下载落盘 → 写历史 → 返回结果，全程 emit 进度事件。

use tauri::{AppHandle, Emitter, State};

use crate::models::{
    GenRequest, GenerationResultDto, HistoryTaskDto, HttpRecord,
    ProgressPayload, ProviderInfoDto, TaskPhase, UserModelRow,
};
use crate::providers::{all_providers, get_provider};
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
    storage::get_key(&provider_id)
}

#[tauri::command]
pub fn delete_api_key(provider_id: String) -> Result<(), String> {
    storage::delete_key(&provider_id)
}

// WorkspaceId：业务空间专属域名（https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com）
#[tauri::command]
pub fn save_workspace_id(provider_id: String, workspace_id: String) -> Result<(), String> {
    storage::save_workspace(&provider_id, &workspace_id)
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
    let api_key = storage::get_key(&provider_id)?.ok_or("未设置 API Key")?;
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
    let api_key = storage::get_key(&provider_id)?
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
    let collected_refs = req
        .references
        .iter()
        .map(|r| storage::save_reference(r))
        .collect::<Result<Vec<_>, _>>()?;
    req2.references = collected_refs
        .iter()
        .map(|r| storage::normalize_reference(r))
        .collect::<Result<Vec<_>, _>>()?;

    let handle = provider.submit(&req2, &api_key).await?;
    if handle.phase == TaskPhase::Failed {
        let err = handle.error.unwrap_or_else(|| "生成失败".to_string());
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
        let mut last_progress = 15i32;
        loop {
            let snap = provider.poll(&handle, &api_key).await?;
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
        let p = storage::save_remote(client.inner(), url, &provider_id)
            .await
            .map_err(|e| format!("下载失败: {}", e))?;
        local_paths.push(p);
    }
    eprintln!(
        "[gen] task={} local_paths({}) = {:?}",
        req.task_id,
        local_paths.len(),
        local_paths,
    );

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
        "output_format": req.output_format,
        // 收编后的参考图路径/URL 数组（本地文件已复制进 inputs 目录，生命周期由应用管理）
        "references": collected_refs,
    });
    // 魔搭自由参数快照（steps/guidance/seed/negative_prompt/loras 等）原样并入
    // params_json：详情页/图库按 params_json 消费完整参数，重新编辑时回填弹层。
    // （前端 extra.params 只含自定义/魔搭模型声明的参数，不会与上方结构化字段冲突。）
    if let Some(map) = req
        .extra
        .as_ref()
        .and_then(|e| e.get("params"))
        .and_then(|p| p.as_object())
    {
        for (k, v) in map {
            params_obj[k] = v.clone();
        }
    }

    // 图库缩略图：仅图像产物生成（视频无首帧能力，前端用占位卡）。
    // 每张图都生成 256px webp 缩略图（{stem}.thumb.webp 命名约定，网格按此渲染），
    // 避免网格直接解码全尺寸原图导致图库量大时卡顿；
    // thumbnail_path 字段存第一张（详情/兼容旧逻辑用）。
    // 原图文件保持下载原样，不做任何重编码。
    let thumbnail_path = local_paths
        .first()
        .filter(|p| storage::is_image_path(p))
        .and_then(|p| storage::make_thumbnail(p).ok());
    for p in local_paths.iter().skip(1) {
        if storage::is_image_path(p) {
            let _ = storage::make_thumbnail(p);
        }
    }

    let local_json = serde_json::to_string(&local_paths).unwrap_or_else(|_| "[]".to_string());
    let remote_json = serde_json::to_string(&remote_urls).ok();

    // HTTP 调试记录：请求数组与响应数组按下标一一对应（一次任务可能含多次提交/轮询交换）。
    let http_req_json = serde_json::to_string(
        &http_log
            .iter()
            .map(|r| {
                serde_json::json!({
                    "method": r.method,
                    "url": r.url,
                    "body": r.request_body,
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

    let history_id = storage::insert_task(storage::HistoryInsert {
        provider: provider_id.clone(),
        model: model.clone(),
        capability: req.capability.clone(),
        prompt: req.prompt.clone(),
        params_json: Some(params_obj.to_string()),
        status: "succeeded".to_string(),
        local_paths_json: local_json,
        remote_urls_json: remote_json,
        thumbnail_path,
        request_json: http_req_json,
        raw_response: http_resp_json,
        error: None,
        session_id: req.session_id.clone(),
    })?;

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

#[tauri::command]
pub fn list_history() -> Result<Vec<HistoryTaskDto>, String> {
    storage::query_all()
}

#[tauri::command]
pub fn set_star(id: i64, starred: bool) -> Result<(), String> {
    storage::set_starred(id, starred)
}

#[tauri::command]
pub fn delete_histories(ids: Vec<i64>) -> Result<(), String> {
    for id in ids {
        storage::delete_task(id)?;
    }
    Ok(())
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

