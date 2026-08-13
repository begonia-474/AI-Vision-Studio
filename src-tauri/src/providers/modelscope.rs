//! 魔搭（ModelScope）适配器——内置厂商。
//! 协议：任务式（异步）。POST {base}/v1/{images|videos}/generations → task_id，
//! 轮询 GET {base}/v1/tasks/{id}（X-ModelScope-Task-Type 区分图像/视频）。
//! 官方无 n 参数：N 张 = 同样参数并行创建 N 个任务（哩布行为），task_id 打包为 JSON 数组，
//! poll 时拆分轮询全部并聚合输出。
//! 模型自定义参数经 GenRequest.extra.params 透传（steps/guidance/seed/negative_prompt/loras），
//! 由 merge_params 并入请求顶层。loras 见前端 LoRA 模块（单 LoRA dict 透传；多 LoRA 等比归一和=1）。

use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::models::{GenRequest, HttpRecord, ProviderInfoDto, TaskHandle, TaskPhase, TaskSnapshot};
use crate::providers::{sanitize_body, GenerationProvider};

pub const PROVIDER_ID: &str = "modelscope";
const BASE_URL: &str = "https://api-inference.modelscope.cn";
const DEFAULT_MODEL: &str = "Qwen/Qwen-Image";

pub struct ModelScopeProvider {
    client: Client,
}

impl ModelScopeProvider {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    pub fn info() -> ProviderInfoDto {
        ProviderInfoDto {
            id: PROVIDER_ID.to_string(),
            display_name: "魔搭 ModelScope".to_string(),
            capabilities: vec!["t2i".into(), "i2i".into(), "t2v".into(), "i2v".into()],
            auth_help: "在 ModelScope 控制台（modelscope.cn）创建 API Key。".to_string(),
        }
    }

    fn failed_snapshot(msg: String) -> TaskSnapshot {
        TaskSnapshot {
            phase: TaskPhase::Failed,
            progress: 100,
            message: Some(msg),
            remote_urls: vec![],
            http_log: vec![],
        }
    }

    /// 请求中的 model（repo id）。内置魔搭模型的 ModelDef.id 即 repo_id。
    fn model_repo(&self, req: &GenRequest) -> Result<String, String> {
        let m = req
            .model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string());
        if m.is_empty() {
            return Err("魔搭未配置模型".to_string());
        }
        Ok(m)
    }

    /// 把 req.extra.params（前端按模型配置的自由参数）并入 payload 顶层。
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

    /// 提交：异步任务，POST {base}/v1/{images|videos}/generations → task_id。
    /// 官方无 n 参数：N 张 = 同样参数串行创建 N 个任务（串行避免网关幂等去重），
    /// task_id 打包为 JSON 数组，poll 时拆分轮询全部并聚合输出。
    async fn submit_inner(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        let (endpoint, _task_type) = match req.capability.as_str() {
            "t2i" | "i2i" => ("v1/images/generations", "image_generation"),
            "t2v" | "i2v" => ("v1/videos/generations", "video_generation"),
            cap => return Err(format!("魔搭不支持能力: {}", cap)),
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

        let loops = req.n.max(1) as usize;
        let mut task_ids = Vec::with_capacity(loops);
        let mut http_log = Vec::new();
        // 串行逐个提交（不并发）：网关对「相同内容并发到达」的提交做幂等去重，
        // 导致 N 张图只有少量不同产物而控制台仍按 N 次计费。
        // 串行后每次提交间隔一个网络 RTT，错开去重窗口，各自获得独立任务。
        for _ in 0..loops {
            // 无显式 seed 时注入随机 seed（部分网关按完整 payload 去重时起作用）。
            let mut body = payload.clone();
            if body.get("seed").is_none() {
                body["seed"] = json!((Uuid::new_v4().as_u128() % 1_000_000_000) as u64);
            }
            match Self::ms_create_once(self.client.clone(), api_key, endpoint, body, &mut http_log)
                .await
            {
                Ok(t) => task_ids.push(t),
                Err(msg) => {
                    return Ok(TaskHandle {
                        task_id: String::new(),
                        phase: TaskPhase::Failed,
                        remote_urls: vec![],
                        error: Some(msg),
                        http_log,
                    });
                }
            }
        }
        // 单个任务直接用原 id；多个打包 JSON 数组，poll 拆分。
        let packed = if task_ids.len() == 1 {
            task_ids[0].clone()
        } else {
            serde_json::to_string(&task_ids).unwrap_or_else(|_| task_ids.join(","))
        };
        Ok(TaskHandle {
            task_id: packed,
            phase: TaskPhase::Submitted,
            remote_urls: vec![],
            error: None,
            http_log,
        })
    }

    /// 单次创建魔搭异步任务 → task_id，并把本次 HTTP 交换记入 log。
    async fn ms_create_once(
        client: Client,
        api_key: &str,
        endpoint: &str,
        payload: Value,
        log: &mut Vec<HttpRecord>,
    ) -> Result<String, String> {
        let url = format!("{}/{}", BASE_URL, endpoint);
        let resp = client
            .post(&url)
            .bearer_auth(api_key)
            .header("X-ModelScope-Async-Mode", "true")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败: {}", e))?;
        log.push(HttpRecord {
            method: "POST",
            url: url.clone(),
            request_body: Some(payload.to_string()),
            status: status.as_u16(),
            response_body: sanitize_body(&body),
        });
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, body));
        }
        let v: Value = serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;
        match v.get("task_id").and_then(|x| x.as_str()) {
            Some(t) => Ok(t.to_string()),
            None => {
                let msg = v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("响应缺 task_id");
                Err(msg.to_string())
            }
        }
    }

    async fn poll_inner(&self, handle: &TaskHandle, api_key: &str) -> Result<TaskSnapshot, String> {
        if handle.phase == TaskPhase::Failed {
            return Ok(Self::failed_snapshot(
                handle
                    .error
                    .clone()
                    .unwrap_or_else(|| "生成失败".to_string()),
            ));
        }
        // 单图循环：task_id 打包为 JSON 数组（submit 内），拆分轮询全部并聚合。
        let ids: Vec<String> = if handle.task_id.starts_with('[') {
            serde_json::from_str(&handle.task_id).unwrap_or_else(|_| vec![handle.task_id.clone()])
        } else {
            vec![handle.task_id.clone()]
        };
        let mut all_urls = Vec::new();
        let mut any_failed: Option<String> = None;
        let mut any_running = false;
        let mut http_log = Vec::new();
        for tid in &ids {
            let mut matched = false;
            for task_type in ["image_generation", "video_generation"] {
                let url = format!("{}/v1/tasks/{}", BASE_URL, tid);
                let resp = match self
                    .client
                    .get(&url)
                    .bearer_auth(api_key)
                    .header("X-ModelScope-Task-Type", task_type)
                    .send()
                    .await
                {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let status = resp.status();
                let body = resp
                    .text()
                    .await
                    .map_err(|e| format!("读取响应失败: {}", e))?;
                if !status.is_success() {
                    if status.as_u16() == 404 || status.as_u16() == 400 {
                        continue;
                    }
                    http_log.push(HttpRecord {
                        method: "GET",
                        url,
                        request_body: None,
                        status: status.as_u16(),
                        response_body: sanitize_body(&body),
                    });
                    return Ok(Self::failed_snapshot(format!("HTTP {}: {}", status, body)));
                }
                http_log.push(HttpRecord {
                    method: "GET",
                    url,
                    request_body: None,
                    status: status.as_u16(),
                    response_body: sanitize_body(&body),
                });
                let v: Value = match serde_json::from_str(&body) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let task_status = v
                    .get("task_status")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_uppercase();
                matched = true;
                match task_status.as_str() {
                    "SUCCEED" => {
                        for key in ["output_images", "output_videos", "outputs"] {
                            if let Some(arr) = v.get(key).and_then(|x| x.as_array()) {
                                for it in arr {
                                    if let Some(u) = it.get("url").and_then(|x| x.as_str()) {
                                        all_urls.push(u.to_string());
                                    } else if let Some(u) = it.as_str() {
                                        all_urls.push(u.to_string());
                                    }
                                }
                            }
                        }
                    }
                    "FAILED" => {
                        if any_failed.is_none() {
                            // 原样显示响应内容（响应是什么就显示什么）：不猜测字段名、
                            // 不加工。失败响应通常较小，sanitize_body 已脱敏超长数据块。
                            any_failed = Some(sanitize_body(&body));
                        }
                    }
                    _ => any_running = true,
                }
                break;
            }
            if !matched {
                any_running = true;
            }
        }
        if let Some(msg) = any_failed {
            return Ok(Self::failed_snapshot(msg));
        }
        if any_running {
            return Ok(TaskSnapshot {
                phase: TaskPhase::Running,
                progress: 0,
                message: None,
                remote_urls: vec![],
                http_log,
            });
        }
        if all_urls.is_empty() {
            return Ok(Self::failed_snapshot("succeed 但无输出 URL".to_string()));
        }
        Ok(TaskSnapshot {
            phase: TaskPhase::Succeeded,
            progress: 100,
            message: None,
            remote_urls: all_urls,
            http_log,
        })
    }
}

#[async_trait]
impl GenerationProvider for ModelScopeProvider {
    fn default_model(&self) -> &str {
        DEFAULT_MODEL
    }

    async fn submit(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        self.submit_inner(req, api_key).await
    }

    async fn poll(&self, handle: &TaskHandle, api_key: &str) -> Result<TaskSnapshot, String> {
        self.poll_inner(handle, api_key).await
    }

    async fn test_connectivity(&self, api_key: &str) -> Result<String, String> {
        // 查询不存在任务：401/403 → Key 无效。
        let resp = self
            .client
            .get(format!("{}/v1/tasks/0", BASE_URL))
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
}
