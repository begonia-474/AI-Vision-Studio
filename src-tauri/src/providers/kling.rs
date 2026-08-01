use async_trait::async_trait;
use serde_json::json;

use crate::models::{GenRequest, ProviderInfoDto, TaskHandle, TaskPhase, TaskSnapshot};
use crate::providers::GenerationProvider;

/// 可灵 Kling 适配器（API Key 模式，新模型推荐；JWT 旧模型暂不支持）。
/// baseUrl: https://api-beijing.klingai.com（国内）
/// 鉴权: Authorization: Bearer $KLING_API_KEY
/// 视频 t2v（异步）: POST /v1/videos/text2video → data.task_id
/// 视频 i2v（异步）: POST /v1/videos/image2video → data.task_id
/// 轮询: GET /v1/videos/{text2video|image2video}/{id} → data.task_status + data.videos[0].url
/// task_status: submit success / processing / succeed / failed
const BASE_URL: &str = "https://api-beijing.klingai.com";
const DEFAULT_MODEL: &str = "kling-v3";
pub const PROVIDER_ID: &str = "kling";

pub struct KlingProvider {
    client: reqwest::Client,
}

impl KlingProvider {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }

    pub fn info() -> ProviderInfoDto {
        ProviderInfoDto {
            id: PROVIDER_ID.to_string(),
            display_name: "可灵 Kling".to_string(),
            capabilities: vec![
                "text_to_video".to_string(),
                "image_to_video".to_string(),
            ],
            auth_help: "推荐 API Key（Bearer）；旧模型兼容 JWT（暂不支持）。".to_string(),
        }
    }

    fn endpoint(&self, capability: &str) -> &str {
        match capability {
            "i2v" => "image2video",
            _ => "text2video",
        }
    }
}

#[async_trait]
impl GenerationProvider for KlingProvider {
    fn default_model(&self) -> &str {
        DEFAULT_MODEL
    }

    async fn submit(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        let cap = req.capability.as_str();
        if !matches!(cap, "t2v" | "i2v") {
            return Err(format!("可灵不支持能力: {}（仅 t2v/i2v）", cap));
        }
        let endpoint = self.endpoint(cap);
        let model = req
            .model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string());
        let ar = req.aspect_ratio.clone().unwrap_or_else(|| "16:9".to_string());
        let duration = req.duration.clone().unwrap_or_else(|| "5".to_string());
        // quality=4K → mode=4k（仅 v3/v3-omni 支持），其余 std
        let mode = if req.quality.as_deref() == Some("4K") {
            "4k"
        } else {
            "std"
        };

        let mut payload = json!({
            "model_name": model,
            "prompt": req.prompt,
            "duration": duration,
            "mode": mode,
            "aspect_ratio": ar,
        });
        if cap == "i2v" {
            if let Some(first) = req.references.first() {
                payload["image"] = json!(first);
            } else {
                return Err("i2v 需要首帧参考图".to_string());
            }
        }

        let resp = self
            .client
            .post(format!("{}/v1/videos/{}", BASE_URL, endpoint))
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
        // 可灵错误体: { code: nonzero, message, data: null }
        let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
        if code != 0 {
            let msg = v
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("提交失败")
                .to_string();
            return Ok(TaskHandle {
                provider_id: PROVIDER_ID.to_string(),
                task_id: String::new(),
                phase: TaskPhase::Failed,
                remote_urls: vec![],
                error: Some(msg),
            });
        }
        let task_id = v
            .get("data")
            .and_then(|d| d.get("task_id"))
            .and_then(|t| t.as_str())
            .ok_or_else(|| format!("响应缺 data.task_id: {}", body))?
            .to_string();
        Ok(TaskHandle {
            provider_id: PROVIDER_ID.to_string(),
            task_id,
            phase: TaskPhase::Submitted,
            remote_urls: vec![],
            error: None,
        })
    }

    async fn poll(&self, handle: &TaskHandle, api_key: &str) -> Result<TaskSnapshot, String> {
        if handle.phase == TaskPhase::Failed {
            return Ok(TaskSnapshot {
                phase: TaskPhase::Failed,
                progress: 100,
                message: None,
                remote_urls: vec![],
            });
        }
        // 轮询端点同提交端点族：GET /v1/videos/{endpoint}/{id}
        // task_id 前缀无法反推 endpoint，故两个端点都尝试一次（容忍 404）。
        for endpoint in ["text2video", "image2video"] {
            let resp = match self
                .client
                .get(format!("{}/v1/videos/{}/{}", BASE_URL, endpoint, handle.task_id))
                .bearer_auth(api_key)
                .send()
                .await
            {
                Ok(r) => r,
                Err(_) => continue,
            };
            let status = resp.status();
            if status.as_u16() == 404 {
                continue; // 端点不匹配，换下一个
            }
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
            let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
            if code != 0 {
                let msg = v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("查询失败");
                return Ok(TaskSnapshot {
                    phase: TaskPhase::Failed,
                    progress: 100,
                    message: Some(msg.to_string()),
                    remote_urls: vec![],
                });
            }
            let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
            let task_status = data
                .get("task_status")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_lowercase();
            return match task_status.as_str() {
                "succeed" | "success" => {
                    let mut urls = Vec::new();
                    if let Some(vids) = data.get("videos").and_then(|x| x.as_array()) {
                        for vid in vids {
                            if let Some(u) = vid.get("url").and_then(|x| x.as_str()) {
                                urls.push(u.to_string());
                            }
                        }
                    }
                    if urls.is_empty() {
                        return Ok(TaskSnapshot {
                            phase: TaskPhase::Failed,
                            progress: 100,
                            message: Some("succeed 但缺 videos[].url".to_string()),
                            remote_urls: vec![],
                        });
                    }
                    Ok(TaskSnapshot {
                        phase: TaskPhase::Succeeded,
                        progress: 100,
                        message: None,
                        remote_urls: urls,
                    })
                }
                "failed" => Ok(TaskSnapshot {
                    phase: TaskPhase::Failed,
                    progress: 100,
                    message: Some(
                        data.get("task_err")
                            .and_then(|e| e.as_str())
                            .unwrap_or("生成失败")
                            .to_string(),
                    ),
                    remote_urls: vec![],
                }),
                _ => Ok(TaskSnapshot {
                    phase: TaskPhase::Running,
                    progress: 50,
                    message: Some(task_status),
                    remote_urls: vec![],
                }),
            };
        }
        Ok(TaskSnapshot {
            phase: TaskPhase::Failed,
            progress: 100,
            message: Some("任务查询端点均 404".to_string()),
            remote_urls: vec![],
        })
    }

    async fn test_connectivity(&self, api_key: &str) -> Result<String, String> {
        // 廉价鉴权校验：查询不存在任务，401/403→Key 无效，404→Key 有效。
        let resp = self
            .client
            .get(format!("{}/v1/videos/text2video/0", BASE_URL))
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
