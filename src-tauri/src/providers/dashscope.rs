use async_trait::async_trait;
use serde_json::json;

use crate::models::{GenRequest, HttpRecord, ProviderInfoDto, TaskHandle, TaskPhase, TaskSnapshot};
use crate::providers::{sanitize_body, GenerationProvider};
use crate::storage;

/// 阿里云百炼（DashScope）平台适配器：通义万相（wan2.6/2.7 图像与视频）、
/// 千问图像（qwen-image-*）、z-image 均为同一平台下不同模型族。
/// baseUrl 动态解析：设置了 WorkspaceId（BYOK 面板）→ 业务空间专属域名
/// `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`（官方建议迁移，性能更优）；
/// 未设置 → 回退旧域名 `https://dashscope.aliyuncs.com`（仍可用）。
/// 鉴权: Authorization: Bearer sk-xxxx（DashScope API Key）
/// 图像（同步）: POST /api/v1/services/aigc/multimodal-generation/generation
///   —— 不加 X-DashScope-Async；响应 output.choices[].message.content[].image
/// 视频（异步）: POST /api/v1/services/aigc/video-generation/video-synthesis
///   —— 必加 X-DashScope-Async: enable，否则报 "does not support synchronous calls"
///   —— 响应 output.task_id；轮询 GET /api/v1/tasks/{id} → output.task_status + output.video_url
const BASE_URL: &str = "https://dashscope.aliyuncs.com";

/// 业务空间 base URL 进程内缓存（审计#12）：WorkspaceId 只在用户改设置时变化，
/// 原先每次网络调用（视频轮询 5s/次 × 最长 60 分钟 ≈ 720 次）都 spawn_blocking 读
/// keys.json 并抢全局 KEYS_LOCK；改为缓存 + 写时失效（save/清除 workspace 时调用
/// invalidate_base_url_cache），轮询热循环降为常量。
static BASE_URL_CACHE: std::sync::OnceLock<std::sync::RwLock<Option<String>>> =
    std::sync::OnceLock::new();

fn base_url_cache() -> &'static std::sync::RwLock<Option<String>> {
    BASE_URL_CACHE.get_or_init(|| std::sync::RwLock::new(None))
}

/// workspace 变更后失效缓存（下次网络调用重新解析，见 commands::save_workspace_id）。
pub fn invalidate_base_url_cache() {
    if let Ok(mut g) = base_url_cache().write() {
        *g = None;
    }
}

/// 当前生效的 base URL：优先业务空间专属域名（北京），未配置 WorkspaceId 时回退旧域名。
/// 缓存命中零 IO；未命中时 keys.json 读取是同步文件 IO，丢阻塞线程池避免占 tokio worker（审计#4）。
async fn base_url() -> String {
    if let Some(cached) = base_url_cache().read().ok().and_then(|g| g.clone()) {
        return cached;
    }
    let ws = tokio::task::spawn_blocking(move || storage::get_workspace(PROVIDER_ID))
        .await
        .ok()
        .and_then(|r| r.ok())
        .and_then(|o| o);
    let url = match ws {
        Some(ws) if !ws.trim().is_empty() => {
            format!("https://{}.cn-beijing.maas.aliyuncs.com", ws.trim())
        }
        _ => BASE_URL.to_string(),
    };
    if let Ok(mut g) = base_url_cache().write() {
        *g = Some(url.clone());
    }
    url
}
const DEFAULT_IMAGE_MODEL: &str = "wan2.6-t2i"; // t2i 文生图
const DEFAULT_IMAGE_EDIT_MODEL: &str = "wan2.6-image"; // i2i 图像编辑
const DEFAULT_VIDEO_MODEL: &str = "wan2.7-t2v"; // t2v 文生视频
const DEFAULT_I2V_MODEL: &str = "wan2.7-i2v-2026-04-25"; // i2v 图生视频
/// 历史 provider id（keyring 凭据 / tasks 表均以此持久化，勿改；模块名 dashscope 仅为代码组织）。
pub const PROVIDER_ID: &str = "wanxiang";

pub struct DashScopeProvider {
    client: reqwest::Client,
}

impl DashScopeProvider {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }

    pub fn info() -> ProviderInfoDto {
        ProviderInfoDto {
            id: PROVIDER_ID.to_string(),
            display_name: "阿里云百炼（DashScope）".to_string(),
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

/// wan2.6 图像 size：
/// - 图像编辑（i2i，wan2.6-image）：官方支持 1K/2K 档位（输出比例跟最后一张输入图），画质档位透传。
/// - 文生图（t2i，wan2.6-t2i）：像素串按官方推荐表（总像素 ≤1440*1440、16 倍数），quality 不参与。
fn wan_image_size(capability: &str, ar: &str, quality: Option<&str>) -> String {
    if capability == "i2i" {
        return if quality == Some("2K") { "2K" } else { "1K" }.to_string();
    }
    match ar {
        "1:1" => "1280*1280",
        "3:4" => "1104*1472",
        "4:3" => "1472*1104",
        "9:16" => "960*1696",
        "16:9" => "1696*960",
        _ => "1280*1280",
    }
    .to_string()
}

/// 图像协议族（按模型分派，参数集差异大）。
enum ImageProtocol {
    /// wan2.6-t2i / wan2.6-image：像素串/档位 + prompt_extend + negative_prompt
    Wan26,
    /// wan2.7-image(-pro)：档位 size、组图 enable_sequential、多图参考 0-9；无 negative_prompt/prompt_extend
    Wan27,
    /// qwen-image-*：像素串、negative_prompt、变体 n≤6 / 固定 1、i2i 参考 ≤3 张
    Qwen,
    /// z-image-turbo：像素串、无 watermark/n/negative_prompt
    ZImage,
}

fn image_protocol(model: &str) -> ImageProtocol {
    if model.starts_with("wan2.7-image") {
        ImageProtocol::Wan27
    } else if model.starts_with("qwen-image") {
        ImageProtocol::Qwen
    } else if model == "z-image-turbo" {
        ImageProtocol::ZImage
    } else if model.starts_with("wan2.6-") || model == "wan2.6-t2i" {
        ImageProtocol::Wan26
    } else {
        // 审计#7：用户自添加模型 id 是任意字符串，前缀匹配全不命中时静默落 Wan26 分支——
        // 若模板模型协议不同会走错参数集。这里打日志暴露问题；自添加模型应复用
        // 内置模型 id 前缀（如 wan2.7-image-xxx / qwen-image-xxx）以命中对应协议。
        eprintln!(
            "[dashscope] 未知模型 id '{}'，按 Wan26 协议提交（自添加模型请使用内置模型 id 前缀）",
            model
        );
        ImageProtocol::Wan26
    }
}

/// 比例 + 档位长边 → 16 倍数像素串（wan2.7 t2i 用）。
/// 长边 = k（1K=1024 / 2K=2048 / 4K=4096），短边按比例换算向下取 16 倍数，
/// 总像素 ≈ k²（比例非 1:1 时略小），宽高比落在官方 [1:8, 8:1] 内。
fn ratio_px(ar: &str, k: i64) -> String {
    let (a, b) = match ar.split_once(':') {
        Some((x, y)) => (x.parse::<i64>().unwrap_or(1), y.parse::<i64>().unwrap_or(1)),
        None => (1, 1),
    };
    if a <= 0 || b <= 0 {
        return format!("{}*{}", k, k);
    }
    let (ma, mb) = if a >= b { (a, b) } else { (b, a) };
    let short = (((k * mb) / ma) / 16) * 16;
    let short = short.clamp(16, k);
    if a >= b {
        format!("{}*{}", k, short)
    } else {
        format!("{}*{}", short, k)
    }
}

/// qwen-image-max / plus / image 固定分辨率档（官方推荐表，无档位概念）。
fn qwen_legacy_size(ar: &str) -> &'static str {
    match ar {
        "16:9" => "1664*928",
        "4:3" => "1472*1104",
        "1:1" => "1328*1328",
        "3:4" => "1104*1472",
        "9:16" => "928*1664",
        _ => "1328*1328",
    }
}

/// 前端 W/H 自定义尺寸（"WxH"）→ DashScope 像素串（"宽*高"）。
/// 非像素串（比例如 "1:1"）或总像素超上限返回 None（调用方走默认 size 逻辑）。
fn custom_size_px(req: &GenRequest, max_px: u64) -> Option<String> {
    let s = req.size.split_once('x')?;
    let w = s.0.trim().parse::<u64>().ok()?;
    let h = s.1.trim().parse::<u64>().ok()?;
    if w == 0 || h == 0 || w * h > max_px {
        return None;
    }
    Some(format!("{}*{}", w, h))
}

/// 按能力分派默认模型：t2i→wan2.6-t2i、i2i→wan2.6-image、t2v→wan2.7-t2v、i2v→wan2.7-i2v。
/// （i2v 用 t2v 模型提交 media 必失败；i2i 用 t2i 模型无图生图能力。）
fn default_model_for(cap: &str) -> &'static str {
    match cap {
        "i2i" => DEFAULT_IMAGE_EDIT_MODEL,
        "t2v" => DEFAULT_VIDEO_MODEL,
        "i2v" => DEFAULT_I2V_MODEL,
        _ => DEFAULT_IMAGE_MODEL,
    }
}

/// 请求模型：前端显式传 model 优先，否则按能力取默认。
fn model_or(req: &GenRequest, cap_default: &str) -> String {
    req.model
        .clone()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| cap_default.to_string())
}

/// 可选参数透传通道：extra.params[key]（自定义参数机制，前端目前无 UI，保留通道）。
fn extra_param<'a>(req: &'a GenRequest, key: &str) -> Option<&'a serde_json::Value> {
    req.extra.as_ref()?.get("params")?.get(key)
}

/// 负向提示词：顶层字段优先，fallback extra.params；截断 ≤500 字符（官方上限）。
fn negative_prompt(req: &GenRequest) -> Option<String> {
    let raw = req.negative_prompt.clone().or_else(|| {
        extra_param(req, "negative_prompt")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    })?;
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    Some(t.chars().take(500).collect())
}

/// seed：仅从 extra.params 透传（无 UI），钳制 [0, 2147483647]。
fn seed_param(req: &GenRequest) -> Option<i64> {
    extra_param(req, "seed")
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .map(|s| s.clamp(0, 2_147_483_647))
}

/// watermark：仅从 extra.params 显式开启（默认 false 已由参数表兜底）。
fn watermark_param(req: &GenRequest) -> Option<bool> {
    extra_param(req, "watermark").and_then(|v| v.as_bool())
}

#[async_trait]
impl GenerationProvider for DashScopeProvider {
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
                http_log: vec![],
            });
        }
        // 异步视频：GET /api/v1/tasks/{id}
        let url = format!("{}/api/v1/tasks/{}", base_url().await, handle.task_id);
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
                    http_log: vec![record],
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
            "FAILED" => Ok(TaskSnapshot {
                phase: TaskPhase::Failed,
                progress: 100,
                message: Some(
                    // 2.7 协议：output.message / output.code；兼容旧版 task_metrics 字符串。
                    output
                        .get("message")
                        .and_then(|m| m.as_str())
                        .or_else(|| output.get("code").and_then(|c| c.as_str()))
                        .or_else(|| output.get("task_metrics").and_then(|m| m.as_str()))
                        .unwrap_or("生成失败")
                        .to_string(),
                ),
                remote_urls: vec![],
                http_log: vec![record],
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
                    http_log: vec![record],
                })
            }
        }
    }

    async fn test_connectivity(&self, api_key: &str) -> Result<String, String> {
        // 廉价鉴权校验：查询不存在任务，401→Key 无效，其余→Key 有效。
        let resp = self
            .client
            .get(format!("{}/api/v1/tasks/0", base_url().await))
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

impl DashScopeProvider {
    /// 图像提交：按模型分协议。
    /// - wan2.7-image / wan2.7-image-pro：档位 size、组图 enable_sequential、多图参考 0-9 张
    ///   （2.7 已移除 negative_prompt / prompt_extend，不传）。
    /// - qwen-image-*：像素串、负向提示词、变体 n≤6；edit 系列仅 i2i。
    /// - z-image-turbo：像素串，无 watermark/n/负向提示词。
    /// - wan2.6-t2i / wan2.6-image：像素串/档位 + prompt_extend + negative_prompt。
    async fn submit_image(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        // i2i 走 wan2.6-image（编辑模型），t2i 走 wan2.6-t2i；显式 model 优先。
        let model = model_or(req, default_model_for(&req.capability));
        match image_protocol(&model) {
            ImageProtocol::Wan27 => self.submit_image_v27(req, api_key, &model).await,
            ImageProtocol::Qwen => self.submit_image_qwen(req, api_key, &model).await,
            ImageProtocol::ZImage => self.submit_image_zimage(req, api_key).await,
            ImageProtocol::Wan26 => self.submit_image_v26(req, api_key, &model).await,
        }
    }

    /// wan2.6 图像（t2i / i2i）。
    async fn submit_image_v26(
        &self,
        req: &GenRequest,
        api_key: &str,
        model: &str,
    ) -> Result<TaskHandle, String> {
        let ar = req.aspect_ratio.as_deref().unwrap_or("1:1");
        // W/H 自定义（总像素 ≤2048²，官方 2.6 区间上限）优先，否则档位/官方推荐表。
        let size = custom_size_px(req, 2048 * 2048)
            .unwrap_or_else(|| wan_image_size(&req.capability, ar, req.quality.as_deref()));
        // 官方 n 上限 4（费用=单价×成功张数）。
        let n = req.n.clamp(1, 4);

        // 图像编辑模式（enable_interleave=false）必须 ≥1 张参考图。
        if req.capability == "i2i" && req.references.is_empty() {
            return Err("图生图（i2i）需要至少一张参考图".to_string());
        }

        // messages 结构分两种（实测 2026-08-05）：
        // - wan2.6-image（编辑模型）：独立对象 [{text}, {image}...]，单轮
        // - wan2.6-t2i（文生图模型对话式图生图）：多轮——图放前轮（user），
        //   中间补 assistant 回合（角色必须交替），末轮纯文本指令（最后一条消息不能含图）
        let messages = if req.capability == "i2i" && model == "wan2.6-t2i" {
            let img = req.references[0].clone();
            vec![
                json!({ "role": "user", "content": [ { "image": img } ] }),
                json!({ "role": "assistant", "content": [ { "text": "已收到图片" } ] }),
                json!({ "role": "user", "content": [ { "text": req.prompt } ] }),
            ]
        } else {
            let mut content = vec![json!({ "text": req.prompt })];
            if req.capability == "i2i" {
                for r in &req.references {
                    content.push(json!({ "image": r }));
                }
            }
            vec![json!({ "role": "user", "content": content })]
        };
        let mut params = json!({
            "size": size,
            "n": n,
            "prompt_extend": true,
            "watermark": false,
        });
        if let Some(np) = negative_prompt(req) {
            params["negative_prompt"] = json!(np);
        }
        if let Some(seed) = seed_param(req) {
            params["seed"] = json!(seed);
        }
        if let Some(wm) = watermark_param(req) {
            params["watermark"] = json!(wm);
        }
        let payload = json!({
            "model": model,
            "input": { "messages": messages },
            "parameters": params
        });
        self.post_image(api_key, payload).await
    }

    /// wan2.7-image(-pro)：文生图支持 4K（pro）、组图（enable_sequential）、多图参考 0-9 张。
    async fn submit_image_v27(
        &self,
        req: &GenRequest,
        api_key: &str,
        model: &str,
    ) -> Result<TaskHandle, String> {
        let ar = req.aspect_ratio.as_deref().unwrap_or("1:1");
        let quality = req.quality.as_deref().unwrap_or("2K");
        // 组图（enable_sequential）：一次请求 1-12 张（实际张数由模型决定，≤n）；
        // 单图模式：循环 n 次独立请求（n=1 每次，见 post_image 调用方语义）。
        let group = req.mode.as_deref() == Some("group");
        let n = req.n.clamp(1, if group { 12 } else { 4 });

        // 编辑/组图必须有参考图；多图参考官方上限 9 张（≤20MB）。
        if req.capability == "i2i" && req.references.is_empty() {
            return Err("图像编辑（i2i）需要至少一张参考图".to_string());
        }
        if req.references.len() > 9 {
            return Err("多图参考最多 9 张".to_string());
        }

        // size：W/H 自定义优先（pro 非组图文生图 ≤4096²，其余 ≤2048²）；
        // i2i 默认档位（输出比例跟最后一张输入图），t2i 默认像素串（比例 + 档位长边，16 倍数）。
        let max_px = if req.capability == "t2i" && model.contains("-pro") && !group {
            4096 * 4096
        } else {
            2048 * 2048
        };
        let size = custom_size_px(req, max_px).unwrap_or_else(|| {
            if req.capability == "i2i" {
                if quality == "1K" {
                    "1K".to_string()
                } else {
                    "2K".to_string()
                }
            } else {
                let k = match quality {
                    "1K" => 1024,
                    "4K" => 4096,
                    _ => 2048,
                };
                ratio_px(ar, k)
            }
        });

        let mut content = vec![json!({ "text": req.prompt })];
        for r in &req.references {
            content.push(json!({ "image": r }));
        }
        let mut params = json!({
            "size": size,
            "n": n,
            "watermark": false,
        });
        if group {
            params["enable_sequential"] = json!(true);
        }
        if let Some(seed) = seed_param(req) {
            params["seed"] = json!(seed);
        }
        if let Some(wm) = watermark_param(req) {
            params["watermark"] = json!(wm);
        }
        let payload = json!({
            "model": model,
            "input": { "messages": [ { "role": "user", "content": content } ] },
            "parameters": params
        });
        self.post_image(api_key, payload).await
    }

    /// 千问图像（qwen-image-*）：像素串 size、负向提示词、变体 n≤6（max/plus/image/edit 固定 1）。
    /// i2i 格式分两种：
    /// - max/plus/image：**单对象合并** [{text, image}]（实测 2026-08-05，content 长度必须为 1，仅单图参考）
    /// - 2.0 系列 / edit 系列：独立对象 [{text}, {image}...]（官方文档格式，参考 ≤3 张）
    ///
    /// qwen-image-edit（无后缀）不支持 size 参数。
    async fn submit_image_qwen(
        &self,
        req: &GenRequest,
        api_key: &str,
        model: &str,
    ) -> Result<TaskHandle, String> {
        // 合并格式（max/plus/image）：仅单图参考。
        let merged = matches!(model, "qwen-image" | "qwen-image-plus" | "qwen-image-max");
        if req.capability == "i2i" {
            if req.references.is_empty() {
                return Err("图生图（i2i）需要至少一张参考图".to_string());
            }
            if merged && req.references.len() > 1 {
                return Err("该模型图生图仅支持单张参考图".to_string());
            }
            if !merged && req.references.len() > 3 {
                return Err("千问图像编辑最多 3 张参考图".to_string());
            }
        }
        // 变体张数：2.0 系列 / edit-max / edit-plus 1-6；max/plus/image/edit 固定 1。
        let variable = matches!(
            model,
            "qwen-image-2.0-pro"
                | "qwen-image-2.0"
                | "qwen-image-edit-max"
                | "qwen-image-edit-plus"
        );
        let n = if variable { req.n.clamp(1, 6) } else { 1 };

        // size：W/H 自定义优先（≤2048²）；edit（无后缀）不支持 size；
        // max/plus/image 固定分辨率档；其余按画质档位 + 比例换算。
        let ar = req.aspect_ratio.as_deref().unwrap_or("1:1");
        let size = if model == "qwen-image-edit" {
            None
        } else if merged {
            Some(qwen_legacy_size(ar).to_string())
        } else {
            let k = if req.quality.as_deref() == Some("1K") {
                1024
            } else {
                2048
            };
            Some(custom_size_px(req, 2048 * 2048).unwrap_or_else(|| ratio_px(ar, k)))
        };

        let content = if merged && req.capability == "i2i" {
            let img = &req.references[0];
            vec![json!({ "text": req.prompt, "image": img })]
        } else {
            let mut c = vec![json!({ "text": req.prompt })];
            for r in &req.references {
                c.push(json!({ "image": r }));
            }
            c
        };
        let mut params = json!({
            "n": n,
            "prompt_extend": true,
            "watermark": false,
        });
        if let Some(s) = size {
            params["size"] = json!(s);
        }
        if let Some(np) = negative_prompt(req) {
            params["negative_prompt"] = json!(np);
        }
        if let Some(seed) = seed_param(req) {
            params["seed"] = json!(seed);
        }
        if let Some(wm) = watermark_param(req) {
            params["watermark"] = json!(wm);
        }
        let payload = json!({
            "model": model,
            "input": { "messages": [ { "role": "user", "content": content } ] },
            "parameters": params
        });
        self.post_image(api_key, payload).await
    }

    /// z-image-turbo：像素串 size；无 watermark / n（固定 1）/ negative_prompt；
    /// prompt_extend 默认 false（不传）；响应 content 含 {image} 与 {text} 双对象（解析按 image 提取）。
    /// 图生图（实测 2026-08-05）：content 为**单对象合并**格式 [{ text, image }]（与万相/千问的
    /// 独立 {text} + {image} 对象不同），仅支持单图参考；纯文生图时为 [{ text }]。
    async fn submit_image_zimage(
        &self,
        req: &GenRequest,
        api_key: &str,
    ) -> Result<TaskHandle, String> {
        let ar = req.aspect_ratio.as_deref().unwrap_or("1:1");
        let k = if req.quality.as_deref() == Some("2K") {
            2048
        } else {
            1024
        };
        let size = custom_size_px(req, 2048 * 2048).unwrap_or_else(|| ratio_px(ar, k));
        let content = if req.capability == "i2i" {
            let img = req
                .references
                .first()
                .ok_or_else(|| "图生图（i2i）需要至少一张参考图".to_string())?;
            vec![json!({ "text": req.prompt, "image": img })]
        } else {
            vec![json!({ "text": req.prompt })]
        };
        let mut params = json!({ "size": size });
        if let Some(seed) = seed_param(req) {
            params["seed"] = json!(seed);
        }
        let payload = json!({
            "model": "z-image-turbo",
            "input": { "messages": [ { "role": "user", "content": content } ] },
            "parameters": params
        });
        self.post_image(api_key, payload).await
    }

    /// 图像同步请求 + 响应解析（2.6/2.7/千问/z-image 共用）：
    /// POST multimodal-generation → 错误体 {code,message} → output.choices[].message.content[].image。
    async fn post_image(
        &self,
        api_key: &str,
        payload: serde_json::Value,
    ) -> Result<TaskHandle, String> {
        let url = format!(
            "{}/api/v1/services/aigc/multimodal-generation/generation",
            base_url().await
        );
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
        // 错误体 { code, message }
        if let Some(code) = v.get("code").and_then(|c| c.as_str()) {
            if !code.is_empty() && code != "0" {
                let msg = v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or(code)
                    .to_string();
                return Ok(TaskHandle {
                    task_id: String::new(),
                    phase: TaskPhase::Failed,
                    remote_urls: vec![],
                    error: Some(msg),
                    http_log: vec![record],
                });
            }
        }
        // 提取 output.choices[].message.content[].image（组图：同数组多张 image）
        let mut urls = Vec::new();
        if let Some(choices) = v
            .get("output")
            .and_then(|o| o.get("choices"))
            .and_then(|c| c.as_array())
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
                task_id: String::new(),
                phase: TaskPhase::Failed,
                remote_urls: vec![],
                error: Some(format!("响应未包含图片 URL: {}", body)),
                http_log: vec![record],
            });
        }
        Ok(TaskHandle {
            task_id: String::new(),
            phase: TaskPhase::Succeeded,
            remote_urls: urls,
            error: None,
            http_log: vec![record],
        })
    }

    async fn submit_video(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String> {
        // t2v 走 wan2.7-t2v，i2v 必须走 wan2.7-i2v 系列（t2v 不接受 media）；显式 model 优先。
        let model = model_or(req, default_model_for(&req.capability));
        // 2.7 视频 resolution 仅 720P/1080P，非法档位回退默认 1080P。
        let resolution = match req.quality.as_deref() {
            Some("720P") => "720P",
            _ => "1080P",
        };
        // duration [2,15] 整数（按秒计费）。
        let duration: i64 = req
            .duration
            .as_deref()
            .and_then(|d| d.parse::<i64>().ok())
            .map(|d| d.clamp(2, 15))
            .unwrap_or(5);

        // media 结构：i2v 追加 first_frame（首尾帧/驱动音频/视频续写待 UI 支持）。
        if req.capability == "i2v" && req.references.is_empty() {
            return Err("i2v 需要首帧参考图".to_string());
        }
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
        if let Some(np) = negative_prompt(req) {
            input["negative_prompt"] = json!(np);
        }

        // t2v 独有 ratio（画幅枚举）；i2v 画幅由素材决定，无该参数。
        let mut params = json!({
            "resolution": resolution,
            "duration": duration,
            "prompt_extend": true,
        });
        if req.capability == "t2v" {
            params["ratio"] = json!(match req.aspect_ratio.as_deref() {
                Some("9:16") => "9:16",
                Some("1:1") => "1:1",
                Some("4:3") => "4:3",
                Some("3:4") => "3:4",
                _ => "16:9",
            });
        }
        if let Some(seed) = seed_param(req) {
            params["seed"] = json!(seed);
        }
        if let Some(wm) = watermark_param(req) {
            params["watermark"] = json!(wm);
        }
        let payload = json!({
            "model": model,
            "input": input,
            "parameters": params
        });

        let url = format!(
            "{}/api/v1/services/aigc/video-generation/video-synthesis",
            base_url().await
        );
        let resp = self
            .client
            .post(&url)
            .header("X-DashScope-Async", "enable") // 异步必加，否则报同步不支持
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
        if let Some(code) = v.get("code").and_then(|c| c.as_str()) {
            if !code.is_empty() && code != "0" {
                let msg = v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or(code)
                    .to_string();
                return Ok(TaskHandle {
                    task_id: String::new(),
                    phase: TaskPhase::Failed,
                    remote_urls: vec![],
                    error: Some(msg),
                    http_log: vec![record],
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
            task_id,
            phase: TaskPhase::Submitted,
            remote_urls: vec![],
            error: None,
            http_log: vec![record],
        })
    }
}
