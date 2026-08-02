//! Tauri 命令桥接层：把 Rust 能力暴露给前端 invoke。
//! 生成流程：取 key → submit → （异步轮询）→ 下载落盘 → 写历史 → 返回结果，全程 emit 进度事件。

use tauri::{AppHandle, Emitter, State};

use crate::models::{
    CustomProviderRow, GenRequest, GenerationResultDto, HistoryTaskDto, ProgressPayload,
    ProviderInfoDto, TaskPhase,
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

    // 参考图归一化：上传的 data URL / 公网 URL 原样透传；
    // 图库/结果跳转带来的本地路径或 asset:// URL 先转 base64 data URL，
    // 厂商服务器才能拉取（厂商拿不到本机文件）。
    let mut req2 = req.clone();
    req2.references = req
        .references
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
    let remote_urls: Vec<String> = if handle.phase == TaskPhase::Succeeded {
        handle.remote_urls.clone()
    } else {
        // 视频轮询间隔 5s，图像 3s；此处统一按 capability 区分。
        let is_video = req.capability == "t2v" || req.capability == "i2v";
        let interval = if is_video { 5u64 } else { 3u64 };
        let mut last_progress = 15i32;
        let urls: Vec<String>;
        loop {
            let snap = provider.poll(&handle, &api_key).await?;
            match snap.phase {
                TaskPhase::Succeeded => {
                    urls = snap.remote_urls;
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
        urls
    };

    let _ = app.emit(
        "gen-progress",
        ProgressPayload {
            task_id: req.task_id.clone(),
            phase: "downloading".to_string(),
            progress: 95,
            message: "正在下载生成结果...".to_string(),
        },
    );

    let mut local_paths = Vec::new();
    for url in &remote_urls {
        let p = storage::save_remote(client.inner(), url, &provider_id)
            .await
            .map_err(|e| format!("下载失败: {}", e))?;
        local_paths.push(p);
    }

    let model = req
        .model
        .clone()
        .unwrap_or_else(|| provider.default_model().to_string());
    let params_obj = serde_json::json!({
        "size": req.size,
        "n": req.n,
        "aspect_ratio": req.aspect_ratio,
        "quality": req.quality,
        "duration": req.duration,
        "references": req.references.len(),
    });

    // 图库缩略图：仅图像产物生成（视频无首帧能力，前端用占位卡）。
    // 原图文件保持下载原样，不做任何重编码。
    let thumbnail_path = local_paths
        .first()
        .filter(|p| storage::is_image_path(p))
        .and_then(|p| storage::make_thumbnail(p).ok());

    let local_json = serde_json::to_string(&local_paths).unwrap_or_else(|_| "[]".to_string());
    let remote_json = serde_json::to_string(&remote_urls).ok();

    storage::insert_task(storage::HistoryInsert {
        provider: provider_id.clone(),
        model: model.clone(),
        capability: req.capability.clone(),
        prompt: req.prompt.clone(),
        params_json: Some(params_obj.to_string()),
        status: "succeeded".to_string(),
        local_paths_json: local_json,
        remote_urls_json: remote_json,
        thumbnail_path,
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
        provider_id,
        model,
        local_paths,
        remote_urls,
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

// —— 自定义厂商（JSON 配置存储）——

#[tauri::command]
pub fn list_custom_providers() -> Result<Vec<CustomProviderRow>, String> {
    storage::list_custom_providers()
}

#[tauri::command]
pub fn save_custom_provider(id: String, config_json: String) -> Result<(), String> {
    storage::save_custom_provider(&id, &config_json)
}

#[tauri::command]
pub fn delete_custom_provider(id: String) -> Result<(), String> {
    storage::delete_custom_provider(&id)
}
