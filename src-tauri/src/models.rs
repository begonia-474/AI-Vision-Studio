use serde::{Deserialize, Serialize};

// —— 前端 ↔ Rust 共享 DTO ——

/// 厂商元信息。
#[derive(Serialize, Deserialize, Clone)]
pub struct ProviderInfoDto {
    pub id: String,
    pub display_name: String,
    pub capabilities: Vec<String>,
    pub auth_help: String,
}

/// 前端发起的生成请求。model/negative_prompt 可选，缺省由适配器补默认值。
/// size 为即梦像素串（"2048x2048"）；其余厂商用 aspect_ratio/quality/duration。
/// references 为 i2i/i2v 参考图（data:image/...;base64, 或 https URL），角色由适配器按 capability 推断。
#[derive(Serialize, Deserialize, Clone)]
pub struct GenRequest {
    pub provider_id: String,
    pub capability: String,
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub size: String,
    pub n: i64,
    #[serde(default)]
    pub aspect_ratio: Option<String>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub duration: Option<String>,
    #[serde(default)]
    pub references: Vec<String>,
}

/// 一次生成返回给前端的结果。local_paths 已落盘。
#[derive(Serialize, Deserialize, Clone)]
pub struct GenerationResultDto {
    pub provider_id: String,
    pub model: String,
    pub local_paths: Vec<String>,
    pub remote_urls: Vec<String>,
}

/// 历史记录条目（对应 SQLite tasks 表一行）。
#[derive(Serialize, Deserialize, Clone)]
pub struct HistoryTaskDto {
    pub id: i64,
    pub provider: String,
    pub model: String,
    pub capability: String,
    pub prompt: String,
    pub params_json: Option<String>,
    pub status: String,
    pub created_at: String,
    pub local_paths_json: String,
    pub remote_urls_json: Option<String>,
    pub starred: bool,
    pub thumbnail_path: Option<String>,
}

/// 生成进度事件 payload，通过 app.emit("gen-progress", ...) 推送前端。
#[derive(Serialize, Clone)]
pub struct ProgressPayload {
    pub phase: String,
    pub progress: i32,
    pub message: String,
}

// —— Rust 内部类型（不序列化给前端）——

/// 任务阶段。同步厂商（豆包）Submit 完成即 Succeeded；异步厂商走 Submitted→Running→Succeeded。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TaskPhase {
    Submitted,
    Running,
    Succeeded,
    Failed,
}

/// 任务句柄。同步模式 task_id 可为空字符串，remote_urls 在 Submit 阶段即填入结果 URL。
pub struct TaskHandle {
    #[allow(dead_code)]
    pub provider_id: String,
    pub task_id: String,
    pub phase: TaskPhase,
    pub remote_urls: Vec<String>,
    pub error: Option<String>,
}

/// 轮询快照。remote_urls 仅在异步厂商 phase=Succeeded 时填入结果 URL（含 MiniMax 的二次 file 拉取）；
/// 同步厂商 poll 不读此字段（结果 URL 已在 TaskHandle.remote_urls）。
pub struct TaskSnapshot {
    pub phase: TaskPhase,
    pub progress: i32,
    pub message: Option<String>,
    pub remote_urls: Vec<String>,
}
