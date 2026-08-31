//! 内置模型注册表 —— 领域数据唯一事实源。
//! 原前端 src/models/registry.ts 的内置模型字面量、官方像素表与尺寸换算规则下沉至此。
//! 前端经 `list_builtin_models` 命令一次性拉取（builtin_registry），启动时缓存；
//! 本模块纯数据 + 纯函数，无 IO，是「渲染期同步函数无法 await IPC」约束下仍下沉到
//! Rust 的领域数据（前端只保留对缓存数据做查表/滑杆上限的薄函数）。

use serde_json::json;

use crate::models::{
    BuiltinModelDto, BuiltinRegistryDto, CustomConfigDto, ParamKind, ParamSectionDto, PxBoundsDto,
    SizeEntryDto, Studio,
};

// —— 辅助构建 ——

fn seg(key: &'static str, title: &'static str) -> ParamSectionDto {
    ParamSectionDto::Segmented {
        key: key.to_string(),
        title: title.to_string(),
        options: None,
        i18n: None,
        visible: None,
    }
}

fn seg_opts(
    key: &'static str,
    title: &'static str,
    options: &[&str],
    i18n: bool,
) -> ParamSectionDto {
    ParamSectionDto::Segmented {
        key: key.to_string(),
        title: title.to_string(),
        options: Some(options.iter().map(|s| s.to_string()).collect()),
        i18n: Some(i18n),
        visible: None,
    }
}

fn seg_i2i(
    key: &'static str,
    title: &'static str,
    options: &[&str],
    i18n: bool,
) -> ParamSectionDto {
    ParamSectionDto::Segmented {
        key: key.to_string(),
        title: title.to_string(),
        options: Some(options.iter().map(|s| s.to_string()).collect()),
        i18n: Some(i18n),
        visible: Some("i2i".to_string()),
    }
}

fn ratio_size(key: &'static str, title: &'static str) -> ParamSectionDto {
    ParamSectionDto::Ratio {
        key: key.to_string(),
        title: title.to_string(),
        options: None,
        size: Some(true),
    }
}

fn param_num(key: &'static str, title: &'static str, def: &str) -> ParamSectionDto {
    ParamSectionDto::Param {
        key: key.to_string(),
        title: title.to_string(),
        kind: ParamKind::Number,
        def: Some(def.to_string()),
    }
}

fn param_text(key: &'static str, title: &'static str) -> ParamSectionDto {
    ParamSectionDto::Param {
        key: key.to_string(),
        title: title.to_string(),
        kind: ParamKind::Text,
        def: Some(String::new()),
    }
}

// —— 像素表（volcark Seedream 官方表；对照 docs/model-api 图片生成 API 方式1 映射表）——
// 5.0 pro 独立（1K/1.5K/2K）；lite/4.5/4.0 共用（1K/2K/3K/4K）。
// 9:21 文档无直给值，取 21:9 转置（总像素合规，见 pixel_bounds）。
const PRO_PX: &[(&str, &str, &str)] = &[
    ("1K", "1:1", "1024x1024"),
    ("1K", "4:3", "1152x864"),
    ("1K", "3:4", "864x1152"),
    ("1K", "16:9", "1424x800"),
    ("1K", "9:16", "800x1424"),
    ("1K", "3:2", "1248x832"),
    ("1K", "2:3", "832x1248"),
    ("1K", "21:9", "1568x672"),
    ("1K", "9:21", "672x1568"),
    ("1.5K", "1:1", "1536x1536"),
    ("1.5K", "4:3", "1792x1344"),
    ("1.5K", "3:4", "1344x1792"),
    ("1.5K", "16:9", "2048x1152"),
    ("1.5K", "9:16", "1152x2048"),
    ("1.5K", "3:2", "1872x1248"),
    ("1.5K", "2:3", "1248x1872"),
    ("1.5K", "21:9", "2352x1008"),
    ("1.5K", "9:21", "1008x2352"),
    ("2K", "1:1", "2048x2048"),
    ("2K", "4:3", "2368x1776"),
    ("2K", "3:4", "1776x2368"),
    ("2K", "16:9", "2816x1584"),
    ("2K", "9:16", "1584x2816"),
    ("2K", "3:2", "2496x1664"),
    ("2K", "2:3", "1664x2496"),
    ("2K", "21:9", "3136x1344"),
    ("2K", "9:21", "1344x3136"),
];

const COMMON_PX: &[(&str, &str, &str)] = &[
    ("1K", "1:1", "1024x1024"),
    ("1K", "4:3", "1152x864"),
    ("1K", "3:4", "864x1152"),
    ("1K", "16:9", "1280x720"),
    ("1K", "9:16", "720x1280"),
    ("1K", "3:2", "1248x832"),
    ("1K", "2:3", "832x1248"),
    ("1K", "21:9", "1512x648"),
    ("1K", "9:21", "648x1512"),
    ("2K", "1:1", "2048x2048"),
    ("2K", "4:3", "2304x1728"),
    ("2K", "3:4", "1728x2304"),
    ("2K", "16:9", "2848x1600"),
    ("2K", "9:16", "1600x2848"),
    ("2K", "3:2", "2496x1664"),
    ("2K", "2:3", "1664x2496"),
    ("2K", "21:9", "3136x1344"),
    ("2K", "9:21", "1344x3136"),
    ("3K", "1:1", "3072x3072"),
    ("3K", "4:3", "3456x2592"),
    ("3K", "3:4", "2592x3456"),
    ("3K", "16:9", "4096x2304"),
    ("3K", "9:16", "2304x4096"),
    ("3K", "3:2", "3744x2496"),
    ("3K", "2:3", "2496x3744"),
    ("3K", "21:9", "4704x2016"),
    ("3K", "9:21", "2016x4704"),
    ("4K", "1:1", "4096x4096"),
    ("4K", "4:3", "4704x3520"),
    ("4K", "3:4", "3520x4704"),
    ("4K", "16:9", "5504x3040"),
    ("4K", "9:16", "3040x5504"),
    ("4K", "3:2", "4992x3328"),
    ("4K", "2:3", "3328x4992"),
    ("4K", "21:9", "6240x2656"),
    ("4K", "9:21", "2656x6240"),
];

fn volcark_px(profile: &str, quality: &str, ar: &str) -> Option<&'static str> {
    let table = if profile.contains("5-0-pro") {
        PRO_PX
    } else {
        COMMON_PX
    };
    table
        .iter()
        .find(|(q, r, _)| *q == quality && *r == ar)
        .map(|(_, _, px)| *px)
}

/// 比例 → 像素串（"WxH"）：长边 = k，短边按比例向下取 16 倍数（与后端 ratio_px 算法一致）。
fn px_by_ratio(ar: &str, k: i64) -> String {
    let Some((a, b)) = parse_ratio(ar) else {
        return format!("{k}x{k}");
    };
    if a <= 0 || b <= 0 {
        return format!("{k}x{k}");
    }
    let short = (((k * a.min(b)) / a.max(b)) / 16) * 16;
    let short = short.max(16);
    if a >= b {
        format!("{k}x{short}")
    } else {
        format!("{short}x{k}")
    }
}

fn parse_ratio(ar: &str) -> Option<(i64, i64)> {
    let (a, b) = ar.split_once(':')?;
    let a: i64 = a.trim().parse().ok()?;
    let b: i64 = b.trim().parse().ok()?;
    Some((a, b))
}

/// 魔搭模型分辨率上限（长边 px）：FLUX 家族 1024；Qwen-Image（2512 前）1664；其余 2048。
fn ms_max(model_id: &str) -> i64 {
    if model_id.starts_with("black-forest-labs") {
        1024
    } else if model_id == "Qwen/Qwen-Image" {
        1664
    } else {
        2048
    }
}

/// 比例 → 原厂 size 串（占位卡展示与自定义尺寸回退基准）。
/// volcark(Seedream)：方式2 像素 `宽x高`，按 model+quality+ratio 查官方表（5.0 pro 与
/// lite/4.5/4.0 表不同），profileId 为模板模型 id（用户自添加模型继承模板像素机制）；
/// wanxiang（万相/千问/z-image）：像素串按画质档位长边换算（pro 文生图支持 4K）；
/// modelscope：长边 = 模型上限；其余厂商不读 size 字段，回退为比例原值占位。
pub fn aspect_to_size(
    provider_id: &str,
    model_id: &str,
    ar: &str,
    quality: Option<&str>,
    profile_id: Option<&str>,
) -> String {
    match provider_id {
        "wanxiang" => {
            let q = quality.unwrap_or("2K");
            let k = if model_id.starts_with("wan2.7-image-pro") && q == "4K" {
                4096
            } else if model_id.starts_with("wan2.7-image") && q == "1K" {
                1024
            } else if model_id == "wan2.6-t2i" {
                1280 // 官方推荐基准档
            } else if model_id == "wan2.6-image" {
                if q == "2K" {
                    2048
                } else {
                    1024
                }
            } else if model_id.starts_with("qwen-image") {
                if q == "1K" {
                    1024
                } else {
                    2048
                }
            } else if model_id.starts_with("z-image") {
                if q == "2K" {
                    2048
                } else {
                    1024
                }
            } else if q == "1K" {
                1024
            } else {
                2048
            };
            px_by_ratio(ar, k)
        }
        "modelscope" => px_by_ratio(ar, ms_max(model_id)),
        "volcark" => {
            let q = quality.unwrap_or("2K");
            let profile = profile_id.unwrap_or(model_id);
            volcark_px(profile, q, ar)
                .or_else(|| volcark_px(profile, "2K", ar))
                .unwrap_or("2048x2048")
                .to_string()
        }
        _ => ar.to_string(),
    }
}

/// 全 (quality × ratio) → 像素串 组合，随模型下发（前端直接查表，不再重算规则）。
fn build_size_table(m: &BuiltinModelDto) -> Vec<SizeEntryDto> {
    let quals = if m.qualities.is_empty() {
        vec!["2K".to_string()]
    } else {
        m.qualities.clone()
    };
    let mut out = Vec::with_capacity(quals.len() * m.aspect_ratios.len());
    for q in &quals {
        for ar in &m.aspect_ratios {
            out.push(SizeEntryDto {
                quality: q.clone(),
                ratio: ar.clone(),
                px: aspect_to_size(
                    &m.provider_id,
                    &m.id,
                    ar,
                    Some(q),
                    m.template_model_id.as_deref(),
                ),
            });
        }
    }
    out
}

/// W/H 自定义尺寸总像素区间：
/// 用户自添加模型通用 [512², 4096²]；volcark 官方区间：pro [921600, 4624220]，
/// 5.0 lite/4.5 [3686400, 16777216]，4.0 [921600, 16777216]；
/// wanxiang：qwen/z-image [512², 2048²]，其余 [768², 2048²]（wan2.7-image-pro 4K 放宽到 [768², 4096²]）。
pub fn pixel_bounds(m: &BuiltinModelDto) -> PxBoundsDto {
    if m.custom.is_some() {
        let max = if m.provider_id == "modelscope" {
            ms_max(&m.id)
        } else {
            4096
        };
        return PxBoundsDto {
            min: 512.0 * 512.0,
            max: (max * max) as f64,
        };
    }
    if m.provider_id == "wanxiang" {
        let min = if m.id.starts_with("qwen") || m.id.starts_with("z-") {
            512.0 * 512.0
        } else {
            768.0 * 768.0
        };
        let max = if m.id == "wan2.7-image-pro" {
            4096.0 * 4096.0
        } else {
            2048.0 * 2048.0
        };
        return PxBoundsDto { min, max };
    }
    let profile = m.template_model_id.as_deref().unwrap_or(&m.id);
    if profile.contains("5-0-pro") {
        PxBoundsDto {
            min: 921600.0,
            max: 4624220.0,
        }
    } else if profile.contains("4-0") {
        PxBoundsDto {
            min: 921600.0,
            max: 16777216.0,
        }
    } else {
        // 5.0 lite / 4.5
        PxBoundsDto {
            min: 3686400.0,
            max: 16777216.0,
        }
    }
}

/// W/H 自定义尺寸宽高比区间；volcark 官方要求 [1/16, 16]，其余厂商无此限制（null）。
pub fn pixel_ratio_bounds(provider_id: &str) -> Option<PxBoundsDto> {
    if provider_id == "volcark" {
        Some(PxBoundsDto {
            min: 1.0 / 16.0,
            max: 16.0,
        })
    } else {
        None
    }
}

/// 张数区上限（滑杆约束）：单图模式按 max_images（qwen 变体 6）或 maxRef 收敛（≤4）；
/// 组图模式按 maxBatch；volcark Seedream lite/4.5/4.0 官方上限 15，
/// i2i 组图还需满足「参考图数 + 生成数 ≤ 15」，因此 refs 参与收敛。
/// 自定义模型 maxRef 是参考图上限，与张数无关，固定 1-4。
/// 前端渲染期滑杆仍需同步取值，保留一份薄函数消费同一份缓存数据；本实现是规则的
/// 权威版本（提交路径 volcark.rs 的 group_cap 亦同规则），测试兜底。
#[cfg_attr(not(test), allow(dead_code))]
pub fn batch_cap(m: &BuiltinModelDto, mode: &str, refs: usize) -> i64 {
    if m.custom.is_some() {
        return 4;
    }
    if mode == "group" {
        if m.provider_id == "volcark" {
            // 5.0 pro 不支持组图（以 id 或用户模型模板 id 判断）
            if m.id.contains("5-0-pro")
                || m.template_model_id
                    .as_deref()
                    .is_some_and(|t| t.contains("5-0-pro"))
            {
                return 1;
            }
            let ref_count = refs as i64;
            return (m.max_batch.unwrap_or(15)).min(15 - ref_count).max(1);
        }
        return (m.max_batch.or(m.max_ref).unwrap_or(4)).clamp(1, 12);
    }
    m.max_images
        .unwrap_or_else(|| m.max_ref.unwrap_or(4).min(4))
        .max(1)
}

/// 工作室默认模型（审计#11：显式按 id 声明，禁止列表魔法下标——列表重排会静默换默认）。
pub fn default_model_ids() -> [(Studio, &'static str); 2] {
    [
        (Studio::Image, "wan2.7-image-pro"),
        (Studio::Video, "doubao-seedance-2-0-fast-260128"),
    ]
}

/// 内置注册表整体快照（list_builtin_models 命令返回；纯内存，无 IO）。
pub fn builtin_registry() -> BuiltinRegistryDto {
    let ids = default_model_ids();
    let default_image = ids
        .iter()
        .find(|(s, _)| *s == Studio::Image)
        .map(|(_, id)| id.to_string())
        .unwrap();
    let default_video = ids
        .iter()
        .find(|(s, _)| *s == Studio::Video)
        .map(|(_, id)| id.to_string())
        .unwrap();
    BuiltinRegistryDto {
        models: builtin_models(),
        default_image,
        default_video,
    }
}

// —— 模型定义 ——

struct ModelSpec<'a> {
    id: &'a str,
    name: &'a str,
    provider: &'a str,
    studio: Studio,
    capabilities: &'a [&'a str],
    ars: &'a [&'a str],
    quals: &'a [&'a str],
    default_q: Option<&'a str>,
    durations: Option<&'a [&'a str]>,
    formats: Option<&'a [&'a str]>,
    max_ref: Option<i64>,
    max_batch: Option<i64>,
    max_images: Option<i64>,
    template: Option<&'a str>,
    edit: Option<bool>,
    blurb: &'a str,
    sections: Option<Vec<ParamSectionDto>>,
    custom: Option<CustomConfigDto>,
}

impl<'a> ModelSpec<'a> {
    fn build(self) -> BuiltinModelDto {
        let caps = self.capabilities.iter().map(|s| s.to_string()).collect();
        let ars = self.ars.iter().map(|s| s.to_string()).collect();
        let quals = self.quals.iter().map(|s| s.to_string()).collect();
        let d = BuiltinModelDto {
            id: self.id.to_string(),
            name: self.name.to_string(),
            provider_id: self.provider.to_string(),
            studio: self.studio,
            capabilities: caps,
            aspect_ratios: ars,
            qualities: quals,
            default_quality: self.default_q.map(|s| s.to_string()),
            durations: self
                .durations
                .map(|a| a.iter().map(|s| s.to_string()).collect()),
            formats: self
                .formats
                .map(|a| a.iter().map(|s| s.to_string()).collect()),
            max_ref: self.max_ref,
            max_batch: self.max_batch,
            max_images: self.max_images,
            template_model_id: self.template.map(|s| s.to_string()),
            edit: self.edit,
            blurb: self.blurb.to_string(),
            custom: self.custom,
            sections: self.sections,
            size_table: Vec::new(),
            px_bounds: PxBoundsDto { min: 0.0, max: 0.0 },
            px_ratio_bounds: None,
        };
        let mut d = d;
        d.size_table = build_size_table(&d);
        d.px_bounds = pixel_bounds(&d);
        d.px_ratio_bounds = pixel_ratio_bounds(&d.provider_id);
        d
    }
}

const SEEDREAM_RATIOS: &[&str] = &[
    "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "9:21", "21:9",
];
const WAN27_RATIOS: &[&str] = &["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"];
const QWEN_RATIOS: &[&str] = &["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"];
const Z_RATIOS: &[&str] = &["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"];
const MS_RATIOS: &[&str] = &["1:1", "2:3", "3:4", "4:3", "3:2", "9:16", "16:9"];
const QWEN_FIXED_QUALITIES: &[&str] = &["默认"];

fn seedream_sections_pro() -> Vec<ParamSectionDto> {
    vec![
        seg("quality", "prompt.resolution"),
        ratio_size("ar", "prompt.imageSize"),
        seg_opts(
            "optimize",
            "prompt.optimizePrompt",
            &["standard", "fast"],
            true,
        ),
        seg("batch", "prompt.imageCount"),
        seg("format", "prompt.imageFormat"),
        seg_i2i("layer", "prompt.layerMode", &["off", "on"], true),
        seg_i2i(
            "background",
            "prompt.backgroundMode",
            &["opaque", "transparent"],
            true,
        ),
    ]
}

fn seedream_sections_45() -> Vec<ParamSectionDto> {
    vec![
        seg_opts("mode", "prompt.imageMode", &["single", "group"], true),
        seg("quality", "prompt.resolution"),
        ratio_size("ar", "prompt.imageSize"),
        seg("batch", "prompt.imageCount"),
    ]
}

fn seedream_sections_40() -> Vec<ParamSectionDto> {
    vec![
        seg_opts("mode", "prompt.imageMode", &["single", "group"], true),
        seg("quality", "prompt.resolution"),
        ratio_size("ar", "prompt.imageSize"),
        seg_opts(
            "optimize",
            "prompt.optimizePrompt",
            &["standard", "fast"],
            true,
        ),
        seg("batch", "prompt.imageCount"),
    ]
}

fn seedream_sections_lite() -> Vec<ParamSectionDto> {
    vec![
        seg_opts("mode", "prompt.imageMode", &["single", "group"], true),
        seg("quality", "prompt.resolution"),
        ratio_size("ar", "prompt.imageSize"),
        seg("batch", "prompt.imageCount"),
        seg("format", "prompt.imageFormat"),
        seg_opts("web_search", "prompt.webSearch", &["off", "on"], true),
    ]
}

fn wan27_sections() -> Vec<ParamSectionDto> {
    vec![
        seg_opts("mode", "prompt.imageMode", &["single", "group"], true),
        seg("quality", "prompt.resolution"),
        ratio_size("ar", "prompt.imageSize"),
        seg("batch", "prompt.imageCount"),
    ]
}

fn wan26_sections() -> Vec<ParamSectionDto> {
    vec![
        ratio_size("ar", "prompt.imageSize"),
        seg("quality", "prompt.resolution"),
    ]
}

fn qwen_size_sections() -> Vec<ParamSectionDto> {
    vec![
        ratio_size("ar", "prompt.imageSize"),
        seg("quality", "prompt.resolution"),
        seg("batch", "prompt.imageCount"),
    ]
}

fn z_image_sections() -> Vec<ParamSectionDto> {
    vec![
        ratio_size("ar", "prompt.imageSize"),
        seg("quality", "prompt.resolution"),
    ]
}

/// 魔搭模型：比例尺寸 + 张数 + LoRA + 自由参数（steps/guidance/seed/negative_prompt）。
fn ms_sections(steps: i64, guidance: f64) -> Vec<ParamSectionDto> {
    vec![
        ratio_size("ar", "prompt.aspectRatio"),
        seg("batch", "prompt.imageCount"),
        ParamSectionDto::Loras {
            key: "loras".to_string(),
            title: "prompt.loras".to_string(),
        },
        param_num("steps", "prompt.paramSteps", &steps.to_string()),
        param_num("guidance", "prompt.paramGuidance", &guidance.to_string()),
        param_num("seed", "prompt.paramSeed", ""),
        param_text("negative_prompt", "prompt.paramNegativePrompt"),
    ]
}

/// 魔搭内置模型（repo_id 即模型 ID，已按魔搭 API 验证存在）。
fn ms_model(repo_id: &str, name: &str, steps: i64, guidance: f64, blurb: &str) -> BuiltinModelDto {
    ModelSpec {
        id: repo_id,
        name,
        provider: "modelscope",
        studio: Studio::Image,
        capabilities: &["t2i", "i2i"],
        ars: MS_RATIOS,
        quals: QWEN_FIXED_QUALITIES,
        default_q: None,
        durations: None,
        formats: None,
        max_ref: Some(1),
        max_batch: None,
        max_images: Some(4), // 魔搭无 n 参数：N 张 = 并行 N 任务（后端实现），张数区 1-4
        template: None,
        edit: None,
        blurb,
        sections: Some(ms_sections(steps, guidance)),
        custom: Some(CustomConfigDto {
            repo_id: repo_id.to_string(),
            name: name.to_string(),
            capabilities: vec!["t2i".to_string(), "i2i".to_string()],
            size_presets: MS_RATIOS.iter().map(|s| s.to_string()).collect(),
            params: json!({ "steps": steps, "guidance": guidance }),
        }),
    }
    .build()
}

/// 全部内置模型（图像 + 视频 + 魔搭；studio 字段区分）。
/// 数量多且含重复字段，用 push 逐个构建比 vec![] 宏更清晰，豁免 vec-init-then-push。
#[allow(clippy::vec_init_then_push)]
pub fn builtin_models() -> Vec<BuiltinModelDto> {
    let mut v = Vec::new();
    // —— 图像模型 ——
    v.push(
        ModelSpec {
            id: "wan2.7-image-pro",
            name: "wan2.7-image-pro",
            provider: "wanxiang",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: WAN27_RATIOS,
            quals: &["1K", "2K", "4K"],
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(9),
            max_batch: Some(12),
            max_images: None,
            template: None,
            edit: Some(true),
            blurb: "文生图4K，文字渲染/角色一致，组图",
            sections: Some(wan27_sections()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "wan2.7-image",
            name: "wan2.7-image",
            provider: "wanxiang",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: WAN27_RATIOS,
            quals: &["1K", "2K"],
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(9),
            max_batch: Some(12),
            max_images: None,
            template: None,
            edit: Some(true),
            blurb: "2.7 快速版，最高 2K",
            sections: Some(wan27_sections()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "qwen-image-2.0-pro",
            name: "qwen-image-2.0-pro",
            provider: "wanxiang",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: QWEN_RATIOS,
            quals: &["1K", "2K"],
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(3),
            max_batch: None,
            max_images: Some(6),
            template: None,
            edit: Some(true),
            blurb: "复杂版面/小字渲染，负向提示词，6 张变体",
            sections: Some(qwen_size_sections()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "qwen-image-2.0",
            name: "qwen-image-2.0",
            provider: "wanxiang",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: QWEN_RATIOS,
            quals: &["1K", "2K"],
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(3),
            max_batch: None,
            max_images: Some(6),
            template: None,
            edit: Some(true),
            blurb: "2.0 快速版，同能力",
            sections: Some(qwen_size_sections()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "qwen-image-max",
            name: "qwen-image-max",
            provider: "wanxiang",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: QWEN_RATIOS,
            quals: QWEN_FIXED_QUALITIES,
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(1),
            max_batch: None,
            max_images: None,
            template: None,
            edit: None,
            blurb: "固定 1664x928 档，单图，支持图生图",
            sections: Some(z_image_sections()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "qwen-image-plus",
            name: "qwen-image-plus",
            provider: "wanxiang",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: QWEN_RATIOS,
            quals: QWEN_FIXED_QUALITIES,
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(1),
            max_batch: None,
            max_images: None,
            template: None,
            edit: None,
            blurb: "轻量单图，成本低，支持图生图",
            sections: Some(z_image_sections()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "qwen-image",
            name: "qwen-image",
            provider: "wanxiang",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: QWEN_RATIOS,
            quals: QWEN_FIXED_QUALITIES,
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(1),
            max_batch: None,
            max_images: None,
            template: None,
            edit: None,
            blurb: "基础版单图，支持图生图",
            sections: Some(z_image_sections()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "qwen-image-edit-max",
            name: "qwen-image-edit-max",
            provider: "wanxiang",
            studio: Studio::Image,
            capabilities: &["i2i"],
            ars: QWEN_RATIOS,
            quals: &["1K", "2K"],
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(3),
            max_batch: None,
            max_images: Some(6),
            template: None,
            edit: Some(true),
            blurb: "图像编辑，1-3 图参考，6 张变体",
            sections: Some(qwen_size_sections()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "qwen-image-edit-plus",
            name: "qwen-image-edit-plus",
            provider: "wanxiang",
            studio: Studio::Image,
            capabilities: &["i2i"],
            ars: QWEN_RATIOS,
            quals: &["1K", "2K"],
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(3),
            max_batch: None,
            max_images: Some(6),
            template: None,
            edit: Some(true),
            blurb: "图像编辑，1-3 图参考",
            sections: Some(qwen_size_sections()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "qwen-image-edit",
            name: "qwen-image-edit",
            provider: "wanxiang",
            studio: Studio::Image,
            capabilities: &["i2i"],
            ars: QWEN_RATIOS,
            quals: QWEN_FIXED_QUALITIES,
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(1),
            max_batch: None,
            max_images: None,
            template: None,
            edit: Some(true),
            blurb: "轻量图像编辑，单图",
            sections: None,
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "z-image-turbo",
            name: "z-image-turbo",
            provider: "wanxiang",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: Z_RATIOS,
            quals: &["1K", "2K"],
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(1),
            max_batch: None,
            max_images: None,
            template: None,
            edit: None,
            blurb: "快 10 倍/约 1/5 价，写实人像，支持图生图",
            sections: Some(z_image_sections()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "doubao-seedream-5-0-pro-260628",
            name: "Seedream 5.0 Pro",
            provider: "volcark",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: SEEDREAM_RATIOS,
            quals: &["1K", "1.5K", "2K"],
            default_q: Some("2K"),
            durations: None,
            formats: Some(&["jpeg", "png"]),
            max_ref: Some(10),
            max_batch: None,
            max_images: None,
            template: None,
            edit: Some(true),
            blurb: "写实电影感，提示词优化/透明背景",
            sections: Some(seedream_sections_pro()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "doubao-seedream-5-0-260128",
            name: "Seedream 5.0 Lite",
            provider: "volcark",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: SEEDREAM_RATIOS,
            quals: &["2K", "3K", "4K"],
            default_q: None,
            durations: None,
            formats: Some(&["jpeg", "png"]),
            max_ref: Some(14),
            max_batch: Some(15),
            max_images: None,
            template: None,
            edit: None,
            blurb: "组图/流式/联网，性价比",
            sections: Some(seedream_sections_lite()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "doubao-seedream-4-5-251128",
            name: "Seedream 4.5",
            provider: "volcark",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: SEEDREAM_RATIOS,
            quals: &["2K", "4K"],
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(14),
            max_batch: Some(15),
            max_images: None,
            template: None,
            edit: None,
            blurb: "多图参考，组图/流式",
            sections: Some(seedream_sections_45()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "doubao-seedream-4-0-250828",
            name: "Seedream 4.0",
            provider: "volcark",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: SEEDREAM_RATIOS,
            quals: &["1K", "2K", "4K"],
            default_q: Some("2K"),
            durations: None,
            formats: None,
            max_ref: Some(14),
            max_batch: Some(15),
            max_images: None,
            template: None,
            edit: None,
            blurb: "组图/流式，标准/快速优化",
            sections: Some(seedream_sections_40()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "wan2.6-t2i",
            name: "wan2.6-t2i",
            provider: "wanxiang",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: &["1:1", "3:4", "4:3", "16:9", "9:16"],
            quals: &["1K", "2K"],
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(1),
            max_batch: None,
            max_images: None,
            template: None,
            edit: None,
            blurb: "国风水墨，意境留白，对话式图生图",
            sections: Some(wan26_sections()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "wan2.6-image",
            name: "wan2.6-image",
            provider: "wanxiang",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: &["1:1", "3:4", "4:3", "16:9", "9:16"],
            quals: &["1K", "2K"],
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(1),
            max_batch: None,
            max_images: None,
            template: None,
            edit: Some(true),
            blurb: "图像编辑，单图参考",
            sections: Some(wan26_sections()),
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "image-01",
            name: "image-01",
            provider: "minimax",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: &["1:1", "3:4", "4:3", "16:9", "9:16"],
            quals: &["1K", "2K"],
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(1),
            max_batch: None,
            max_images: None,
            template: None,
            edit: None,
            blurb: "机甲赛博，octane 质感",
            sections: None,
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "image-01-live",
            name: "image-01-live",
            provider: "minimax",
            studio: Studio::Image,
            capabilities: &["t2i", "i2i"],
            ars: &["1:1", "3:4", "4:3", "16:9", "9:16"],
            quals: &["1K"],
            default_q: None,
            durations: None,
            formats: None,
            max_ref: Some(1),
            max_batch: None,
            max_images: None,
            template: None,
            edit: None,
            blurb: "星云超现实，梦幻氛围",
            sections: None,
            custom: None,
        }
        .build(),
    );

    // —— 视频模型 ——
    // (id, 显示名, 分辨率档, 时长档, maxRef, blurb)
    type SeedanceSpec<'a> = (&'a str, &'a str, &'a [&'a str], &'a [&'a str], i64, &'a str);
    let seedance_ars: &[&str] = &["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
    let seedance12_quals: &[&str] = &["480P", "720P", "1080P", "4K"];
    let seedance1x_quals: &[&str] = &["480P", "720P", "1080P"];
    let seedance10_quals: &[&str] = &["720P", "1080P"];
    let durs_510: &[&str] = &["5", "10"];
    let durs_310: &[&str] = &["3", "5", "10"];
    let standard_ars: &[&str] = &["16:9", "9:16", "1:1"];
    let standard_720_1080: &[&str] = &["720P", "1080P"];
    let v2_quals: &[&str] = &["720P", "1080P"];

    let seedance_specs: [SeedanceSpec; 6] = [
        (
            "doubao-seedance-2-0-260128",
            "Seedance 2.0",
            seedance12_quals,
            durs_510,
            2,
            "多模态参考/有声/4k，编辑延长",
        ),
        (
            "doubao-seedance-2-0-fast-260128",
            "Seedance 2.0 Fast",
            seedance1x_quals,
            durs_510,
            2,
            "2.0 快速档，480p/720p",
        ),
        (
            "doubao-seedance-2-0-mini-260615",
            "Seedance 2.0 Mini",
            seedance1x_quals,
            durs_510,
            2,
            "2.0 轻量档，480p/720p",
        ),
        (
            "doubao-seedance-1-5-pro-251215",
            "Seedance 1.5 Pro",
            seedance1x_quals,
            durs_510,
            2,
            "有声视频，样片模式",
        ),
        (
            "doubao-seedance-1-0-pro-250528",
            "Seedance 1.0 Pro",
            seedance10_quals,
            durs_310,
            1,
            "城市航拍，云层流动",
        ),
        (
            "doubao-seedance-1-0-pro-fast-251015",
            "Seedance 1.0 Pro Fast",
            seedance10_quals,
            durs_310,
            1,
            "1.0 快速档，首帧生视频",
        ),
    ];
    for (id, name, quals, durs, max_ref, blurb) in seedance_specs {
        v.push(
            ModelSpec {
                id,
                name,
                provider: "volcark",
                studio: Studio::Video,
                capabilities: &["t2v", "i2v"],
                ars: seedance_ars,
                quals,
                default_q: None,
                durations: Some(durs),
                formats: None,
                max_ref: Some(max_ref),
                max_batch: None,
                max_images: None,
                template: None,
                edit: None,
                blurb,
                sections: None,
                custom: None,
            }
            .build(),
        );
    }
    v.push(
        ModelSpec {
            id: "kling-v3",
            name: "Kling 3.0",
            provider: "kling",
            studio: Studio::Video,
            capabilities: &["t2v", "i2v"],
            ars: standard_ars,
            quals: &["720P", "1080P", "4K"],
            default_q: None,
            durations: Some(durs_510),
            formats: None,
            max_ref: Some(1),
            max_batch: None,
            max_images: None,
            template: None,
            edit: None,
            blurb: "烟花绽放，电影运镜",
            sections: None,
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "kling-v2-6",
            name: "Kling 2.6",
            provider: "kling",
            studio: Studio::Video,
            capabilities: &["t2v", "i2v"],
            ars: standard_ars,
            quals: standard_720_1080,
            default_q: None,
            durations: Some(durs_510),
            formats: None,
            max_ref: Some(1),
            max_batch: None,
            max_images: None,
            template: None,
            edit: None,
            blurb: "毛发飘动，真实质感",
            sections: None,
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "wan2.7-t2v",
            name: "wan2.7-t2v",
            provider: "wanxiang",
            studio: Studio::Video,
            capabilities: &["t2v"],
            ars: standard_ars,
            quals: v2_quals,
            default_q: None,
            durations: Some(durs_510),
            formats: None,
            max_ref: None,
            max_batch: None,
            max_images: None,
            template: None,
            edit: None,
            blurb: "森林晨雾，缓慢推移",
            sections: None,
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "wan2.7-i2v",
            name: "wan2.7-i2v",
            provider: "wanxiang",
            studio: Studio::Video,
            capabilities: &["i2v"],
            ars: standard_ars,
            quals: v2_quals,
            default_q: None,
            durations: Some(durs_510),
            formats: None,
            max_ref: Some(1),
            max_batch: None,
            max_images: None,
            template: None,
            edit: None,
            blurb: "首帧驱动，发丝飘动",
            sections: None,
            custom: None,
        }
        .build(),
    );
    v.push(
        ModelSpec {
            id: "video-01",
            name: "Hailuo video-01",
            provider: "minimax",
            studio: Studio::Video,
            capabilities: &["t2v", "i2v"],
            ars: standard_ars,
            quals: &["768P", "1080P"],
            default_q: None,
            durations: Some(&["6", "10"]),
            formats: None,
            max_ref: Some(1),
            max_batch: None,
            max_images: None,
            template: None,
            edit: None,
            blurb: "雨中奔跑，慢动作",
            sections: None,
            custom: None,
        }
        .build(),
    );

    // —— 魔搭 ——
    v.push(ms_model(
        "krea/Krea-2-Turbo",
        "Krea-2-Turbo",
        8,
        1.0,
        "Krea 2 Turbo，写实需配 LoRA",
    ));
    v.push(ms_model(
        "Qwen/Qwen-Image",
        "Qwen-Image",
        30,
        3.5,
        "通义文生图",
    ));
    v.push(ms_model(
        "Qwen/Qwen-Image-2512",
        "Qwen-Image-2512",
        30,
        3.5,
        "通义文生图 2512 版，人像更真实",
    ));
    v.push(ms_model(
        "Tongyi-MAI/Z-Image-Turbo",
        "Z-Image-Turbo",
        9,
        0.0,
        "Z-Image 快速版（8 步蒸馏）",
    ));
    v.push(ms_model(
        "black-forest-labs/FLUX.2-dev",
        "FLUX.2-dev",
        30,
        3.5,
        "FLUX.2 dev 32B",
    ));
    v.push(ms_model(
        "black-forest-labs/FLUX.2-klein-9B",
        "FLUX.2-klein-9B",
        4,
        1.0,
        "FLUX.2 klein 9B（4 步）",
    ));
    v.push(ms_model(
        "HiDream-ai/HiDream-O1-Image",
        "HiDream-O1-Image",
        50,
        5.0,
        "HiDream O1 8B",
    ));
    v.push(ms_model(
        "MAILAND/majicflus_v1",
        "majicflus_v1",
        25,
        3.5,
        "麦橘超然，写实人像",
    ));

    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str) -> BuiltinModelDto {
        builtin_models()
            .into_iter()
            .find(|m| m.id == id)
            .expect("模型不存在")
    }

    #[test]
    fn default_models_by_id() {
        let ids = default_model_ids();
        let image = ids.iter().find(|(s, _)| *s == Studio::Image).unwrap().1;
        let video = ids.iter().find(|(s, _)| *s == Studio::Video).unwrap().1;
        assert!(builtin_models()
            .iter()
            .any(|m| m.id == image && m.studio == Studio::Image));
        assert!(builtin_models()
            .iter()
            .any(|m| m.id == video && m.studio == Studio::Video));
    }

    #[test]
    fn size_table_covers_all_quality_ratio_combos() {
        for m in builtin_models() {
            for q in &m.qualities {
                for ar in &m.aspect_ratios {
                    assert!(
                        m.size_table
                            .iter()
                            .any(|e| &e.quality == q && &e.ratio == ar),
                        "{} 缺 ({}, {})",
                        m.id,
                        q,
                        ar
                    );
                }
            }
        }
    }

    #[test]
    fn volcark_pro_size_matches_official_table() {
        let pro = model("doubao-seedream-5-0-pro-260628");
        let px = |ar: &str, q: &str| {
            pro.size_table
                .iter()
                .find(|e| e.quality == q && e.ratio == ar)
                .map(|e| e.px.clone())
                .unwrap()
        };
        assert_eq!(px("1:1", "1K"), "1024x1024");
        assert_eq!(px("16:9", "2K"), "2816x1584");
        assert_eq!(px("9:21", "2K"), "1344x3136");
        // 1.5K 档位独立（pro 专属）
        assert_eq!(px("1:1", "1.5K"), "1536x1536");
    }

    #[test]
    fn volcark_common_size_falls_back_to_2k() {
        let lite = model("doubao-seedream-5-0-260128");
        let px = |ar: &str, q: &str| {
            lite.size_table
                .iter()
                .find(|e| e.quality == q && e.ratio == ar)
                .map(|e| e.px.clone())
                .unwrap()
        };
        assert_eq!(px("1:1", "2K"), "2048x2048");
        assert_eq!(px("16:9", "4K"), "5504x3040");
        // 3K 档位随 COMMON_PX
        assert_eq!(px("1:1", "3K"), "3072x3072");
    }

    #[test]
    fn wanxiang_size_long_side_by_quality() {
        let pro = model("wan2.7-image-pro");
        let px = |ar: &str, q: &str| {
            pro.size_table
                .iter()
                .find(|e| e.quality == q && e.ratio == ar)
                .map(|e| e.px.clone())
                .unwrap()
        };
        assert_eq!(px("1:1", "4K"), "4096x4096");
        assert_eq!(px("16:9", "2K"), "2048x1152");
        let t2i = model("wan2.6-t2i");
        let px26 = t2i
            .size_table
            .iter()
            .find(|e| e.quality == "1K" && e.ratio == "16:9")
            .map(|e| e.px.clone())
            .unwrap();
        // 长边 1280（官方推荐基准档），短边 16 倍数
        assert_eq!(px26, "1280x720");
    }

    #[test]
    fn modelscope_size_long_side_is_model_cap() {
        let flux = model("black-forest-labs/FLUX.2-dev");
        let px = flux
            .size_table
            .iter()
            .find(|e| e.ratio == "1:1")
            .map(|e| e.px.clone())
            .unwrap();
        assert_eq!(px, "1024x1024");
        let qwen = model("Qwen/Qwen-Image");
        let pxq = qwen
            .size_table
            .iter()
            .find(|e| e.ratio == "1:1")
            .map(|e| e.px.clone())
            .unwrap();
        assert_eq!(pxq, "1664x1664");
    }

    #[test]
    fn non_size_provider_size_is_ratio_placeholder() {
        let kling = model("kling-v3");
        let px = kling
            .size_table
            .iter()
            .find(|e| e.ratio == "16:9")
            .map(|e| e.px.clone())
            .unwrap();
        assert_eq!(px, "16:9");
    }

    #[test]
    fn batch_cap_rules() {
        let pro = model("doubao-seedream-5-0-pro-260628");
        assert_eq!(batch_cap(&pro, "group", 0), 1); // pro 不支持组图
        let lite = model("doubao-seedream-5-0-260128");
        assert_eq!(batch_cap(&lite, "group", 0), 15);
        assert_eq!(batch_cap(&lite, "group", 5), 10); // 15 - refs
        assert_eq!(batch_cap(&lite, "single", 0), 4); // 缺省按 maxRef 收敛
        let qwen = model("qwen-image-2.0-pro");
        assert_eq!(batch_cap(&qwen, "single", 0), 6); // maxImages
        let ms = model("Qwen/Qwen-Image");
        assert_eq!(batch_cap(&ms, "single", 0), 4); // 自定义固定 1-4
        assert_eq!(batch_cap(&ms, "group", 0), 4);
    }

    #[test]
    fn pixel_bounds_rules() {
        let pro = model("doubao-seedream-5-0-pro-260628");
        assert_eq!(pro.px_bounds.min, 921600.0);
        assert_eq!(pro.px_bounds.max, 4624220.0);
        assert!(pro.px_ratio_bounds.is_some());
        let qwen = model("qwen-image-2.0-pro");
        assert_eq!(qwen.px_bounds.min, 262144.0);
        assert_eq!(qwen.px_bounds.max, 4194304.0);
        assert!(qwen.px_ratio_bounds.is_none());
        let ms = model("Qwen/Qwen-Image");
        assert_eq!(ms.px_bounds.max, 2768896.0);
        let lite = model("doubao-seedream-5-0-260128");
        assert_eq!(lite.px_ratio_bounds.unwrap().min, 1.0 / 16.0);
    }

    #[test]
    fn seedream_pro_default_quality_is_2k() {
        assert_eq!(
            model("doubao-seedream-5-0-pro-260628")
                .default_quality
                .as_deref(),
            Some("2K")
        );
        // 官方默认 2K，不能裸用数组下标兜底（AGENTS 默认模型规则）
        assert_eq!(
            model("doubao-seedream-4-0-250828")
                .default_quality
                .as_deref(),
            Some("2K")
        );
    }

    #[test]
    fn ms_model_sections_and_custom_defaults() {
        let ms = model("Qwen/Qwen-Image");
        assert_eq!(ms.qualities, vec!["默认"]);
        let custom = ms.custom.unwrap();
        assert_eq!(custom.params["steps"], 30);
        assert_eq!(custom.params["guidance"], 3.5);
        let has_steps = ms
            .sections
            .as_ref()
            .unwrap()
            .iter()
            .any(|s| matches!(s, ParamSectionDto::Param { key, .. } if key == "steps"));
        assert!(has_steps);
    }

    #[test]
    fn all_builtin_models_have_sections_or_default_derive() {
        // 无 sections 的模型由前端 defaultSections 推导；数据完整即可。
        for m in builtin_models() {
            assert!(!m.aspect_ratios.is_empty());
            assert!(!m.qualities.is_empty());
            assert!(!m.capabilities.is_empty());
            if m.studio == Studio::Image {
                assert!(m.capabilities.iter().any(|c| c == "t2i" || c == "i2i"));
            }
        }
    }
}
