//! 本地存储层：AssetStore（产物下载落盘）+ HistoryDb（rusqlite 历史）+ SecureKeyStore（keyring 密钥）。
//! 三者共用 %LOCALAPPDATA%\AIVisionStudio\ 目录。每次操作打开独立连接，避免 Send/Sync 约束。

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use rusqlite::{params, Connection};

use crate::models::{CustomProviderRow, HistoryTaskDto};

const APP_DIR_NAME: &str = "AIVisionStudio";
const KEYRING_SERVICE: &str = "AIVisionStudio.ApiKey";

// —— 目录 ——

pub fn app_dir() -> PathBuf {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(local).join(APP_DIR_NAME)
}

/// 生成产物根目录（ComfyUI 式 output）：%LOCALAPPDATA%\AIVisionStudio\outputs\，
/// 扁平存放，文件名 {ts}_{provider}_{uuid} 时间戳唯一。
pub fn asset_root() -> PathBuf {
    app_dir().join("outputs")
}

/// 参考图收编根目录（ComfyUI 式 input）：%LOCALAPPDATA%\AIVisionStudio\inputs\。
pub fn input_root() -> PathBuf {
    app_dir().join("inputs")
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

/// 把厂商返回的图片/视频 URL 下载到本地：%LOCALAPPDATA%\AIVisionStudio\outputs\。
/// 文件名 {timestamp}_{provider}_{shortid}.{ext}，返回绝对路径。
pub async fn save_remote(
    client: &reqwest::Client,
    url: &str,
    provider_id: &str,
) -> Result<String, String> {
    let root = asset_root();
    let now = chrono::Local::now();
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let ext = guess_extension(url);
    let ts = now.format("%Y%m%d_%H%M%S").to_string();
    let short_id = uuid::Uuid::new_v4().simple().to_string();
    // 厂商 id 可能含 ":"（custom:<uuid>）等非法文件名字符（Windows 会当作 NTFS 数据流分隔符），
    // 统一替换为安全字符。
    let safe_provider: String = provider_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    // 文件名 {ts}_{provider前12位}_{uuid}：UUID 必须完整保留——
    // 同一秒内并行/批量下载的多张图靠它区分，截断 uuid 会同名覆盖（只剩最后一张）。
    // provider 截断到 12 位控制总长（ts 14 + provider 12 + uuid 32 ≈ 59，远低于系统限制）。
    let provider_short: String = safe_provider.chars().take(12).collect();
    let name = format!("{}_{}_{}", ts, provider_short, short_id);
    let full_path = root.join(format!("{}{}", name, ext));

    if url.to_lowercase().starts_with("data:") {
        let comma = url.find(',').ok_or("invalid data url")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&url[comma + 1..])
            .map_err(|e| e.to_string())?;
        fs::write(&full_path, bytes).map_err(|e| e.to_string())?;
    } else {
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {} downloading asset", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        fs::write(&full_path, bytes).map_err(|e| e.to_string())?;
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
        if lower.starts_with("http://asset.localhost/") || lower.starts_with("https://asset.localhost/")
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
                    && head.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
                    && !head.contains('%') =>
            {
                tail
            }
            _ => rest,
        };
        percent_decode(after_host).trim_start_matches('/').to_string()
    } else {
        r.to_string()
    };
    local_to_data_url(&path)
}

/// 本地文件 → data:{mime};base64,...
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
        } else {
            ".png"
        };
        return write_input(bytes, ext);
    }
    if is_url {
        // http(s)://asset.localhost/... 是 Tauri asset 协议的伪装形态，实际是本地文件
        if lower.starts_with("http://asset.localhost/") || lower.starts_with("https://asset.localhost/")
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
                    && head.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
                    && !head.contains('%') =>
            {
                tail
            }
            _ => rest,
        };
        percent_decode(after_host).trim_start_matches('/').to_string()
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
        .filter(|e| e == "png" || e == "jpg" || e == "jpeg" || e == "webp")
        .map(|e| if e == "jpeg" { "jpg".to_string() } else { e })
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
    [".png", ".jpg", ".jpeg", ".webp"].iter().any(|e| lower.ends_with(e))
}

/// 为图片生成 256px 缩略图（WEBP，失败回退 PNG），输出到 thumbs 目录 `{stem}.thumb.*`。
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
    let dir = thumbnail_root();
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

/// 按命名约定推导缩略图路径：thumbs 目录 `{stem}.thumb.webp`（make_thumbnail 输出）。
fn thumbnail_path_of(p: &str) -> PathBuf {
    let path = PathBuf::from(p);
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    thumbnail_root().join(format!("{}.thumb.webp", stem))
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
        conn.execute("UPDATE tasks SET thumbnail_path=?1 WHERE id=?2", params![t, id])
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
        CREATE TABLE IF NOT EXISTS custom_providers (
            id TEXT PRIMARY KEY,
            config_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    // 渐进式迁移：旧库补列（starred 收藏 / thumbnail_path 缩略图 /
    // request_json·raw_response·error HTTP 调试记录 / session_id 会话归属）
    ensure_column(&conn, "tasks", "starred", "starred INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "tasks", "thumbnail_path", "thumbnail_path TEXT")?;
    ensure_column(&conn, "tasks", "request_json", "request_json TEXT")?;
    ensure_column(&conn, "tasks", "error", "error TEXT")?;
    ensure_column(&conn, "tasks", "session_id", "session_id TEXT")?;
    // 会话恢复查询索引（IF NOT EXISTS 幂等，无需 ensure_column）
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 幂等补列：pragma_table_info 无该列时执行 ALTER TABLE ADD COLUMN。
fn ensure_column(conn: &Connection, table: &str, column: &str, ddl: &str) -> Result<(), String> {
    let sql = format!("SELECT 1 FROM pragma_table_info(?1) WHERE name=?2");
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
    /// 任务级错误信息（失败任务当前不入库，预留）。
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

pub fn query_all() -> Result<Vec<HistoryTaskDto>, String> {
    let conn = open_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, provider, model, capability, prompt, params_json, status, created_at, local_paths_json, remote_urls_json, starred, thumbnail_path, session_id
             FROM tasks ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let starred: i64 = row.get(10)?;
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
                remote_urls_json: row.get(9)?,
                starred: starred != 0,
                thumbnail_path: row.get(11)?,
                session_id: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 删除任务行，并清理本地产物文件与缩略图（文件不存在时忽略错误）。
pub fn delete_task(id: i64) -> Result<(), String> {
    let conn = open_conn()?;
    let local_json: String = conn
        .query_row(
            "SELECT local_paths_json FROM tasks WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let thumb: Option<String> = conn
        .query_row(
            "SELECT thumbnail_path FROM tasks WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tasks WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    drop(conn);

    if let Ok(paths) = serde_json::from_str::<Vec<String>>(&local_json) {
        for p in paths {
            let _ = fs::remove_file(p);
        }
    }
    if let Some(t) = thumb {
        let _ = fs::remove_file(t);
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

// —— 自定义厂商（JSON 配置存储） ——
// 前端是 schema 所有者：config_json 原样存取，后端不解析字段。

pub fn list_custom_providers() -> Result<Vec<CustomProviderRow>, String> {
    let conn = open_conn()?;
    let mut stmt = conn
        .prepare("SELECT id, config_json, created_at FROM custom_providers ORDER BY created_at ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(CustomProviderRow {
                id: row.get(0)?,
                config_json: row.get(1)?,
                created_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 取单个厂商配置（协议适配器构建时用）。未找到返回 None。
pub fn get_custom_provider_config(id: &str) -> Result<Option<String>, String> {
    let conn = open_conn()?;
    let mut stmt = conn
        .prepare("SELECT config_json FROM custom_providers WHERE id=?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(e)) => Err(e.to_string()),
        None => Ok(None),
    }
}

pub fn save_custom_provider(id: &str, config_json: &str) -> Result<(), String> {
    let conn = open_conn()?;
    let created = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO custom_providers (id, config_json, created_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json",
        params![id, config_json, created],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_custom_provider(id: &str) -> Result<(), String> {
    let conn = open_conn()?;
    conn.execute("DELETE FROM custom_providers WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// —— SecureKeyStore ——

/// 用系统凭据管理器（Windows Credential Manager，底层 DPAPI）安全存储各厂商 API Key。
/// 绝不入 SQLite、不落明文。Service = 应用名，Account = providerId，Password = apiKey。
pub fn save_key(provider_id: &str, api_key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider_id).map_err(|e| e.to_string())?;
    // 先删除旧凭据，避免残留多份
    let _ = entry.delete_credential();
    if !api_key.trim().is_empty() {
        entry.set_password(api_key).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn get_key(provider_id: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider_id).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(e) => {
            let msg = e.to_string().to_lowercase();
            // 跨版本兼容：NoEntry / NoStorageAccess 等都视为"未设置"
            if msg.contains("no entry") || msg.contains("not found") || msg.contains("no storage") {
                Ok(None)
            } else {
                Err(e.to_string())
            }
        }
    }
}

pub fn delete_key(provider_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider_id).map_err(|e| e.to_string())?;
    let _ = entry.delete_credential();
    Ok(())
}

/// WorkspaceId（业务空间专属域名）：keyring Account 加 "-workspace" 后缀，与 API Key 隔离。
/// 例：wanxiang → account "wanxiang-workspace"，为空串时清除。
pub fn save_workspace(provider_id: &str, workspace_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &format!("{}-workspace", provider_id))
        .map_err(|e| e.to_string())?;
    let _ = entry.delete_credential();
    if !workspace_id.trim().is_empty() {
        entry.set_password(workspace_id.trim()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn get_workspace(provider_id: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &format!("{}-workspace", provider_id))
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(e) => {
            let msg = e.to_string().to_lowercase();
            if msg.contains("no entry") || msg.contains("not found") || msg.contains("no storage") {
                Ok(None)
            } else {
                Err(e.to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
