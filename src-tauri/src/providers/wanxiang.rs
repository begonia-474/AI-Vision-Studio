use async_trait::async_trait;
use serde_json::json;

use crate::models::{GenRequest, ProviderInfoDto, TaskHandle, TaskPhase, TaskSnapshot};
use crate::providers::GenerationProvider;

/// 通义万相 适配器。
/// baseUrl: https://dashscope.aliyuncs.com （WorkspaceId 专属域名留待后续）
/// 鉴权: Authorization: Bearer sk-xxxx（DashScope API Key）
/// 图像 wan2.6（同步）: POST /api/v1/services/aigc/multimodal-generation/generation
///   —— 不加 X-DashScope-Async；响应 output.choices[].message.content[].image
/// 视频 wan2.7（异步）: POST /api/v1/services/aigc/video-generation/video-synthesis
///   —— 必加 X-DashScope-Async: enable，否则报 "does not support synchronous calls"
///   —— 响应 output.task_id；轮询 GET /api/v1/tasks/{id} → output.task_status + output.video_url
const BASE_URL: &str = "https://dashscope.aliyuncs.com";
const DEFAULT_IMAGE_MODEL: &str = "wan2.6-t2i";
const DEFAULT_VIDEO_MODEL: &str = "wan2.7-t2v";
pub const PROVIDER_ID: &str = "wanxiang";

pub struct WanxiangProvider {
    client: reqwest::Client,
}

impl WanxiangProvider {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }

    pub fn info() -> ProviderInfoDto {
        ProviderInfoDto {
            id: PROVIDER_ID.to_string(),
            display_name: "通义万相（DashScope）".to_string(),
            capabilities: vec![
                "text_to_image".to_string(),
                "image_to_image".to_string(),
                "text_to_video".to_string(),
                "image_to_video".to_string(),
            ],
            auth_help: "DashScope Bearer Key + 可选 WorkspaceId。".to_string(),
        }
    }
}

/// wan2.6 图像 size 映射：比例 → 通义像素串（`*` 分隔）。1K 档为主，2K 由 quality 提升。
fn wan_image_size(ar: &str) -> &'static str {
    match ar {
        "1:1" => "1024*1024",
        "3:4" => "960*1280",
        "4:3" => "1280*960",
        "9:16" => "1080*1920",
        "16:9" => "1920*1080",
        _ => "1024*1024",
    }
}

#[async_trait]
impl GenerationProvider for WanxiangProvider {
    fn default_model(&self) -> &str {
        DEFAULT_IMAGE_MODEL
    }

    async fn submit(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        match req.capability.as_str() {
            "t2i" | "i2i" => self.submit_image(req, api_key).await,
            "t2v" | "i2v" => self.submit_video(req, api_key).await,
            other => Err(format!("通义万相不支持能力: {}", other)),
        }
    }

    async fn poll(&self, handle: &TaskHandle, api_key: &str) -> Result<TaskSnapshot, String> {
        // 同步图像：submit 已置终态。
        if handle.phase == TaskPhase::Succeeded || handle.phase == TaskPhase::Failed {
            return Ok(TaskSnapshot {
                phase: handle.phase,
                progress: 100,
                message: None,
                remote_urls: vec![],
            });
        }
        // 异步视频：GET /api/v1/tasks/{id}
        let resp = self
            .client
            .get(format!("{}/api/v1/tasks/{}", BASE_URL, handle.task_id))
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| format!("轮询失败: {}", e))?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Ok(TaskSnapshot {
                phase: TaskPhase::Failed,
                progress: 100,
                message: Some(format!("HTTP {}: {}", status, body)),
                remote_urls: vec![],
            });
        }
        let v: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;
        // DashScope 错误体: { code: "...", message: "..." }
        if let Some(code) = v.get("code").and_then(|c| c.as_str()) {
            if !code.is_empty() && code != "0" {
                return Ok(TaskSnapshot {
                    phase: TaskPhase::Failed,
                    progress: 100,
                    message: Some(
                        v.get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or(code)
                            .to_string(),
                    ),
                    remote_urls: vec![],
                });
            }
        }
        let output = v.get("output").cloned().unwrap_or(serde_json::Value::Null);
        let task_status = output
            .get("task_status")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_uppercase();
        match task_status.as_str() {
            "SUCCEEDED" => {
                let url = output
                    .get("video_url")
                    .and_then(|u| u.as_str())
                    .unwrap_or("")
                    .to_string();
                if url.is_empty() {
                    return Ok(TaskSnapshot {
                        phase: TaskPhase::Failed,
                        progress: 100,
                        message: Some("SUCCEEDED 但缺 video_url".to_string()),
                        remote_urls: vec![],
                    });
                }
                Ok(TaskSnapshot {
                    phase: TaskPhase::Succeeded,
                    progress: 100,
                    message: None,
                    remote_urls: vec![url],
                })
            }
            "FAILED" => Ok(TaskSnapshot {
                phase: TaskPhase::Failed,
                progress: 100,
                message: Some(
                    output
                        .get("task_metrics")
                        .and_then(|m| m.as_str())
                        .unwrap_or("生成失败")
                        .to_string(),
                ),
                remote_urls: vec![],
            }),
            _ => {
                let progress = output
                    .get("task_metrics")
                    .and_then(|m| m.get("TOTAL"))
                    .and_then(|t| t.as_i64())
                    .map(|p| p as i32)
                    .unwrap_or(50);
                Ok(TaskSnapshot {
                    phase: TaskPhase::Running,
                    progress,
                    message: Some(task_status),
                    remote_urls: vec![],
                })
            }
        }
    }

    async fn test_connectivity(&self, api_key: &str) -> Result<String, String> {
        // 廉价鉴权校验：查询不存在任务，401→Key 无效，其余→Key 有效。
        let resp = self
            .client
            .get(format!("{}/api/v1/tasks/0", BASE_URL))
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let code = resp.status().as_u16();
        if code == 401 || code == 403 {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("API Key 无效: {}", body));
        }
        Ok("API Key 有效（已通过鉴权层）。".to_string())
    }
}

impl WanxiangProvider {
    async fn submit_image(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        let model = req
            .model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_IMAGE_MODEL.to_string());
        let ar = req.aspect_ratio.as_deref().unwrap_or("1:1");
        let size = wan_image_size(ar);

        // messages 结构：[{ role:user, content:[{text}, {image?}] }]
        let mut content = vec![json!({ "text": req.prompt })];
        if req.capability == "i2i" {
            for r in &req.references {
                content.push(json!({ "image": r }));
            }
        }
        let payload = json!({
            "model": model,
            "input": { "messages": [ { "role": "user", "content": content } ] },
            "parameters": { "size": size, "n": req.n, "prompt_extend": true, "watermark": false }
        });

        let resp = self
            .client
            .post(format!(
                "{}/api/v1/services/aigc/multimodal-generation/generation",
                BASE_URL
            ))
            .bearer_auth(api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Ok(TaskHandle {
                provider_id: PROVIDER_ID.to_string(),
                task_id: String::new(),
                phase: TaskPhase::Failed,
                remote_urls: vec![],
                error: Some(format!("HTTP {}: {}", status, body)),
            });
        }
        let v: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;
        // 错误体 { code, message }
        if let Some(code) = v.get("code").and_then(|c| c.as_str()) {
            if !code.is_empty() && code != "0" {
                let msg = v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or(code)
                    .to_string();
                return Ok(TaskHandle {
                    provider_id: PROVIDER_ID.to_string(),
                    task_id: String::new(),
                    phase: TaskPhase::Failed,
                    remote_urls: vec![],
                    error: Some(msg),
                });
            }
        }
        // 提取 output.choices[].message.content[].image
        let mut urls = Vec::new();
        if let Some(choices) = v.get("output").and_then(|o| o.get("choices")).and_then(|c| c.as_array())
        {
            for ch in choices {
                if let Some(arr) = ch
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for item in arr {
                        if let Some(img) = item.get("image").and_then(|i| i.as_str()) {
                            urls.push(img.to_string());
                        }
                    }
                }
            }
        }
        if urls.is_empty() {
            return Ok(TaskHandle {
                provider_id: PROVIDER_ID.to_string(),
                task_id: String::new(),
                phase: TaskPhase::Failed,
                remote_urls: vec![],
                error: Some(format!("响应未包含图片 URL: {}", body)),
            });
        }
        Ok(TaskHandle {
            provider_id: PROVIDER_ID.to_string(),
            task_id: String::new(),
            phase: TaskPhase::Succeeded,
            remote_urls: urls,
            error: None,
        })
    }

    async fn submit_video(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        let model = req
            .model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_VIDEO_MODEL.to_string());
        let resolution = req.quality.clone().unwrap_or_else(|| "1080P".to_string());
        let duration: i64 = req
            .duration
            .as_deref()
            .and_then(|d| d.parse().ok())
            .unwrap_or(5);

        // media 结构：i2v 追加 first_frame
        let mut media = Vec::new();
        if req.capability == "i2v" {
            if let Some(first) = req.references.first() {
                media.push(json!({ "type": "first_frame", "url": first }));
            }
        }
        let mut input = json!({ "prompt": req.prompt });
        if !media.is_empty() {
            input["media"] = json!(media);
        }
        let payload = json!({
            "model": model,
            "input": input,
            "parameters": { "resolution": resolution, "duration": duration, "prompt_extend": true }
        });

        let resp = self
            .client
            .post(format!(
                "{}/api/v1/services/aigc/video-generation/video-synthesis",
                BASE_URL
            ))
            .header("X-DashScope-Async", "enable") // 异步必加，否则报同步不支持
            .bearer_auth(api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Ok(TaskHandle {
                provider_id: PROVIDER_ID.to_string(),
                task_id: String::new(),
                phase: TaskPhase::Failed,
                remote_urls: vec![],
                error: Some(format!("HTTP {}: {}", status, body)),
            });
        }
        let v: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;
        if let Some(code) = v.get("code").and_then(|c| c.as_str()) {
            if !code.is_empty() && code != "0" {
                let msg = v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or(code)
                    .to_string();
                return Ok(TaskHandle {
                    provider_id: PROVIDER_ID.to_string(),
                    task_id: String::new(),
                    phase: TaskPhase::Failed,
                    remote_urls: vec![],
                    error: Some(msg),
                });
            }
        }
        let task_id = v
            .get("output")
            .and_then(|o| o.get("task_id"))
            .and_then(|t| t.as_str())
            .ok_or_else(|| format!("响应缺 task_id: {}", body))?
            .to_string();
        Ok(TaskHandle {
            provider_id: PROVIDER_ID.to_string(),
            task_id,
            phase: TaskPhase::Submitted,
            remote_urls: vec![],
            error: None,
        })
    }
}
