//! 本地存储层：AssetStore（产物下载落盘）+ HistoryDb（rusqlite 历史）+ SecureKeyStore（keyring 密钥）。
//! 三者共用 %LOCALAPPDATA%\AIVisionStudio\ 目录。每次操作打开独立连接，避免 Send/Sync 约束。

use std::fs;
use std::path::PathBuf;

use base64::Engine;
use rusqlite::{params, Connection};

use crate::models::HistoryTaskDto;

const APP_DIR_NAME: &str = "AIVisionStudio";
const KEYRING_SERVICE: &str = "AIVisionStudio.ApiKey";

// —— 目录 ——

pub fn app_dir() -> PathBuf {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(local).join(APP_DIR_NAME)
}

pub fn asset_root() -> PathBuf {
    app_dir().join("assets")
}

fn db_path() -> PathBuf {
    app_dir().join("history.db")
}

// —— AssetStore ——

/// 把厂商返回的图片/视频 URL 下载到本地：%LOCALAPPDATA%\AIVisionStudio\assets\YYYY\MM\。
/// 文件名 {timestamp}_{provider}_{shortid}.{ext}，返回绝对路径。
pub async fn save_remote(
    client: &reqwest::Client,
    url: &str,
    provider_id: &str,
) -> Result<String, String> {
    let root = asset_root();
    let now = chrono::Local::now();
    let month_dir = root
        .join(now.format("%Y").to_string())
        .join(now.format("%m").to_string());
    fs::create_dir_all(&month_dir).map_err(|e| e.to_string())?;

    let ext = guess_extension(url);
    let ts = now.format("%Y%m%d_%H%M%S").to_string();
    let short_id = uuid::Uuid::new_v4().simple().to_string();
    let mut name = format!("{}_{}_{}", ts, provider_id, short_id);
    if name.len() > 32 {
        name.truncate(32);
    }
    let full_path = month_dir.join(format!("{}{}", name, ext));

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

// —— HistoryDb ——

pub fn ensure_schema() -> Result<(), String> {
    fs::create_dir_all(app_dir()).map_err(|e| e.to_string())?;
    let conn = Connection::open(db_path()).map_err(|e| e.to_string())?;
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
        CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);",
    )
    .map_err(|e| e.to_string())?;
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
}

pub fn insert_task(h: HistoryInsert) -> Result<i64, String> {
    let conn = Connection::open(db_path()).map_err(|e| e.to_string())?;
    let created = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO tasks (provider, model, capability, prompt, params_json, status, created_at, local_paths_json, remote_urls_json, raw_response)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
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
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn query_all() -> Result<Vec<HistoryTaskDto>, String> {
    let conn = Connection::open(db_path()).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, provider, model, capability, prompt, params_json, status, created_at, local_paths_json, remote_urls_json
             FROM tasks ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
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
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn delete_task(id: i64) -> Result<(), String> {
    let conn = Connection::open(db_path()).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tasks WHERE id=?1", params![id])
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
