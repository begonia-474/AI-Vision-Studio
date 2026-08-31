use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::json;

use crate::models::{
    GenRequest, HttpRecord, LayerMetaDto, ProviderInfoDto, TaskHandle, TaskPhase, TaskSnapshot,
};
use crate::providers::{sanitize_body, GenerationProvider};

/// 火山方舟 豆包 Seedream/Seedance 适配器（对照 docs/model-api 官方文档实查 2026.08）。
/// baseUrl: https://ark.cn-beijing.volces.com/api/v3
/// 鉴权: Authorization: Bearer $ARK_API_KEY
///
/// 图像 t2i/i2i（同步）: POST /images/generations → data[].url（24h 有效）
///   - 无 `n` 参数：多图走 `sequential_image_generation:"auto"` + `max_images`（仅 4.5/4.0/lite；5.0 pro 单图）
///   - 组图 i2i 须满足「参考图数 + max_images ≤ 15」，后端按请求内参考图数收敛
///   - `size` 用方式2 像素串，按 model+quality+ratio 取官方 1K/1.5K/2K/3K/4K 像素表
///   - 自定义 W/H 必须同时满足总像素区间与宽高比 [1/16, 16]，非法尺寸显式报错，不静默回退
///   - 5.0 pro 支持 `optimize_prompt_options`（standard/fast）与 `background`（仅 i2i 单参考图）
///   - 5.0 lite 支持 `tools=[{type:"web_search"}]` 联网搜索
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

/// 行为模板 id：用户自添加模型按 template_model_id 继承内置模型规格，
/// 缺省回退到请求 model（内置模型两者一致）。后续所有模型能力判断都用它，
/// 不再用 model 字符串启发式（自定义 model id 不含 "5-0-pro" 会误判）。
fn profile_model_id<'a>(model: &'a str, template_model_id: Option<&'a str>) -> &'a str {
    template_model_id
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(model)
}

fn is_seedream_pro(profile: &str) -> bool {
    profile.contains("5-0-pro")
}

fn is_seedream_5_0(profile: &str) -> bool {
    profile.contains("5-0")
}

/// 提示词优化 standard/fast：5.0 pro 与 4.0 支持；5.0 lite / 4.5 仅默认 standard。
fn supports_prompt_optimizer(profile: &str) -> bool {
    is_seedream_pro(profile) || profile.contains("4-0")
}

/// 是否支持组图（sequential_image_generation）。5.0 pro 仅单图；4.5/4.0/lite 支持。
fn supports_sequential(profile: &str) -> bool {
    !is_seedream_pro(profile)
}

/// 各模型方式2 总像素区间（官方规格）：
///   - 5.0 pro:  [921600, 4624220]
///   - 5.0 lite: [3686400, 16777216]
///   - 4.5:      [3686400, 16777216]
///   - 4.0:      [921600, 16777216]
fn total_pixel_bounds(profile: &str) -> (u64, u64) {
    if is_seedream_pro(profile) {
        (921_600, 4_624_220)
    } else if profile.contains("4-0") {
        (921_600, 16_777_216)
    } else {
        // 5.0 lite / 4.5
        (3_686_400, 16_777_216)
    }
}

/// 自定义 W/H 是否同时满足官方总像素区间与宽高比 [1/16, 16]。
/// 不合法返回 Err（中文可读）——此前静默回退到官方像素表，params_json 记录的原值
/// 与实际生成尺寸不一致，重新编辑时产生误导。
fn validate_custom_size(profile: &str, w: u64, h: u64) -> Result<(), String> {
    let total = w.saturating_mul(h);
    let (lo, hi) = total_pixel_bounds(profile);
    if total < lo || total > hi {
        return Err(format!(
            "自定义尺寸 {w}x{h} 总像素不符合该模型区间 [{lo}, {hi}]"
        ));
    }
    let ratio = w as f64 / h as f64;
    if !(1.0 / 16.0..=16.0).contains(&ratio) {
        return Err(format!("自定义尺寸 {w}x{h} 宽高比需在 [1/16, 16] 范围内"));
    }
    Ok(())
}

/// 图像 size 像素串：请求必须携带方式2 像素串（前端始终下发官方表或用户自定义 W/H），
/// 解析后校验总像素与宽高比，不合法直接报错；custom 缺省时按 profile+quality+ratio 取官方像素表。
fn volcark_image_size(
    profile: &str,
    quality: &str,
    ar: &str,
    custom: Option<&str>,
) -> Result<String, String> {
    if let Some(px) = custom {
        if let Some((w, h)) = px.split_once('x') {
            if let (Ok(w), Ok(h)) = (w.parse::<u64>(), h.parse::<u64>()) {
                validate_custom_size(profile, w, h)?;
                return Ok(format!("{w}x{h}"));
            }
        }
        return Err(format!("尺寸参数格式应为 WxH，收到: {px}"));
    }
    // 5.0 pro 独立像素表（与 lite/4.5/4.0 不同：如 2K 16:9 pro=2816x1584 vs lite=2848x1600）
    if is_seedream_pro(profile) {
        return Ok(match quality {
            "1K" => match ar {
                "1:1" => "1024x1024",
                "4:3" => "1152x864",
                "3:4" => "864x1152",
                "16:9" => "1424x800",
                "9:16" => "800x1424",
                "3:2" => "1248x832",
                "2:3" => "832x1248",
                "21:9" => "1568x672",
                "9:21" => "672x1568",
                _ => "1024x1024",
            },
            "1.5K" => match ar {
                "1:1" => "1536x1536",
                "4:3" => "1792x1344",
                "3:4" => "1344x1792",
                "16:9" => "2048x1152",
                "9:16" => "1152x2048",
                "3:2" => "1872x1248",
                "2:3" => "1248x1872",
                "21:9" => "2352x1008",
                "9:21" => "1008x2352",
                _ => "1536x1536",
            },
            // 2K（默认）
            _ => match ar {
                "1:1" => "2048x2048",
                "4:3" => "2368x1776",
                "3:4" => "1776x2368",
                "16:9" => "2816x1584",
                "9:16" => "1584x2816",
                "3:2" => "2496x1664",
                "2:3" => "1664x2496",
                "21:9" => "3136x1344",
                "9:21" => "1344x3136",
                _ => "2048x2048",
            },
        }
        .to_string());
    }
    // 5.0 lite / 4.5 / 4.0 共用像素表
    Ok(match quality {
        "4K" => match ar {
            "1:1" => "4096x4096",
            "4:3" => "4704x3520",
            "3:4" => "3520x4704",
            "16:9" => "5504x3040",
            "9:16" => "3040x5504",
            "3:2" => "4992x3328",
            "2:3" => "3328x4992",
            "21:9" => "6240x2656",
            "9:21" => "2656x6240",
            _ => "4096x4096",
        },
        "3K" => match ar {
            "1:1" => "3072x3072",
            "4:3" => "3456x2592",
            "3:4" => "2592x3456",
            "16:9" => "4096x2304",
            "9:16" => "2304x4096",
            "3:2" => "3744x2496",
            "2:3" => "2496x3744",
            "21:9" => "4704x2016",
            "9:21" => "2016x4704",
            _ => "3072x3072",
        },
        "1K" => match ar {
            "1:1" => "1024x1024",
            "4:3" => "1152x864",
            "3:4" => "864x1152",
            "16:9" => "1280x720",
            "9:16" => "720x1280",
            "3:2" => "1248x832",
            "2:3" => "832x1248",
            "21:9" => "1512x648",
            "9:21" => "648x1512",
            _ => "1024x1024",
        },
        // 2K（默认）
        _ => match ar {
            "1:1" => "2048x2048",
            "4:3" => "2304x1728",
            "3:4" => "1728x2304",
            "16:9" => "2848x1600",
            "9:16" => "1600x2848",
            "3:2" => "2496x1664",
            "2:3" => "1664x2496",
            "21:9" => "3136x1344",
            "9:21" => "1344x3136",
            _ => "2048x2048",
        },
    }
    .to_string())
}

/// 从图层拆分响应体解析图层元数据（仅含 URL 与 z_index 的成功项），
/// 按 z_index 升序返回，与 `image_generate_once` 排序后的 URL 顺序对齐。
/// 非图层响应返回 None。审计#19：commands 层不再直调此函数，
/// 改经 trait 方法 `GenerationProvider::parse_layer_metas` 调用。
fn parse_layer_metas_from_body(body: &str) -> Option<Vec<LayerMetaDto>> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let data = v.get("data")?.as_array()?;
    let mut metas: Vec<LayerMetaDto> = Vec::new();
    for item in data {
        if item.get("url").and_then(|u| u.as_str()).is_none() {
            continue;
        }
        let z_index = item.get("z_index").and_then(|z| z.as_i64());
        if z_index.is_none() {
            continue;
        }
        metas.push(LayerMetaDto {
            z_index,
            name: item
                .get("name")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string()),
            description: item
                .get("description")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string()),
            bounding_box_absolute: item
                .get("bounding_box")
                .and_then(|b| b.get("absolute"))
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_i64()).collect()),
            bounding_box_normalized: item
                .get("bounding_box")
                .and_then(|b| b.get("normalized"))
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_i64()).collect()),
        });
    }
    if metas.is_empty() {
        return None;
    }
    metas.sort_by_key(|m| m.z_index.unwrap_or(0));
    Some(metas)
}

#[async_trait]
impl GenerationProvider for VolcArkProvider {
    fn default_model(&self) -> &str {
        DEFAULT_IMAGE_MODEL
    }

    /// 审计#19：图层拆分元数据解析下沉到 trait 覆写（委托模块级解析函数），
    /// commands 层不再直调 volcark::parse_layer_metas_from_body。
    fn parse_layer_metas(&self, body: &str) -> Option<Vec<LayerMetaDto>> {
        parse_layer_metas_from_body(body)
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
        // 用户自添加模型继承模板规格（自定义 model id 可能不含任何 Seedream 版本特征）。
        let profile = profile_model_id(&model, req.template_model_id.as_deref());
        let ar = req.aspect_ratio.as_deref().unwrap_or("1:1");
        let quality = req.quality.as_deref().unwrap_or("2K");
        let custom_size = (!req.size.trim().is_empty()).then_some(req.size.as_str());
        let size = volcark_image_size(profile, quality, ar, custom_size)?;

        // 参考图数量上限（官方规格）：pro 10 张，其余 Seedream 图像模型 14 张。
        if req.capability == "i2i" {
            let max_refs = if is_seedream_pro(profile) { 10 } else { 14 };
            if req.references.is_empty() {
                return Err("i2i 需要至少 1 张参考图".to_string());
            }
            if req.references.len() > max_refs {
                return Err(format!("参考图数量超过该模型上限（{} 张）", max_refs));
            }
        }

        // 图层拆分：仅 5.0 pro、图生图、单参考图；与透明背景互斥。
        let layer = req.layer_decomposition == Some(true);
        if layer {
            if !is_seedream_pro(profile) {
                return Err("图层拆分仅 Seedream 5.0 pro 支持".to_string());
            }
            if req.capability != "i2i" || req.references.len() != 1 {
                return Err("图层拆分模式仅支持 1 张参考图的图生图".to_string());
            }
            if req.background.as_deref() == Some("transparent") {
                return Err("图层拆分模式与透明背景模式互斥".to_string());
            }
        }

        let want_n = if layer { 1 } else { req.n.max(1) as usize };
        // 组图模式（mode=group 且模型支持）：一次请求 sequential auto + max_images（一组关联图）；
        // 单图模式（默认，含 5.0 pro）：官方 API 无 n 参数，同样参数**并行**请求，每张图一个独立请求
        // （哩布行为：N 张 = N 次请求，计费 N 份），全部归入同一任务。
        // 组图上限：t2i ≤15；i2i 须满足「参考图数 + max_images ≤ 15」。
        let group = !layer
            && req.mode.as_deref() == Some("group")
            && want_n > 1
            && supports_sequential(profile);
        let group_cap = if req.capability == "i2i" {
            15usize.saturating_sub(req.references.len()).max(1)
        } else {
            15
        };
        let max_images = if group { want_n.min(group_cap) } else { want_n };
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
            if is_seedream_5_0(profile) && (fmt == "png" || fmt == "jpeg") {
                payload["output_format"] = json!(fmt);
            }
        }
        // 提示词优化：5.0 pro / 4.0 支持 standard/fast；lite / 4.5 仅默认 standard。
        if let Some(mode) = req.optimize_prompt_mode.as_deref() {
            if !supports_prompt_optimizer(profile) {
                return Err("提示词优化模式仅 Seedream 5.0 pro / 4.0 支持".to_string());
            }
            if mode != "standard" && mode != "fast" {
                return Err(format!(
                    "提示词优化模式取值应为 standard / fast，收到: {mode}"
                ));
            }
            payload["optimize_prompt_options"] = json!({ "mode": mode });
        }
        // 透明背景：仅 5.0 pro 图生图、单参考图；透明模式只能输出 png。
        if let Some(bg) = req.background.as_deref() {
            if bg != "opaque" && bg != "transparent" {
                return Err(format!(
                    "background 取值应为 opaque / transparent，收到: {bg}"
                ));
            }
            if !is_seedream_pro(profile) {
                return Err("透明通道参数仅 Seedream 5.0 pro 支持".to_string());
            }
            if bg == "transparent" {
                if req.capability != "i2i" || req.references.len() != 1 {
                    return Err("透明背景模式仅支持 1 张参考图的图生图".to_string());
                }
                if req.output_format.as_deref() == Some("jpeg") {
                    return Err("透明背景模式不支持 jpeg，请改用 png".to_string());
                }
                // 官方默认 jpeg，透明模式必须显式 png（前端默认会同步切换，此处兜底）。
                payload["output_format"] = json!("png");
                payload["background"] = json!("transparent");
            }
        }
        // 联网搜索：仅 5.0 lite（pro / 4.5 / 4.0 官方均不支持）。
        if req.web_search == Some(true) {
            if !is_seedream_5_0(profile) || is_seedream_pro(profile) {
                return Err("联网搜索仅 Seedream 5.0 lite 支持".to_string());
            }
            payload["tools"] = json!([{ "type": "web_search" }]);
        }
        // i2i：image[] 接受 data:image/...;base64, 或 https URL
        if req.capability == "i2i" {
            payload["image"] = json!(req.references);
        }
        if layer {
            payload["layer_decomposition"] = json!(true);
        }
        if group {
            payload["sequential_image_generation"] = json!("auto");
            payload["sequential_image_generation_options"] = json!({ "max_images": max_images });
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
        let mut entries: Vec<(Option<i64>, String)> = Vec::new();
        if let Some(data) = v.get("data").and_then(|d| d.as_array()) {
            for item in data {
                // 单图错误 data.error 不中断其余图，跳过失败项
                if item.get("error").is_some_and(|e| !e.is_null()) {
                    continue;
                }
                let z_index = item.get("z_index").and_then(|z| z.as_i64());
                if let Some(u) = item.get("url").and_then(|u| u.as_str()) {
                    entries.push((z_index, u.to_string()));
                } else if let Some(b64) = item.get("b64_json").and_then(|b| b.as_str()) {
                    entries.push((z_index, format!("data:image/png;base64,{}", b64)));
                }
            }
        }
        if entries.is_empty() {
            return Err("响应未包含图片 URL".to_string());
        }
        // 图层拆分响应包含 z_index 时按叠放顺序升序（底图 0 → 图层 1..n），
        // 保证下载产物顺序与 parse_layer_metas_from_body 的元数据顺序一致。
        if entries.iter().any(|(z, _)| z.is_some()) {
            entries.sort_by_key(|(z, _)| z.unwrap_or(i64::MAX));
        }
        let urls: Vec<String> = entries.into_iter().map(|(_, u)| u).collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pro_has_15k_pixel_table() {
        let size =
            volcark_image_size("doubao-seedream-5-0-pro-260628", "1.5K", "16:9", None).unwrap();
        assert_eq!(size, "2048x1152");
        let size =
            volcark_image_size("doubao-seedream-5-0-pro-260628", "1.5K", "3:4", None).unwrap();
        assert_eq!(size, "1344x1792");
    }

    #[test]
    fn custom_size_rejects_bad_ratio() {
        // 总像素恰在区间下界，但宽高比 4096/225≈18.2 超出 [1/16, 16]
        let err = volcark_image_size(
            "doubao-seedream-5-0-pro-260628",
            "2K",
            "1:1",
            Some("4096x225"),
        )
        .unwrap_err();
        assert!(err.contains("宽高比"), "{err}");
    }

    #[test]
    fn custom_size_rejects_bad_total_pixels() {
        let err = volcark_image_size(
            "doubao-seedream-5-0-pro-260628",
            "2K",
            "1:1",
            Some("512x512"),
        )
        .unwrap_err();
        assert!(err.contains("总像素"), "{err}");
    }

    #[test]
    fn custom_model_inherits_pro_profile_via_template_id() {
        // 自添加模型 id 不含 "5-0-pro"，但模板 id 指定为 pro → 走 pro 像素区间/表格
        let profile = profile_model_id("my-custom-vision", Some("doubao-seedream-5-0-pro-260628"));
        assert!(is_seedream_pro(profile));
        assert!(!supports_sequential(profile));
        let size = volcark_image_size(profile, "1.5K", "9:16", None).unwrap();
        assert_eq!(size, "1152x2048");
    }

    #[test]
    fn prompt_optimizer_only_for_pro_and_4_0() {
        assert!(supports_prompt_optimizer("doubao-seedream-5-0-pro-260628"));
        assert!(supports_prompt_optimizer("doubao-seedream-4-0-250828"));
        assert!(!supports_prompt_optimizer("doubao-seedream-5-0-260128"));
        assert!(!supports_prompt_optimizer("doubao-seedream-4-5-251128"));
    }

    #[test]
    fn parses_layer_metas_and_sorts_by_z_index() {
        let body = r#"{
            "model": "doubao-seedream-5-0-pro-260628",
            "data": [
                {
                    "url": "https://example.com/layer-2.png",
                    "size": "492x98",
                    "output_format": "png",
                    "z_index": 2,
                    "bounding_box": {
                        "absolute": [140, 451, 631, 548],
                        "normalized": [68, 220, 308, 268]
                    },
                    "name": "左上角标语文字",
                    "description": "白色两行文字"
                },
                {
                    "url": "https://example.com/base.jpeg",
                    "size": "2048x2048",
                    "output_format": "jpeg",
                    "z_index": 0
                }
            ]
        }"#;
        let metas = parse_layer_metas_from_body(body).expect("应解析出图层元数据");
        assert_eq!(metas.len(), 2);
        assert_eq!(metas[0].z_index, Some(0));
        assert_eq!(metas[1].z_index, Some(2));
        assert_eq!(metas[1].name.as_deref(), Some("左上角标语文字"));
        assert_eq!(
            metas[1].bounding_box_normalized.as_deref(),
            Some(&[68, 220, 308, 268][..])
        );
    }
}
