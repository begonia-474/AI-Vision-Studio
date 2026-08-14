use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::json;

use crate::models::{GenRequest, HttpRecord, ProviderInfoDto, TaskHandle, TaskPhase, TaskSnapshot};
use crate::providers::{sanitize_body, GenerationProvider};

/// 火山方舟 豆包 Seedream/Seedance 适配器（对照 docs/model-api 官方文档实查 2026.07.31）。
/// baseUrl: https://ark.cn-beijing.volces.com/api/v3
/// 鉴权: Authorization: Bearer $ARK_API_KEY
///
/// 图像 t2i/i2i（同步）: POST /images/generations → data[].url（24h 有效）
///   - 无 `n` 参数：多图走 `sequential_image_generation:"auto"` + `max_images`（仅 4.5/4.0/lite；5.0 pro 单图）
///   - `size` 用方式2 像素串，按 model+quality+ratio 取官方 2K/4K/1K 像素表（须满足各模型总像素区间）
///   - `image` 接受 URL 或 data:image/...;base64,
///
/// 视频 t2v/i2v（异步）: POST /contents/generations/tasks → id（7 天）
///   - resolution/ratio/duration/watermark 均为**顶层**参数（非 parameters 包裹）
///   - i2v: content[] 追加 {type:image_url, image_url:{url}, role:first_frame}
///   - 轮询 GET /contents/generations/tasks/{id} → status + content.video_url（content 为**对象**）
const BASE_URL: &str = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_IMAGE_MODEL: &str = "doubao-seedream-4-5-251128";
const DEFAULT_VIDEO_MODEL: &str = "doubao-seedance-1-0-pro-250528";
pub const PROVIDER_ID: &str = "volcark";

pub struct VolcArkProvider {
    client: reqwest::Client,
}

impl VolcArkProvider {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }

    pub fn info() -> ProviderInfoDto {
        ProviderInfoDto {
            id: PROVIDER_ID.to_string(),
            display_name: "即梦 / 豆包 Seedream（火山方舟）".to_string(),
            capabilities: vec![
                "text_to_image".to_string(),
                "image_to_image".to_string(),
                "text_to_video".to_string(),
                "image_to_video".to_string(),
            ],
            auth_help: "在火山方舟控制台创建 API Key（Bearer Token），填入下方。".to_string(),
        }
    }
}

/// 是否支持组图（sequential_image_generation）。5.0 pro 仅单图；4.5/4.0/lite 支持。
fn supports_sequential(model: &str) -> bool {
    !model.contains("5-0-pro")
}

/// 各模型方式2 总像素区间（官方规格）：
///   - 5.0 pro:  [921600, 4624220]
///   - 5.0 lite: [3686400, 16777216]
///   - 4.5:      [3686400, 16777216]
///   - 4.0:      [921600, 16777216]
fn total_pixel_bounds(model: &str) -> (u64, u64) {
    if model.contains("5-0-pro") {
        (921_600, 4_624_220)
    } else if model.contains("4-0") {
        (921_600, 16_777_216)
    } else {
        // 5.0 lite / 4.5
        (3_686_400, 16_777_216)
    }
}

/// 图像 size 像素串：优先接受前端自定义宽高像素值（须满足该模型总像素区间），
/// 否则按 model + quality + ratio 取官方像素表（方式2）。
fn volcark_image_size(model: &str, quality: &str, ar: &str, custom: Option<&str>) -> String {
    if let Some(px) = custom {
        if let Some((w, h)) = px.split_once('x') {
            if let (Ok(w), Ok(h)) = (w.parse::<u64>(), h.parse::<u64>()) {
                let total = w.saturating_mul(h);
                let (lo, hi) = total_pixel_bounds(model);
                if total >= lo && total <= hi {
                    return format!("{w}x{h}");
                }
            }
        }
    }
    // 5.0 pro 独立像素表（与 lite/4.5/4.0 不同：如 2K 16:9 pro=2816x1584 vs lite=2848x1600）
    if model.contains("5-0-pro") {
        return match quality {
            "1K" => match ar {
                "1:1" => "1024x1024",
                "4:3" => "1152x864",
                "3:4" => "864x1152",
                "16:9" => "1424x800",
                "9:16" => "800x1424",
                _ => "1024x1024",
            },
            // 2K（含 1.5K 归并）
            _ => match ar {
                "1:1" => "2048x2048",
                "4:3" => "2368x1776",
                "3:4" => "1776x2368",
                "16:9" => "2816x1584",
                "9:16" => "1584x2816",
                _ => "2048x2048",
            },
        }
        .to_string();
    }
    // 5.0 lite / 4.5 / 4.0 共用像素表
    match quality {
        "4K" => match ar {
            "1:1" => "4096x4096",
            "4:3" => "4704x3520",
            "3:4" => "3520x4704",
            "16:9" => "5504x3040",
            "9:16" => "3040x5504",
            _ => "4096x4096",
        },
        "3K" => match ar {
            "1:1" => "3072x3072",
            "4:3" => "3456x2592",
            "3:4" => "2592x3456",
            "16:9" => "4096x2304",
            "9:16" => "2304x4096",
            _ => "3072x3072",
        },
        "1K" => match ar {
            "1:1" => "1024x1024",
            "4:3" => "1152x864",
            "3:4" => "864x1152",
            "16:9" => "1280x720",
            "9:16" => "720x1280",
            _ => "1024x1024",
        },
        // 2K（默认）
        _ => match ar {
            "1:1" => "2048x2048",
            "4:3" => "2304x1728",
            "3:4" => "1728x2304",
            "16:9" => "2848x1600",
            "9:16" => "1600x2848",
            _ => "2048x2048",
        },
    }
    .to_string()
}

#[async_trait]
impl GenerationProvider for VolcArkProvider {
    fn default_model(&self) -> &str {
        DEFAULT_IMAGE_MODEL
    }

    async fn submit(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        match req.capability.as_str() {
            "t2i" | "i2i" => self.submit_image(req, api_key).await,
            "t2v" | "i2v" => self.submit_video(req, api_key).await,
            other => Err(format!("火山方舟不支持能力: {}", other)),
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
                http_log: vec![],
            });
        }
        // 异步视频：GET /contents/generations/tasks/{id}
        let url = format!("{}/contents/generations/tasks/{}", BASE_URL, handle.task_id);
        let resp = self
            .client
            .get(&url)
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| format!("轮询失败: {}", e))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败: {}", e))?;
        let record = HttpRecord {
            method: "GET",
            url: url.clone(),
            request_body: None,
            status: status.as_u16(),
            response_body: sanitize_body(&body),
        };
        if !status.is_success() {
            return Ok(TaskSnapshot {
                phase: TaskPhase::Failed,
                progress: 100,
                message: Some(format!("HTTP {}: {}", status, body)),
                remote_urls: vec![],
                http_log: vec![record],
            });
        }
        let v: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;
        // 错误体: { error: { code, message } }（与图像 API 一致）
        if let Some(err_msg) = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return Ok(TaskSnapshot {
                phase: TaskPhase::Failed,
                progress: 100,
                message: Some(err_msg.to_string()),
                remote_urls: vec![],
                http_log: vec![record],
            });
        }
        let task_status = v
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_lowercase();
        match task_status.as_str() {
            "succeeded" => {
                // content 为对象：content.video_url
                let url = v
                    .get("content")
                    .and_then(|c| c.get("video_url"))
                    .and_then(|u| u.as_str())
                    .unwrap_or("")
                    .to_string();
                if url.is_empty() {
                    return Ok(TaskSnapshot {
                        phase: TaskPhase::Failed,
                        progress: 100,
                        message: Some("succeeded 但缺 content.video_url".to_string()),
                        remote_urls: vec![],
                        http_log: vec![record],
                    });
                }
                Ok(TaskSnapshot {
                    phase: TaskPhase::Succeeded,
                    progress: 100,
                    message: None,
                    remote_urls: vec![url],
                    http_log: vec![record],
                })
            }
            "failed" | "cancelled" | "expired" => Ok(TaskSnapshot {
                phase: TaskPhase::Failed,
                progress: 100,
                message: Some(task_status),
                remote_urls: vec![],
                http_log: vec![record],
            }),
            _ => Ok(TaskSnapshot {
                phase: TaskPhase::Running,
                progress: 50,
                message: Some(task_status),
                remote_urls: vec![],
                http_log: vec![record],
            }),
        }
    }

    async fn test_connectivity(&self, api_key: &str) -> Result<String, String> {
        // 用 GET /models 做廉价鉴权校验，不产生图片消耗。
        let resp = self
            .client
            .get(format!("{}/models", BASE_URL))
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            return Ok("API Key 有效（已成功拉取模型列表）。".to_string());
        }
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(format!("HTTP {}: {}", status, body))
    }
}

impl VolcArkProvider {
    async fn submit_image(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        let model = req
            .model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_IMAGE_MODEL.to_string());
        let ar = req.aspect_ratio.as_deref().unwrap_or("1:1");
        let quality = req.quality.as_deref().unwrap_or("2K");
        let size = volcark_image_size(&model, quality, ar, Some(&req.size));

        let want_n = req.n.max(1) as usize;
        // 组图模式（mode=group 且模型支持）：一次请求 sequential auto + max_images（一组关联图）；
        // 单图模式（默认，含 5.0 pro）：官方 API 无 n 参数，同样参数**并行**请求，每张图一个独立请求
        // （哩布行为：N 张 = N 次请求，计费 N 份），全部归入同一任务。
        let group =
            req.mode.as_deref() == Some("group") && want_n > 1 && supports_sequential(&model);
        let loops = if group { 1 } else { want_n };

        let mut payload = json!({
            "model": model.clone(),
            "prompt": req.prompt,
            "size": size.clone(),
            "response_format": "url",
            "watermark": false, // 关闭「AI 生成」水印
        });
        // 注：官方图片 API 参数表无 negative_prompt 字段（强校验下传未文档化参数有报错风险），
        // 故此处不传；反向描述请并入 prompt。GenRequest 保留该字段供其他厂商使用。
        // 图像格式 output_format：仅 5.0 pro/lite 支持（png/jpeg，缺省 jpeg），其余模型不传。
        if let Some(fmt) = req.output_format.as_deref() {
            if model.contains("5-0") && (fmt == "png" || fmt == "jpeg") {
                payload["output_format"] = json!(fmt);
            }
        }
        // i2i：image[] 接受 data:image/...;base64, 或 https URL
        if req.capability == "i2i" && !req.references.is_empty() {
            payload["image"] = json!(req.references);
        }
        if group {
            payload["sequential_image_generation"] = json!("auto");
            payload["sequential_image_generation_options"] = json!({ "max_images": want_n });
        }

        // 并行发起（组图为单次请求；单图模式并发 N 个）。
        // 审计#12：原先每张一个 tokio::spawn——单任务内并发无上限（N 大时打爆连接池、
        // 失败早退还会遗留后台任务）；改为受控并发流（上限 4、保持结果顺序、不新建任务）。
        let futs = (0..loops).map(|_| {
            let client = self.client.clone();
            let key = api_key.to_string();
            let body = payload.clone();
            Self::image_generate_once(client, key, body)
        });
        let results: Vec<Result<(Vec<String>, HttpRecord), String>> =
            futures_util::stream::iter(futs)
                .buffer_unordered(4)
                .collect()
                .await;

        let mut urls = Vec::new();
        let mut http_log = Vec::new();
        for r in results {
            match r {
                Ok((mut u, rec)) => {
                    urls.append(&mut u);
                    http_log.push(rec);
                }
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

        Ok(TaskHandle {
            task_id: String::new(),
            phase: TaskPhase::Succeeded,
            remote_urls: urls,
            error: None,
            http_log,
        })
    }

    /// 单次图像生成请求：POST /images/generations → 解析 data[].url（组图场景一次返回多张），
    /// 附带本次 HTTP 交换记录。
    async fn image_generate_once(
        client: reqwest::Client,
        api_key: String,
        payload: serde_json::Value,
    ) -> Result<(Vec<String>, HttpRecord), String> {
        let url = format!("{}/images/generations", BASE_URL);
        let resp = client
            .post(&url)
            .bearer_auth(&api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败: {}", e))?;
        let record = HttpRecord {
            method: "POST",
            url: url.clone(),
            request_body: Some(payload.to_string()),
            status: status.as_u16(),
            response_body: sanitize_body(&body),
        };
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, body));
        }
        let v: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;
        // 顶层错误: { error: { code, message } }（整个请求未生成任何图时返回）
        if let Some(err_msg) = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return Err(err_msg.to_string());
        }
        let mut urls = Vec::new();
        if let Some(data) = v.get("data").and_then(|d| d.as_array()) {
            for item in data {
                // 单图错误 data.error 不中断其余图，跳过失败项
                if item.get("error").is_some_and(|e| !e.is_null()) {
                    continue;
                }
                if let Some(u) = item.get("url").and_then(|u| u.as_str()) {
                    urls.push(u.to_string());
                } else if let Some(b64) = item.get("b64_json").and_then(|b| b.as_str()) {
                    urls.push(format!("data:image/png;base64,{}", b64));
                }
            }
        }
        if urls.is_empty() {
            return Err("响应未包含图片 URL".to_string());
        }
        Ok((urls, record))
    }

    async fn submit_video(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        let model = req
            .model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_VIDEO_MODEL.to_string());
        let resolution = req
            .quality
            .clone()
            .unwrap_or_else(|| "1080p".to_string())
            .to_lowercase();
        let ratio = req
            .aspect_ratio
            .clone()
            .unwrap_or_else(|| "16:9".to_string());
        let duration: i64 = req
            .duration
            .as_deref()
            .and_then(|d| d.parse().ok())
            .map(|d: i64| d.clamp(2, 15))
            .unwrap_or(5);

        // content 数组：text + 可选 first_frame
        if req.capability == "i2v" && req.references.is_empty() {
            return Err("i2v 需要首帧参考图".to_string());
        }
        let mut content = vec![json!({ "type": "text", "text": req.prompt })];
        if req.capability == "i2v" {
            if let Some(first) = req.references.first() {
                content.push(json!({
                    "type": "image_url",
                    "image_url": { "url": first },
                    "role": "first_frame"
                }));
            }
        }
        // 注意：resolution/ratio/duration/watermark 为顶层参数（官方示例），非 parameters 包裹
        let payload = json!({
            "model": model,
            "content": content,
            "resolution": resolution,
            "ratio": ratio,
            "duration": duration,
            "watermark": false
        });

        let url = format!("{}/contents/generations/tasks", BASE_URL);
        let resp = self
            .client
            .post(&url)
            .bearer_auth(api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败: {}", e))?;
        let record = HttpRecord {
            method: "POST",
            url: url.clone(),
            request_body: Some(payload.to_string()),
            status: status.as_u16(),
            response_body: sanitize_body(&body),
        };
        if !status.is_success() {
            return Ok(TaskHandle {
                task_id: String::new(),
                phase: TaskPhase::Failed,
                remote_urls: vec![],
                error: Some(format!("HTTP {}: {}", status, body)),
                http_log: vec![record],
            });
        }
        let v: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;
        if let Some(err_msg) = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return Ok(TaskHandle {
                task_id: String::new(),
                phase: TaskPhase::Failed,
                remote_urls: vec![],
                error: Some(err_msg.to_string()),
                http_log: vec![record],
            });
        }
        let task_id = v
            .get("id")
            .and_then(|t| t.as_str())
            .ok_or_else(|| format!("响应缺 id: {}", body))?
            .to_string();
        Ok(TaskHandle {
            task_id,
            phase: TaskPhase::Submitted,
            remote_urls: vec![],
            error: None,
            http_log: vec![record],
        })
    }
}
