//! 自定义厂商适配器（平台型厂商：一个协议 + 无数模型）。
//!
//! 配置以 JSON 存于 custom_providers 表，前端为 schema 所有者：
//! { id, name, protocol, base_url, models: [{ repo_id, name, capabilities, size_presets, params }] }
//!
//! 支持的协议（兼容类型）：
//! - modelscope       魔搭：POST /v1/images|videos/generations（X-ModelScope-Async-Mode: true）
//!                     → GET /v1/tasks/{id}（X-ModelScope-Task-Type）轮询；异步任务模型
//! - huggingface      HF Inference API：POST /models/{repo}，响应为原始图像字节（同步）
//! - openai-compatible  OpenAI 兼容：POST /v1/images/generations，响应 {data:[{b64_json|url}]}（同步）
//!
//! 模型自定义参数经 GenRequest.extra.params 透传：
//! - modelscope：params 并入顶层（steps/guidance/seed/negative_prompt 等原生字段名）
//! - huggingface：params 并入 body.parameters（num_inference_steps/guidance_scale/seed/...）
//! - openai：params 并入顶层（quality/style/response_format 等）
//! 尺寸统一走 GenRequest.size（"WxH"）：modelscope/openai 原样透传，hf 拆为 width/height。

use async_trait::async_trait;
use base64::Engine;
use serde_json::{json, Value};

use crate::models::{GenRequest, TaskHandle, TaskPhase, TaskSnapshot};
use crate::providers::GenerationProvider;
use crate::storage;

/// 自定义厂商 id 前缀（keyring 与模型注册均以 "custom:<uuid>" 命名空间隔离）。
pub const PROVIDER_PREFIX: &str = "custom:";

pub struct CustomProvider {
    client: reqwest::Client,
    id: String,
    protocol: String,
    base_url: String,
    default_model: String,
}

impl CustomProvider {
    /// 按 id 加载配置构建适配器。配置缺失/损坏返回 None。
    pub fn try_load(id: &str, client: reqwest::Client) -> Option<Self> {
        let cfg = storage::get_custom_provider_config(id).ok()??;
        let v: Value = serde_json::from_str(&cfg).ok()?;
        let protocol = v.get("protocol").and_then(|x| x.as_str())?.to_string();
        let base_url = v
            .get("base_url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim_end_matches('/')
            .to_string();
        let default_model = v
            .get("models")
            .and_then(|m| m.as_array())
            .and_then(|a| a.first())
            .and_then(|m| m.get("repo_id"))
            .and_then(|r| r.as_str())
            .unwrap_or("")
            .to_string();
        Some(Self {
            client,
            id: format!("{}{}", PROVIDER_PREFIX, id),
            protocol,
            base_url,
            default_model,
        })
    }

    fn failed_snapshot(msg: String) -> TaskSnapshot {
        TaskSnapshot {
            phase: TaskPhase::Failed,
            progress: 100,
            message: Some(msg),
            remote_urls: vec![],
        }
    }

    // ============ 协议实现 ============

    /// 魔搭：异步任务，POST {base}/v1/{images|videos}/generations → task_id。
    async fn submit_modelscope(
        &self,
        req: &GenRequest,
        api_key: &str,
    ) -> Result<TaskHandle, String> {
        let (endpoint, _task_type) = match req.capability.as_str() {
            "t2i" | "i2i" => ("v1/images/generations", "image_generation"),
            "t2v" | "i2v" => ("v1/videos/generations", "video_generation"),
            cap => return Err(format!("魔搭协议不支持能力: {}", cap)),
        };
        let model = self.model_repo(req)?;

        let mut payload = json!({
            "model": model,
            "prompt": req.prompt,
        });
        Self::merge_params(&mut payload, req);
        if req.capability == "t2i" || req.capability == "i2i" {
            payload["size"] = json!(req.size);
        }
        if (req.capability == "i2i" || req.capability == "i2v") && !req.references.is_empty() {
            payload["image_url"] = json!(req.references);
        }

        let resp = self
            .client
            .post(format!("{}/{}", self.base_url, endpoint))
            .bearer_auth(api_key)
            .header("X-ModelScope-Async-Mode", "true")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Ok(TaskHandle {
                provider_id: self.id.clone(),
                task_id: String::new(),
                phase: TaskPhase::Failed,
                remote_urls: vec![],
                error: Some(format!("HTTP {}: {}", status, body)),
            });
        }
        let v: Value =
            serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;
        let task_id = match v.get("task_id").and_then(|x| x.as_str()) {
            Some(t) => t.to_string(),
            None => {
                let msg = v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("响应缺 task_id");
                return Ok(TaskHandle {
                    provider_id: self.id.clone(),
                    task_id: String::new(),
                    phase: TaskPhase::Failed,
                    remote_urls: vec![],
                    error: Some(msg.to_string()),
                });
            }
        };
        Ok(TaskHandle {
            provider_id: self.id.clone(),
            task_id,
            phase: TaskPhase::Submitted,
            remote_urls: vec![],
            error: None,
        })
    }

    /// HuggingFace：POST {base}/models/{repo}，响应为原始图像字节 → data URL（同步）。
    async fn submit_hf(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        if req.capability != "t2i" {
            return Err("HuggingFace 协议当前仅支持文生图".to_string());
        }
        let model = self.model_repo(req)?;
        let mut params = json!({});
        if let Some(extra) = &req.extra {
            if let Some(p) = extra.get("params").and_then(|x| x.as_object()) {
                params = Value::Object(p.clone());
            }
        }
        // 尺寸 "WxH" → parameters.width/height
        if let Some((w, h)) = req.size.split_once('x') {
            if let (Ok(w), Ok(h)) = (w.trim().parse::<u32>(), h.trim().parse::<u32>()) {
                params["width"] = json!(w);
                params["height"] = json!(h);
            }
        }
        let payload = json!({
            "inputs": req.prompt,
            "parameters": params,
        });

        let resp = self
            .client
            .post(format!("{}/models/{}", self.base_url, model))
            .bearer_auth(api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Ok(TaskHandle {
                provider_id: self.id.clone(),
                task_id: String::new(),
                phase: TaskPhase::Failed,
                remote_urls: vec![],
                error: Some(format!("HTTP {}: {}", status, body)),
            });
        }
        let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {}", e))?;
        // 图像字节 → data URL（下游 save_remote 支持 base64 data URL 落盘）
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let url = format!("data:image/png;base64,{}", b64);
        Ok(TaskHandle {
            provider_id: self.id.clone(),
            task_id: String::new(),
            phase: TaskPhase::Succeeded,
            remote_urls: vec![url],
            error: None,
        })
    }

    /// OpenAI 兼容：POST {base}/v1/images/generations，响应 {data:[{b64_json|url}]}（同步）。
    async fn submit_openai(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        if req.capability != "t2i" {
            return Err("OpenAI 兼容协议当前仅支持文生图".to_string());
        }
        let model = self.model_repo(req)?;
        let mut payload = json!({
            "model": model,
            "prompt": req.prompt,
            "size": req.size,
            "n": req.n.min(4),
            "response_format": "b64_json",
        });
        Self::merge_params(&mut payload, req);

        let resp = self
            .client
            .post(format!("{}/v1/images/generations", self.base_url))
            .bearer_auth(api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Ok(TaskHandle {
                provider_id: self.id.clone(),
                task_id: String::new(),
                phase: TaskPhase::Failed,
                remote_urls: vec![],
                error: Some(format!("HTTP {}: {}", status, body)),
            });
        }
        let v: Value =
            serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;
        let mut urls = Vec::new();
        if let Some(data) = v.get("data").and_then(|x| x.as_array()) {
            for it in data {
                if let Some(b64) = it.get("b64_json").and_then(|x| x.as_str()) {
                    urls.push(format!("data:image/png;base64,{}", b64));
                } else if let Some(u) = it.get("url").and_then(|x| x.as_str()) {
                    urls.push(u.to_string());
                }
            }
        }
        if urls.is_empty() {
            return Ok(TaskHandle {
                provider_id: self.id.clone(),
                task_id: String::new(),
                phase: TaskPhase::Failed,
                remote_urls: vec![],
                error: Some(format!("响应缺 data[]: {}", body)),
            });
        }
        Ok(TaskHandle {
            provider_id: self.id.clone(),
            task_id: String::new(),
            phase: TaskPhase::Succeeded,
            remote_urls: urls,
            error: None,
        })
    }

    /// 请求中的 model（repo id）。自定义厂商的模型 id 就是 repo_id。
    fn model_repo(&self, req: &GenRequest) -> Result<String, String> {
        let m = req
            .model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| self.default_model.clone());
        if m.is_empty() {
            return Err("自定义厂商未配置任何模型".to_string());
        }
        Ok(m)
    }

    /// 把 req.extra.params（用户配置的自由参数）并入 payload 顶层。
    fn merge_params(payload: &mut Value, req: &GenRequest) {
        if let Some(extra) = &req.extra {
            if let Some(p) = extra.get("params").and_then(|x| x.as_object()) {
                for (k, v) in p {
                    if payload.get(k).is_none() {
                        payload[k] = v.clone();
                    }
                }
            }
        }
    }
}

#[async_trait]
impl GenerationProvider for CustomProvider {
    fn default_model(&self) -> &str {
        &self.default_model
    }

    async fn submit(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        match self.protocol.as_str() {
            "modelscope" => self.submit_modelscope(req, api_key).await,
            "huggingface" => self.submit_hf(req, api_key).await,
            "openai-compatible" => self.submit_openai(req, api_key).await,
            other => Err(format!("未知的协议类型: {}", other)),
        }
    }

    async fn poll(&self, handle: &TaskHandle, api_key: &str) -> Result<TaskSnapshot, String> {
        if self.protocol != "modelscope" {
            // 同步协议：submit 已置终态，无需轮询
            return Ok(TaskSnapshot {
                phase: handle.phase,
                progress: 100,
                message: None,
                remote_urls: handle.remote_urls.clone(),
            });
        }
        if handle.phase == TaskPhase::Failed {
            return Ok(Self::failed_snapshot(
                handle.error.clone().unwrap_or_else(|| "生成失败".to_string()),
            ));
        }
        for task_type in ["image_generation", "video_generation"] {
            let resp = match self
                .client
                .get(format!("{}/v1/tasks/{}", self.base_url, handle.task_id))
                .bearer_auth(api_key)
                .header("X-ModelScope-Task-Type", task_type)
                .send()
                .await
            {
                Ok(r) => r,
                Err(_) => continue,
            };
            let status = resp.status();
            let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
            if !status.is_success() {
                if status.as_u16() == 404 || status.as_u16() == 400 {
                    continue;
                }
                return Ok(Self::failed_snapshot(format!("HTTP {}: {}", status, body)));
            }
            let v: Value = match serde_json::from_str(&body) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let task_status = v
                .get("task_status")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_uppercase();
            return match task_status.as_str() {
                "SUCCEED" => {
                    let mut urls = Vec::new();
                    for key in ["output_images", "output_videos", "outputs"] {
                        if let Some(arr) = v.get(key).and_then(|x| x.as_array()) {
                            for it in arr {
                                if let Some(u) = it.get("url").and_then(|x| x.as_str()) {
                                    urls.push(u.to_string());
                                } else if let Some(u) = it.as_str() {
                                    urls.push(u.to_string());
                                }
                            }
                        }
                    }
                    if urls.is_empty() {
                        return Ok(Self::failed_snapshot("succeed 但无输出 URL".to_string()));
                    }
                    Ok(TaskSnapshot {
                        phase: TaskPhase::Succeeded,
                        progress: 100,
                        message: None,
                        remote_urls: urls,
                    })
                }
                "FAILED" => Ok(Self::failed_snapshot(
                    v.get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("生成失败")
                        .to_string(),
                )),
                _ => Ok(TaskSnapshot {
                    phase: TaskPhase::Running,
                    progress: 0,
                    message: Some(task_status),
                    remote_urls: vec![],
                }),
            };
        }
        Ok(Self::failed_snapshot("任务查询失败（task-type 均不匹配）".to_string()))
    }

    async fn test_connectivity(&self, api_key: &str) -> Result<String, String> {
        match self.protocol.as_str() {
            // 查询不存在任务：401/403 → Key 无效
            "modelscope" => {
                let resp = self
                    .client
                    .get(format!("{}/v1/tasks/0", self.base_url))
                    .bearer_auth(api_key)
                    .header("X-ModelScope-Task-Type", "image_generation")
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                let code = resp.status().as_u16();
                if code == 401 || code == 403 {
                    return Err("API Key 无效".to_string());
                }
                Ok("API Key 有效（已通过鉴权层）。".to_string())
            }
            // GET {base}/models：携带有效 Bearer 返回 200
            "huggingface" => {
                let resp = self
                    .client
                    .get(format!("{}/models", self.base_url))
                    .bearer_auth(api_key)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                let code = resp.status().as_u16();
                if code == 401 || code == 403 {
                    return Err("API Key 无效".to_string());
                }
                Ok("API Key 有效（已通过鉴权层）。".to_string())
            }
            // GET {base}/v1/models：OpenAI 生态标准鉴权探针
            _ => {
                let resp = self
                    .client
                    .get(format!("{}/v1/models", self.base_url))
                    .bearer_auth(api_key)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                let code = resp.status().as_u16();
                if code == 401 || code == 403 {
                    return Err("API Key 无效".to_string());
                }
                Ok("API Key 有效（已通过鉴权层）。".to_string())
            }
        }
    }
}
