use async_trait::async_trait;
use serde_json::json;

use crate::models::{GenRequest, ProviderInfoDto, TaskHandle, TaskPhase, TaskSnapshot};
use crate::providers::GenerationProvider;

/// MiniMax 海螺 适配器。
/// 端点 baseUrl: https://api.minimaxi.com（国内）
/// 鉴权: Authorization: Bearer $MINIMAX_API_KEY
/// 图像(t2i/i2i): 同步 POST /v1/image_generation → data.image_urls[]
/// 视频(t2v/i2v): 异步 POST /v1/video_generation → task_id
///                poll GET /v1/query/video_generation?task_id= → status + file_id
///                Success 时再 GET /v1/files/retrieve?file_id= → file.download_url（约 9h 有效）
/// 三段式 fetch 折叠进 poll：状态变 Success 时由 poll 内部完成 file 二次拉取并填 remote_urls。
const BASE_URL: &str = "https://api.minimaxi.com";
const DEFAULT_IMAGE_MODEL: &str = "image-01";
const DEFAULT_VIDEO_MODEL: &str = "video-01";
pub const PROVIDER_ID: &str = "minimax";

pub struct MiniMaxProvider {
    client: reqwest::Client,
}

impl MiniMaxProvider {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }

    pub fn info() -> ProviderInfoDto {
        ProviderInfoDto {
            id: PROVIDER_ID.to_string(),
            display_name: "MiniMax 海螺".to_string(),
            capabilities: vec![
                "text_to_image".to_string(),
                "image_to_image".to_string(),
                "text_to_video".to_string(),
                "image_to_video".to_string(),
            ],
            auth_help: "Bearer API Key。Hailuo 视频 / image-01 图像。".to_string(),
        }
    }
}

#[async_trait]
impl GenerationProvider for MiniMaxProvider {
    fn default_model(&self) -> &str {
        DEFAULT_IMAGE_MODEL
    }

    async fn submit(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        let cap = req.capability.as_str();
        match cap {
            "t2i" | "i2i" => self.submit_image(req, api_key).await,
            "t2v" | "i2v" => self.submit_video(req, api_key).await,
            _ => Err(format!("MiniMax 不支持能力: {}", cap)),
        }
    }

    async fn poll(&self, handle: &TaskHandle, api_key: &str) -> Result<TaskSnapshot, String> {
        // 同步图像：submit 已置终态，立即返回。
        if handle.phase == TaskPhase::Succeeded || handle.phase == TaskPhase::Failed {
            return Ok(TaskSnapshot {
                phase: handle.phase,
                progress: 100,
                message: None,
                remote_urls: vec![],
            });
        }
        // 异步视频：轮询任务状态。
        let resp = self
            .client
            .get(format!(
                "{}/v1/query/video_generation?task_id={}",
                BASE_URL, handle.task_id
            ))
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
        // MiniMax 错误体: { base_resp: { status_code, status_msg } }
        if let Some(msg) = v
            .get("base_resp")
            .and_then(|b| b.get("status_msg"))
            .and_then(|s| s.as_str())
        {
            let code = v
                .get("base_resp")
                .and_then(|b| b.get("status_code"))
                .and_then(|c| c.as_i64())
                .unwrap_or(0);
            if code != 0 {
                return Ok(TaskSnapshot {
                    phase: TaskPhase::Failed,
                    progress: 100,
                    message: Some(msg.to_string()),
                    remote_urls: vec![],
                });
            }
        }
        let task_status = v
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_lowercase();
        match task_status.as_str() {
            "success" => {
                // 二次拉取：file_id → files/retrieve → download_url
                let file_id = v
                    .get("file_id")
                    .and_then(|f| f.as_str())
                    .ok_or_else(|| "Success 但缺 file_id".to_string())?;
                let url = self.fetch_file(file_id, api_key).await?;
                Ok(TaskSnapshot {
                    phase: TaskPhase::Succeeded,
                    progress: 100,
                    message: None,
                    remote_urls: vec![url],
                })
            }
            "failed" => Ok(TaskSnapshot {
                phase: TaskPhase::Failed,
                progress: 100,
                message: Some(v.get("task_err").and_then(|e| e.as_str()).unwrap_or("生成失败").to_string()),
                remote_urls: vec![],
            }),
            _ => Ok(TaskSnapshot {
                phase: TaskPhase::Running,
                progress: 50,
                message: Some(task_status),
                remote_urls: vec![],
            }),
        }
    }

    async fn test_connectivity(&self, api_key: &str) -> Result<String, String> {
        // 廉价鉴权校验：查询一个不存在任务，401→Key 无效，其余→Key 有效。不产生生成消耗。
        let resp = self
            .client
            .get(format!("{}/v1/query/video_generation?task_id=0", BASE_URL))
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let code = resp.status().as_u16();
        // 401/403 → 鉴权失败；其余（含 400/404）说明 Key 通过了鉴权层
        if code == 401 || code == 403 {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("API Key 无效: {}", body));
        }
        Ok("API Key 有效（已通过鉴权层）。".to_string())
    }
}

impl MiniMaxProvider {
    async fn submit_image(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        let model = req
            .model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_IMAGE_MODEL.to_string());
        let ar = req.aspect_ratio.clone().unwrap_or_else(|| "1:1".to_string());

        let mut payload = json!({
            "model": model,
            "prompt": req.prompt,
            "aspect_ratio": ar,
            "n": req.n,
            "prompt_optimizer": true,
        });
        // i2i：subject_reference（character 角色参考）
        if req.capability == "i2i" && !req.references.is_empty() {
            payload["subject_reference"] = json!(
                req.references
                    .iter()
                    .map(|r| json!({ "type": "character", "image_file": r }))
                    .collect::<Vec<_>>()
            );
        }

        let resp = self
            .client
            .post(format!("{}/v1/image_generation", BASE_URL))
            .bearer_auth(api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;
        let (urls, err) = self.parse_image_response(resp).await?;
        match urls {
            Some(u) if !u.is_empty() => Ok(TaskHandle {
                provider_id: PROVIDER_ID.to_string(),
                task_id: String::new(),
                phase: TaskPhase::Succeeded,
                remote_urls: u,
                error: None,
            }),
            _ => Ok(TaskHandle {
                provider_id: PROVIDER_ID.to_string(),
                task_id: String::new(),
                phase: TaskPhase::Failed,
                remote_urls: vec![],
                error: Some(err.unwrap_or_else(|| "响应未包含图片 URL".to_string())),
            }),
        }
    }

    async fn parse_image_response(
        &self,
        resp: reqwest::Response,
    ) -> Result<(Option<Vec<String>>, Option<String>), String> {
        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Ok((None, Some(format!("HTTP {}: {}", status, body))));
        }
        let v: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;
        if let Some(code) = v
            .get("base_resp")
            .and_then(|b| b.get("status_code"))
            .and_then(|c| c.as_i64())
        {
            if code != 0 {
                let msg = v
                    .get("base_resp")
                    .and_then(|b| b.get("status_msg"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("生成失败");
                return Ok((None, Some(msg.to_string())));
            }
        }
        let urls = v
            .get("data")
            .and_then(|d| d.get("image_urls"))
            .and_then(|u| u.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .or_else(|| {
                v.get("images")
                    .and_then(|u| u.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect::<Vec<_>>()
                    })
            });
        Ok((urls, None))
    }

    async fn submit_video(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        let model = req
            .model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_VIDEO_MODEL.to_string());
        let duration: i64 = req
            .duration
            .as_deref()
            .and_then(|d| d.parse().ok())
            .unwrap_or(6);
        let resolution = req.quality.clone().unwrap_or_else(|| "1080P".to_string());

        let mut payload = json!({
            "model": model,
            "prompt": req.prompt,
            "duration": duration,
            "resolution": resolution,
            "prompt_optimizer": true,
            "aigc_watermark": false,
        });
        // i2v：first_frame_image
        if req.capability == "i2v" {
            if let Some(first) = req.references.first() {
                payload["first_frame_image"] = json!(first);
            }
        }

        let resp = self
            .client
            .post(format!("{}/v1/video_generation", BASE_URL))
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
        if let Some(code) = v
            .get("base_resp")
            .and_then(|b| b.get("status_code"))
            .and_then(|c| c.as_i64())
        {
            if code != 0 {
                let msg = v
                    .get("base_resp")
                    .and_then(|b| b.get("status_msg"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("提交失败");
                return Ok(TaskHandle {
                    provider_id: PROVIDER_ID.to_string(),
                    task_id: String::new(),
                    phase: TaskPhase::Failed,
                    remote_urls: vec![],
                    error: Some(msg.to_string()),
                });
            }
        }
        let task_id = v
            .get("task_id")
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

    /// file_id → GET /v1/files/retrieve → file.download_url
    async fn fetch_file(&self, file_id: &str, api_key: &str) -> Result<String, String> {
        let resp = self
            .client
            .get(format!("{}/v1/files/retrieve?file_id={}", BASE_URL, file_id))
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| format!("拉取文件失败: {}", e))?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, body));
        }
        let v: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;
        v.get("file")
            .and_then(|f| f.get("download_url"))
            .and_then(|u| u.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("文件响应缺 download_url: {}", body))
    }
}
