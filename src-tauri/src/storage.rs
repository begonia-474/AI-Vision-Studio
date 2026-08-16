//! 本地存储层：AssetStore（产物下载落盘）+ HistoryDb（rusqlite 历史）+ KeyStore（明文 JSON 密钥）。
//! 三者共用数据根目录（debug: 项目 .data/，release: 平台标准数据目录）。每次操作打开独立连接，避免 Send/Sync 约束。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine;
use futures_util::StreamExt;
use rusqlite::{params, Connection, OptionalExtension};
use tauri::Manager;
use tokio::io::AsyncWriteExt;

use crate::models::{HistoryTaskDto, LayerMetaDto, SessionRow, UserModelRow};

const APP_DIR_NAME: &str = "AIVisionStudio";

// —— 目录 ——
// 数据根目录：debug 构建（npm run tauri dev）用项目本地 .data/，
// 开发期产物/历史一眼可见、随手清理；release 构建用平台标准数据目录
// （Windows %LOCALAPPDATA%\com.aivisionstudio.app、Linux ~/.local/share/...、
// macOS ~/Library/Application Support/...），由 init 在启动时解析后固定。

static APP_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 启动时初始化数据目录：debug → 项目本地 .data/；release → 平台标准目录。
/// 同时把该目录加入 asset 协议 scope（webview 内经 asset URL 展示产物/缩略图）。
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.data")
    } else {
        app.path().app_local_data_dir().map_err(|e| e.to_string())?
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // canonicalize 去掉 ../ 等未规范化段（CARGO_MANIFEST_DIR/../.data 会带 src-tauri/.. 前缀，
    // 落库的产物路径串会带它，且 asset scope 授权的是带 .. 的原始串）。目录已存在，必然可解析。
    let dir = fs::canonicalize(&dir).unwrap_or(dir);
    let _ = APP_DIR.set(dir.clone());
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|e| e.to_string())?;
    // 审计#12：参考图收编目录 GC（审计#5）原先在 setup 主线程同步执行（整目录枚举 +
    // 逐文件 metadata/删除），拖慢窗口拉起；已移入 run_startup_gc 后台线程，init 只做
    // 目录解析 + asset scope 授权 + 建库（三者需在命令可用前完成）。
    ensure_schema()
}

/// 启动期参考图 GC（后台线程执行）：清理 inputs 目录下超过保留期的收编副本。
pub fn run_startup_gc() {
    let cleaned = gc_inputs(INPUTS_MAX_AGE_DAYS);
    if cleaned > 0 {
        eprintln!("[storage] 参考图 GC：清理 {} 个过期文件", cleaned);
    }
}

/// 参考图收编副本保留期（天）。副本仅用于"重新生成/跨工作室跳转"复用，属可再生数据：
/// 失败路径已即时清理，成功路径的副本按年龄兜底回收，不追踪引用计数。
const INPUTS_MAX_AGE_DAYS: u64 = 30;

/// 清理 inputs 目录下超过保留期未修改的收编文件（按 mtime 年龄），返回清理数量。
fn gc_inputs(max_age_days: u64) -> usize {
    let Ok(entries) = fs::read_dir(input_root()) else {
        return 0;
    };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(max_age_days * 24 * 60 * 60))
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if let Ok(mtime) = meta.modified() {
            if mtime < cutoff && fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

pub fn app_dir() -> PathBuf {
    APP_DIR.get().cloned().unwrap_or_else(default_app_dir)
}

/// 兜底目录（未显式 init 时，如单元测试）：debug 沿用项目本地 .data/，
/// release 按平台惯例取系统数据目录。返回规范化（无 .. 段）的绝对路径。
fn default_app_dir() -> PathBuf {
    let dir = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.data")
    } else {
        let base = std::env::var("LOCALAPPDATA")
            .or_else(|_| std::env::var("XDG_DATA_HOME"))
            .or_else(|_| std::env::var("HOME").map(|h| format!("{h}/.local/share")))
            .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(base).join(APP_DIR_NAME)
    };
    let _ = fs::create_dir_all(&dir);
    fs::canonicalize(&dir).unwrap_or(dir)
}

/// 生成产物根目录（ComfyUI 式 output）：%LOCALAPPDATA%\AIVisionStudio\outputs\，
/// 按生成日期归档子目录 outputs\YYYY\MM\DD\（文件名 {ts}_{model}_{uuid} 时间戳唯一）。
pub fn asset_root() -> PathBuf {
    app_dir().join("outputs")
}

/// 当日产物目录：outputs\YYYY\MM\DD（不存在时创建）。
/// 审计#12：按日期缓存，同日多文件下载不再重复 create_dir_all 与日期计算；跨天自动失效。
static TODAY_DIR: OnceLock<std::sync::Mutex<(String, PathBuf)>> = OnceLock::new();

fn today_output_dir() -> Result<PathBuf, String> {
    let now = chrono::Local::now();
    let key = now.format("%Y-%m-%d").to_string();
    if let Some(lock) = TODAY_DIR.get() {
        if let Ok(g) = lock.lock() {
            if g.0 == key {
                return Ok(g.1.clone());
            }
        }
    }
    let dir = asset_root()
        .join(now.format("%Y").to_string())
        .join(now.format("%m").to_string())
        .join(now.format("%d").to_string());
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let lock = TODAY_DIR.get_or_init(|| std::sync::Mutex::new((key.clone(), dir.clone())));
    if let Ok(mut g) = lock.lock() {
        if g.0 != key {
            *g = (key, dir.clone());
        }
    }
    Ok(dir)
}

/// 参考图收编根目录（ComfyUI 式 input）：%LOCALAPPDATA%\AIVisionStudio\inputs\。
pub fn input_root() -> PathBuf {
    app_dir().join("inputs")
}

/// 图层拆分元数据 sidecar 目录：app_dir/layers/{history_id}.json。
/// 不新增 tasks 列（当前无 PRAGMA user_version，结构性迁移需先引入版本号）；
/// 元数据可由原厂响应重建，按 history_id 关联 tasks.local_paths_json 的下标。
fn layer_meta_path(history_id: i64) -> PathBuf {
    app_dir().join("layers").join(format!("{history_id}.json"))
}

/// 写图层元数据 sidecar（原子写：tmp + rename，避免半写文件被读到）。
pub fn save_layer_meta(history_id: i64, layers: &[LayerMetaDto]) -> Result<(), String> {
    let path = layer_meta_path(history_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(layers).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    // Windows rename 到已存在目标会失败，先移除旧文件（sidecar 可重建，短窗口可接受）。
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// 读图层元数据 sidecar；文件不存在（非图层任务/旧记录）返回 None。
pub fn read_layer_meta(history_id: i64) -> Result<Option<Vec<LayerMetaDto>>, String> {
    let path = layer_meta_path(history_id);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let layers: Vec<LayerMetaDto> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(Some(layers))
}

/// 删除图层元数据 sidecar；不存在时视为成功（幂等清理）。
pub fn delete_layer_meta(history_id: i64) -> Result<(), String> {
    let path = layer_meta_path(history_id);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 缩略图根目录（预览图可再生，不算产物，与 outputs 分开）：
/// %LOCALAPPDATA%\AIVisionStudio\thumbs\，文件名 {产物stem}.thumb.webp 与产物关联。
pub fn thumbnail_root() -> PathBuf {
    app_dir().join("thumbs")
}

fn db_path() -> PathBuf {
    app_dir().join("history.db")
}

/// 统一连接入口：每次操作独立连接（避免 Send/Sync 约束），
/// busy_timeout 让并发写等待而非立即报 database is locked；
/// WAL 模式在 ensure_schema 中持久化开启（读不阻塞写）。
fn open_conn() -> Result<Connection, String> {
    let conn = Connection::open(db_path()).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

// —— AssetStore ——

/// 把厂商返回的图片/视频 URL 下载到本地：%LOCALAPPDATA%\AIVisionStudio\outputs\YYYY\MM\DD\。
/// 文件名 {timestamp}_{model}_{uuid}.{ext}，返回绝对路径。
pub async fn save_remote(
    client: &reqwest::Client,
    url: &str,
    model: &str,
) -> Result<String, String> {
    let now = chrono::Local::now();
    let day_dir = today_output_dir()?;

    let ext = guess_extension(url);
    let ts = now.format("%Y%m%d_%H%M%S").to_string();
    let short_id = uuid::Uuid::new_v4().simple().to_string();
    // 模型段：用户自建模型 id 是自由输入（可含 /、中文等），统一替换为安全字符（Windows
    // 文件名限制），并截断控制总长（ts 14 + model 24 + uuid 32 ≈ 70，远低于系统限制）。
    let safe_model: String = model
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let model_short: String = safe_model.chars().take(24).collect();
    // UUID 必须完整保留——同一秒内并行/批量下载的多张图靠它区分，截断 uuid 会同名覆盖（只剩最后一张）。
    let name = format!("{}_{}_{}", ts, model_short, short_id);
    let full_path = day_dir.join(format!("{}{}", name, ext));

    if url.to_lowercase().starts_with("data:") {
        let comma = url.find(',').ok_or("invalid data url")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&url[comma + 1..])
            .map_err(|e| e.to_string())?;
        fs::write(&full_path, bytes).map_err(|e| e.to_string())?;
    } else {
        let resp = client
            .get(url)
            // 客户端全局 120s 对数百 MB 视频下载过紧，下载单独放宽到 300s。
            .timeout(std::time::Duration::from_secs(300))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {} downloading asset", resp.status()));
        }
        // 流式落盘：数百 MB 视频不能整块进内存（resp.bytes() 会全量读入 RAM），
        // 边收边写，峰值内存与块大小（默认 16KB）同阶。
        let mut out = tokio::fs::File::create(&full_path)
            .await
            .map_err(|e| e.to_string())?;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            out.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
        out.flush().await.map_err(|e| e.to_string())?;
    }

    Ok(full_path.to_string_lossy().to_string())
}

fn guess_extension(url: &str) -> String {
    let lower = url.to_lowercase();
    if lower.starts_with("data:") {
        // data:image/png;base64,...
        if let Some(slash) = lower.find('/') {
            if let Some(semi_rel) = lower[slash..].find(';') {
                let semi = slash + semi_rel;
                let mime = &lower[slash + 1..semi];
                return match mime {
                    "png" => ".png".to_string(),
                    "jpeg" | "jpg" => ".jpg".to_string(),
                    "webp" => ".webp".to_string(),
                    "mp4" => ".mp4".to_string(),
                    _ => ".bin".to_string(),
                };
            }
        }
        return ".bin".to_string();
    }
    let path_part = url.split('?').next().unwrap_or(url);
    if let Some(dot) = path_part.rfind('.') {
        let ext = path_part[dot..].to_lowercase();
        if ext.len() <= 6 && ext.chars().all(|c| c.is_alphanumeric() || c == '.') {
            return ext;
        }
    }
    ".png".to_string()
}

// —— 缩略图 / 图片元数据 ——

/// 把本地参考图引用归一化为 base64 data URL（厂商只能拿到公网 URL 或 data URL）：
/// - data: / http(s):// 公网 URL 原样返回
/// - asset:// 或 http://asset.localhost/（Tauri convertFileSrc 的两种形态）：读取文件 → base64
/// - 本地绝对路径：读取文件 → base64
pub fn normalize_reference(r: &str) -> Result<String, String> {
    let lower = r.to_lowercase();
    if lower.starts_with("data:") || lower.starts_with("http://") || lower.starts_with("https://") {
        if lower.starts_with("http://asset.localhost/")
            || lower.starts_with("https://asset.localhost/")
        {
            // http://asset.localhost/C%3A%5CUsers%5C... → 去掉 scheme+host 后百分号解码
            let rest = r.splitn(4, '/').nth(3).unwrap_or(r);
            return local_to_data_url(percent_decode(rest).trim_start_matches('/'));
        }
        return Ok(r.to_string());
    }
    let path = if lower.starts_with("asset://") {
        // asset://localhost/C%3A%5CUsers%5C... → 去掉 scheme 与 host（若存在）后百分号解码；
        // 无 host 形态（asset://C:/...）下首段即盘符，不能当 host 剥掉。
        let rest = r.trim_start_matches("asset://");
        let after_host = match rest.split_once('/') {
            Some((head, tail))
                if !head.is_empty()
                    && head
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
                    && !head.contains('%') =>
            {
                tail
            }
            _ => rest,
        };
        percent_decode(after_host)
            .trim_start_matches('/')
            .to_string()
    } else {
        r.to_string()
    };
    local_to_data_url(&path)
}

/// 本地文件 → data:{mime};base64,...
/// 扩展名→MIME 对齐火山方舟官方参考图格式：png/jpg/webp/bmp/tiff/gif/heic/heif。
fn local_to_data_url(path: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取参考图失败: {}", e))?;
    let mime = match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("gif") => "image/gif",
        Some("heic") => "image/heic",
        Some("heif") => "image/heif",
        _ => "image/png",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

// —— 参考图收编（ComfyUI 式 input 目录） ——

/// 把参考图引用收编进受管 input 目录（文件生命周期与应用绑定，用户删原文件不影响重新生成）：
/// - data: / 本地路径 / asset:// 形态：解码/复制进 inputs\{ts}_{uuid}{ext}，返回新绝对路径
/// - 公网 http(s):// URL：不下载，原样返回（ComfyUI 同样直接引用 URL）
pub fn save_reference(r: &str) -> Result<String, String> {
    let lower = r.to_lowercase();
    let (is_data, is_url) = (
        lower.starts_with("data:"),
        lower.starts_with("http://") || lower.starts_with("https://"),
    );
    if is_data {
        let comma = r.find(',').ok_or("invalid data url")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&r[comma + 1..])
            .map_err(|e| e.to_string())?;
        let mime = &r[5..comma];
        let ext = if mime.contains("jpeg") || mime.contains("jpg") {
            ".jpg"
        } else if mime.contains("webp") {
            ".webp"
        } else if mime.contains("bmp") {
            ".bmp"
        } else if mime.contains("tif") {
            ".tiff"
        } else if mime.contains("gif") {
            ".gif"
        } else if mime.contains("heic") {
            ".heic"
        } else if mime.contains("heif") {
            ".heif"
        } else {
            ".png"
        };
        return write_input(bytes, ext);
    }
    if is_url {
        // http(s)://asset.localhost/... 是 Tauri asset 协议的伪装形态，实际是本地文件
        if lower.starts_with("http://asset.localhost/")
            || lower.starts_with("https://asset.localhost/")
        {
            let rest = r.splitn(4, '/').nth(3).unwrap_or(r);
            return copy_input(percent_decode(rest).trim_start_matches('/'));
        }
        return Ok(r.to_string());
    }
    let path = if lower.starts_with("asset://") {
        let rest = r.trim_start_matches("asset://");
        let after_host = match rest.split_once('/') {
            Some((head, tail))
                if !head.is_empty()
                    && head
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
                    && !head.contains('%') =>
            {
                tail
            }
            _ => rest,
        };
        percent_decode(after_host)
            .trim_start_matches('/')
            .to_string()
    } else {
        r.to_string()
    };
    copy_input(&path)
}

fn input_name(ext: &str) -> PathBuf {
    let now = chrono::Local::now();
    let ts = now.format("%Y%m%d_%H%M%S").to_string();
    let short_id = uuid::Uuid::new_v4().simple().to_string();
    input_root().join(format!("{}_{}{}", ts, &short_id[..8], ext))
}

fn write_input(bytes: Vec<u8>, ext: &str) -> Result<String, String> {
    fs::create_dir_all(input_root()).map_err(|e| e.to_string())?;
    let full = input_name(ext);
    fs::write(&full, bytes).map_err(|e| e.to_string())?;
    Ok(full.to_string_lossy().to_string())
}

fn copy_input(src: &str) -> Result<String, String> {
    let ext = Path::new(src)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .filter(|e| {
            matches!(
                e.as_str(),
                "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tif" | "tiff" | "gif" | "heic" | "heif"
            )
        })
        .map(|e| {
            if e == "jpeg" {
                "jpg".to_string()
            } else if e == "tif" {
                "tiff".to_string()
            } else {
                e
            }
        })
        .unwrap_or_else(|| "png".to_string());
    let bytes = fs::read(src).map_err(|e| format!("读取参考图失败: {}", e))?;
    write_input(bytes, &format!(".{}", ext))
}

/// 仅解码 %XX 序列（够 asset URL 用，避免引入解码依赖）。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = (bytes[i + 1] as char).to_digit(16);
            let l = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (h, l) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 是否为可解码的图像文件（png/jpg/jpeg/webp）。
pub fn is_image_path(p: &str) -> bool {
    let lower = p.to_lowercase();
    [".png", ".jpg", ".jpeg", ".webp"]
        .iter()
        .any(|e| lower.ends_with(e))
}

/// 缩略图目录：镜像产物路径的日期子路径（outputs\YYYY\MM\DD → thumbs\YYYY\MM\DD）。
/// 无日期子路径的产物（旧数据）自然落到 thumbs 根（join("") 即根目录）。
fn thumbnail_dir_for(src: &Path) -> PathBuf {
    let rel = src.strip_prefix(asset_root()).unwrap_or(src);
    let parent = rel.parent().unwrap_or_else(|| Path::new(""));
    thumbnail_root().join(parent)
}

/// 为图片生成 256px 缩略图（WEBP，失败回退 PNG），输出到与产物同日期子路径的 thumbs 目录。
/// 缩略图是可再生的预览文件（ensure_thumbnails 可重建），不随产物放 outputs。
/// 生成失败返回 Err（调用方忽略即可，不影响主流程）。
pub fn make_thumbnail(src: &str) -> Result<String, String> {
    let path = PathBuf::from(src);
    let img = image::open(&path).map_err(|e| e.to_string())?;
    let thumb = img.thumbnail(256, 256);

    let stem = path
        .file_stem()
        .ok_or("invalid file name")?
        .to_string_lossy()
        .to_string();
    let dir = thumbnail_dir_for(&path);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let webp_dest = dir.join(format!("{}.thumb.webp", stem));
    match thumb.save_with_format(&webp_dest, image::ImageFormat::WebP) {
        Ok(()) => Ok(webp_dest.to_string_lossy().to_string()),
        Err(_) => {
            let png_dest = dir.join(format!("{}.thumb.png", stem));
            thumb
                .save_with_format(&png_dest, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            Ok(png_dest.to_string_lossy().to_string())
        }
    }
}

/// 按命名约定推导缩略图路径：优先 `{stem}.thumb.webp`，WebP 编码失败时
/// make_thumbnail 会回退输出 `{stem}.thumb.png`——两种都存在时按实际文件返回，
/// 否则返回 webp 路径（不存在即视为缺失，由调用方触发重新生成）。
fn thumbnail_path_of(p: &str) -> PathBuf {
    let path = PathBuf::from(p);
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let dir = thumbnail_dir_for(&path);
    let webp = dir.join(format!("{}.thumb.webp", stem));
    if webp.exists() {
        return webp;
    }
    let png = dir.join(format!("{}.thumb.png", stem));
    if png.exists() {
        return png;
    }
    webp
}

/// 补全历史任务缺失的缩略图（旧数据仅第一张有）。
/// 按 `{stem}.thumb.webp` 命名约定检查每张图片，缺则生成；
/// thumbnail_path 为空的任务回填第一张缩略图。返回补生成的缩略图数量。
pub fn ensure_thumbnails() -> Result<usize, String> {
    let conn = open_conn()?;
    let mut stmt = conn
        .prepare("SELECT id, local_paths_json, thumbnail_path FROM tasks")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut made = 0usize;
    let mut backfill: Vec<(i64, String)> = Vec::new();
    for r in rows {
        let (id, local_json, thumb) = r.map_err(|e| e.to_string())?;
        let paths: Vec<String> = serde_json::from_str(&local_json).unwrap_or_default();
        let mut first_thumb: Option<String> = None;
        for p in &paths {
            if !is_image_path(p) {
                continue;
            }
            let derived = thumbnail_path_of(p);
            if !derived.exists() {
                if let Ok(t) = make_thumbnail(p) {
                    made += 1;
                    if first_thumb.is_none() {
                        first_thumb = Some(t);
                    }
                }
            } else if first_thumb.is_none() {
                first_thumb = Some(derived.to_string_lossy().to_string());
            }
        }
        if thumb.is_none() {
            if let Some(t) = first_thumb {
                backfill.push((id, t));
            }
        }
    }
    for (id, t) in backfill {
        conn.execute(
            "UPDATE tasks SET thumbnail_path=?1 WHERE id=?2",
            params![t, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(made)
}

// —— HistoryDb ——

pub fn ensure_schema() -> Result<(), String> {
    fs::create_dir_all(app_dir()).map_err(|e| e.to_string())?;
    let conn = open_conn()?;
    // WAL：读写并发不互斥（Windows 上默认 delete 模式下写锁会顶掉并发的读/写）
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            capability TEXT NOT NULL,
            prompt TEXT NOT NULL,
            params_json TEXT,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            local_paths_json TEXT NOT NULL,
            remote_urls_json TEXT,
            raw_response TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
        CREATE TABLE IF NOT EXISTS user_models (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider_id TEXT NOT NULL,
            model_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            template_model_id TEXT NOT NULL,
            params_json TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            name_manually_edited INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
",
    )
    .map_err(|e| e.to_string())?;
    // 渐进式迁移：旧库补列（starred 收藏 / thumbnail_path 缩略图 /
    // request_json·raw_response·error HTTP 调试记录 / session_id 会话归属）
    ensure_column(
        &conn,
        "tasks",
        "starred",
        "starred INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(&conn, "tasks", "thumbnail_path", "thumbnail_path TEXT")?;
    ensure_column(&conn, "tasks", "request_json", "request_json TEXT")?;
    ensure_column(&conn, "tasks", "error", "error TEXT")?;
    ensure_column(&conn, "tasks", "session_id", "session_id TEXT")?;
    // 会话恢复查询索引（IF NOT EXISTS 幂等，无需 ensure_column）
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);")
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 幂等补列：pragma_table_info 无该列时执行 ALTER TABLE ADD COLUMN。
fn ensure_column(conn: &Connection, table: &str, column: &str, ddl: &str) -> Result<(), String> {
    let sql = "SELECT 1 FROM pragma_table_info(?1) WHERE name=?2".to_string();
    let exists: bool = conn
        .prepare(&sql)
        .map_err(|e| e.to_string())?
        .exists(params![table, column])
        .map_err(|e| e.to_string())?;
    if !exists {
        let alter = format!("ALTER TABLE {} ADD COLUMN {}", table, ddl);
        conn.execute(&alter, []).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub struct HistoryInsert {
    pub provider: String,
    pub model: String,
    pub capability: String,
    pub prompt: String,
    pub params_json: Option<String>,
    pub status: String,
    pub local_paths_json: String,
    pub remote_urls_json: Option<String>,
    pub thumbnail_path: Option<String>,
    /// HTTP 请求记录数组 JSON（[{method,url,body}]），仅记录成功落库任务。
    pub request_json: Option<String>,
    /// HTTP 响应记录数组 JSON（[{method,url,status,body}]），body 已脱敏截断。
    pub raw_response: Option<String>,
    /// 任务级错误信息（失败任务同样入库，终态由 update_task_result 回写）。
    pub error: Option<String>,
    /// 所属会话 ID（前端会话存储生成），NULL 表示不属于任何会话（旧数据/图库浏览）。
    pub session_id: Option<String>,
}

pub fn insert_task(h: HistoryInsert) -> Result<i64, String> {
    let conn = open_conn()?;
    let created = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO tasks (provider, model, capability, prompt, params_json, status, created_at, local_paths_json, remote_urls_json, request_json, raw_response, thumbnail_path, error, session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            h.provider,
            h.model,
            h.capability,
            h.prompt,
            h.params_json,
            h.status,
            created,
            h.local_paths_json,
            h.remote_urls_json,
            h.request_json,
            h.raw_response,
            h.thumbnail_path,
            h.error,
            h.session_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

// —— 会话（sessions 表）：会话元数据是权威数据的可重建索引（对齐 Codex threads 表设计） ——

pub fn list_sessions() -> Result<Vec<SessionRow>, String> {
    let conn = open_conn()?;
    let mut stmt = conn
        // 审计#12：前端 sortByRecent 与 idx_sessions_updated 索引对应，查询端直接排序走索引。
        .prepare(
            "SELECT id, title, name_manually_edited, created_at, updated_at FROM sessions ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let manual: i64 = row.get(2)?;
            Ok(SessionRow {
                id: row.get(0)?,
                title: row.get(1)?,
                name_manually_edited: manual != 0,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 幂等 upsert：前端每次会话变更（新建/重命名/活动时间上浮）都整行覆盖。
pub fn upsert_session(s: &SessionRow) -> Result<(), String> {
    let conn = open_conn()?;
    conn.execute(
        "INSERT INTO sessions (id, title, name_manually_edited, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            name_manually_edited = excluded.name_manually_edited,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at",
        params![
            s.id,
            s.title,
            s.name_manually_edited as i64,
            s.created_at,
            s.updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除会话：任务行解绑（session_id 置 NULL → 仅图库可见，不随会话删除），
/// 且不会在下次启动时被孤儿重建复活（与「删除会话不删产物」语义一致）。
pub fn delete_session(id: &str) -> Result<(), String> {
    let conn = open_conn()?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE tasks SET session_id = NULL WHERE session_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sessions WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 任务终态回写：提交即落库（status=running），成功/失败后在此收尾。
/// 失败任务也留行——图库可编辑复用、时间线可删除，产物不会因瞬时错误永久丢失。
/// 参数多（9 个）是 tasks 表终态字段的直接映射，打包 struct 反而多一层转换，故允许。
#[allow(clippy::too_many_arguments)]
pub fn update_task_result(
    id: i64,
    status: &str,
    local_paths_json: &str,
    remote_urls_json: Option<&str>,
    thumbnail_path: Option<&str>,
    params_json: Option<&str>,
    request_json: Option<&str>,
    raw_response: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_conn()?;
    conn.execute(
        "UPDATE tasks SET status=?2, local_paths_json=?3, remote_urls_json=?4,
         thumbnail_path=?5, params_json=?6, request_json=?7, raw_response=?8, error=?9
         WHERE id=?1",
        params![
            id,
            status,
            local_paths_json,
            remote_urls_json,
            thumbnail_path,
            params_json,
            request_json,
            raw_response,
            error,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 历史查询的共享列与行映射（审计#12：remote_urls_json 移出 DTO，不再搬运）。
const HISTORY_COLS: &str = "id, provider, model, capability, prompt, params_json, status, created_at, local_paths_json, starred, thumbnail_path, session_id, error";

fn history_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryTaskDto> {
    let starred: i64 = row.get(9)?;
    Ok(HistoryTaskDto {
        id: row.get(0)?,
        provider: row.get(1)?,
        model: row.get(2)?,
        capability: row.get(3)?,
        prompt: row.get(4)?,
        params_json: row.get(5)?,
        status: row.get(6)?,
        created_at: row.get(7)?,
        local_paths_json: row.get(8)?,
        starred: starred != 0,
        thumbnail_path: row.get(10)?,
        session_id: row.get(11)?,
        error: row.get(12)?,
    })
}

pub fn query_all() -> Result<Vec<HistoryTaskDto>, String> {
    let conn = open_conn()?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {HISTORY_COLS} FROM tasks ORDER BY created_at DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], history_row).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 分页历史查询（图库渐进加载）：ORDER BY created_at DESC 走 idx_tasks_created 索引。
/// 审计#12：图库原先一次全量 invoke（上千行 × 大字段 JSON 的序列化峰值）；
/// 改为 LIMIT/OFFSET 分页，单次 payload 有界，图库前端逐页拉满。
pub fn query_page(limit: i64, offset: i64) -> Result<Vec<HistoryTaskDto>, String> {
    let conn = open_conn()?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {HISTORY_COLS} FROM tasks ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit, offset], history_row)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 批量删除任务（图库批量删除）：审计#12——原先逐条 delete_task 各自独立连接 +
/// 逐条 autocommit（每次 fsync），批量删除多次 fsync 拖慢；改为单连接单事务：
/// 行删除一次提交，文件删除在提交后统一执行（不存在时忽略）。
pub fn delete_tasks(ids: &[i64]) -> Result<(), String> {
    let conn = open_conn()?;
    let mut files: Vec<String> = Vec::new();
    let mut thumbs: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT local_paths_json, thumbnail_path FROM tasks WHERE id=?1")
            .map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for id in ids {
            let row = stmt
                .query_row(params![id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some((local_json, thumb)) = row {
                if let Ok(paths) = serde_json::from_str::<Vec<String>>(&local_json) {
                    files.extend(paths);
                }
                if let Some(t) = thumb {
                    thumbs.push(t);
                }
            }
            tx.execute("DELETE FROM tasks WHERE id=?1", params![id])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    for p in files {
        let _ = fs::remove_file(p);
    }
    for t in thumbs {
        let _ = fs::remove_file(t);
    }
    for id in ids {
        let _ = delete_layer_meta(*id);
    }
    Ok(())
}

/// 收藏置位。
pub fn set_starred(id: i64, starred: bool) -> Result<(), String> {
    let conn = open_conn()?;
    conn.execute(
        "UPDATE tasks SET starred=?1 WHERE id=?2",
        params![starred as i64, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// —— KeyStore ——
// 各厂商 API Key / WorkspaceId 以明文 JSON 存于数据目录 keys.json（跨平台一致，
// 不依赖系统凭据管理器；文件权限收紧到仅当前用户可读写）。
// 结构与旧 keyring 数据不互通，首次使用需重新填入。

/// { "api_keys": { providerId: key }, "workspaces": { providerId: workspaceId } }
#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
struct KeyFile {
    api_keys: std::collections::HashMap<String, String>,
    workspaces: std::collections::HashMap<String, String>,
}

fn keys_path() -> PathBuf {
    app_dir().join("keys.json")
}

/// 串行化 keys.json 读写（保存路径：临时文件 + 原子重命名，避免写一半损坏）。
/// 审计#12：由 Mutex 改为 RwLock——写仍互斥（读-改-写原子），读并发不再互相阻塞；
/// 配合 KeyFile 内存缓存，读路径（generate 取 key / dashscope base_url / 掩码回显）
/// 命中缓存时零磁盘 IO。
static KEYS_LOCK: std::sync::RwLock<()> = std::sync::RwLock::new(());
/// keys.json 已解析内容的进程内缓存；写操作成功后同步刷新，读操作直接复用。
static KEYS_CACHE: std::sync::RwLock<Option<KeyFile>> = std::sync::RwLock::new(None);

fn load_key_file() -> Result<KeyFile, String> {
    match fs::read(keys_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("keys.json 损坏: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(KeyFile::default()),
        Err(e) => Err(format!("读取 keys.json 失败: {}", e)),
    }
}

/// 读路径：缓存命中直接返回，未命中读盘后填充缓存。
fn load_key_file_cached() -> Result<KeyFile, String> {
    if let Some(k) = KEYS_CACHE.read().unwrap().as_ref() {
        return Ok(k.clone());
    }
    let k = load_key_file()?;
    if let Ok(mut g) = KEYS_CACHE.write() {
        *g = Some(k.clone());
    }
    Ok(k)
}

fn save_key_file(keys: &KeyFile) -> Result<(), String> {
    let path = keys_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(keys).map_err(|e| e.to_string())?;
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 写路径：落盘成功后同步刷新缓存，后续读零 IO。
fn save_key_file_cached(keys: &KeyFile) -> Result<(), String> {
    save_key_file(keys)?;
    if let Ok(mut g) = KEYS_CACHE.write() {
        *g = Some(keys.clone());
    }
    Ok(())
}

pub fn save_key(provider_id: &str, api_key: &str) -> Result<(), String> {
    let _guard = KEYS_LOCK.write().unwrap();
    let mut keys = load_key_file_cached()?;
    if api_key.trim().is_empty() {
        keys.api_keys.remove(provider_id);
    } else {
        keys.api_keys
            .insert(provider_id.to_string(), api_key.trim().to_string());
    }
    save_key_file_cached(&keys)
}

pub fn get_key(provider_id: &str) -> Result<Option<String>, String> {
    let _guard = KEYS_LOCK.read().unwrap();
    Ok(load_key_file_cached()?.api_keys.get(provider_id).cloned())
}

pub fn delete_key(provider_id: &str) -> Result<(), String> {
    let _guard = KEYS_LOCK.write().unwrap();
    let mut keys = load_key_file_cached()?;
    keys.api_keys.remove(provider_id);
    save_key_file_cached(&keys)
}

/// WorkspaceId（业务空间专属域名），为空串时清除。
pub fn save_workspace(provider_id: &str, workspace_id: &str) -> Result<(), String> {
    let _guard = KEYS_LOCK.write().unwrap();
    let mut keys = load_key_file_cached()?;
    if workspace_id.trim().is_empty() {
        keys.workspaces.remove(provider_id);
    } else {
        keys.workspaces
            .insert(provider_id.to_string(), workspace_id.trim().to_string());
    }
    save_key_file_cached(&keys)
}

pub fn get_workspace(provider_id: &str) -> Result<Option<String>, String> {
    let _guard = KEYS_LOCK.read().unwrap();
    Ok(load_key_file_cached()?.workspaces.get(provider_id).cloned())
}

// —— 用户自添加模型 ——
// 用户为内置厂商添加的模型：model_id（提交 model 字段）+ 模板模型 id（继承其参数分区/尺寸机制）
// + 可选的默认参数 JSON。前端是 schema 所有者，后端不解析 params_json。

pub fn list_user_models() -> Result<Vec<UserModelRow>, String> {
    let conn = open_conn()?;
    let mut stmt = conn
        .prepare("SELECT id, provider_id, model_id, name, template_model_id, params_json, created_at FROM user_models ORDER BY created_at ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(UserModelRow {
                id: row.get(0)?,
                provider_id: row.get(1)?,
                model_id: row.get(2)?,
                name: row.get(3)?,
                template_model_id: row.get(4)?,
                params_json: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn save_user_model(
    provider_id: &str,
    model_id: &str,
    name: &str,
    template_model_id: &str,
    params_json: Option<&str>,
) -> Result<(), String> {
    let conn = open_conn()?;
    let created = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO user_models (provider_id, model_id, name, template_model_id, params_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(model_id) DO UPDATE SET
           provider_id=excluded.provider_id, name=excluded.name,
           template_model_id=excluded.template_model_id, params_json=excluded.params_json",
        params![provider_id, model_id, name, template_model_id, params_json, created],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_user_model(id: i64) -> Result<(), String> {
    let conn = open_conn()?;
    conn.execute("DELETE FROM user_models WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_dir_is_canonical() {
        // debug 目录由 CARGO_MANIFEST_DIR(../.data) 派生，必须规范化：
        // 带 src-tauri/.. 前缀的路径串会原样落库/落盘，导致产物路径与真实位置不一致。
        let dir = app_dir();
        assert!(dir.is_absolute(), "app_dir 应为绝对路径: {}", dir.display());
        let s = dir.to_string_lossy().to_string();
        assert!(
            !s.contains("/../") && !s.contains("/./"),
            "app_dir 不应含未规范化段: {}",
            s
        );
        assert!(s.ends_with("/.data"), "app_dir 应为项目 .data: {}", s);
        assert_eq!(fs::canonicalize(&dir).unwrap(), dir);
    }

    #[test]
    fn thumbnail_roundtrip() {
        let dir = std::env::temp_dir().join("avs_storage_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let png = dir.join("a.png");
        // 噪点图（接近真实照片的压缩率）
        let mut buf = image::RgbaImage::new(512, 512);
        let mut seed = 42u32;
        for px in buf.pixels_mut() {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let v = (seed >> 24) as u8;
            *px = image::Rgba([v, v.wrapping_add(30), v.wrapping_add(60), 255]);
        }
        buf.save(&png).unwrap();

        let thumb = make_thumbnail(png.to_str().unwrap()).unwrap();
        assert!(Path::new(&thumb).exists());
        let decoded = image::open(&thumb).unwrap();
        assert!(decoded.width() <= 256 && decoded.height() <= 256);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn layer_meta_roundtrip_and_delete() {
        let id = -4242;
        let layers = vec![LayerMetaDto {
            z_index: Some(0),
            name: Some("底图".to_string()),
            description: None,
            bounding_box_absolute: None,
            bounding_box_normalized: None,
        }];
        save_layer_meta(id, &layers).unwrap();
        let loaded = read_layer_meta(id).unwrap().expect("sidecar 应可读");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].z_index, Some(0));
        delete_layer_meta(id).unwrap();
        assert!(read_layer_meta(id).unwrap().is_none());
    }
}
