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
/// extra 为厂商自定义参数透传（魔搭：steps/guidance/seed/negative_prompt 等，来自自定义模型配置）。
#[derive(Serialize, Deserialize, Clone)]
pub struct GenRequest {
    /// 前端生成的任务 ID（一次提交一张任务卡），进度事件原样回传用于路由。
    #[serde(default)]
    pub task_id: String,
    /// 所属会话 ID（前端会话存储生成）；写库后用于启动时按会话恢复时间线。
    #[serde(default)]
    pub session_id: Option<String>,
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
    /// 图像生图模式：single=每张图独立请求（循环 n 次）；group=一次请求组图 auto+max_images。
    #[serde(default)]
    pub mode: Option<String>,
    /// 图像输出格式（火山方舟 Seedream 5.0 pro/lite 支持）：png / jpeg，缺省 jpeg。
    #[serde(default)]
    pub output_format: Option<String>,
    /// 模板模型 id：用户自添加模型继承内置模板行为（尺寸区间/组图能力/专属参数），
    /// 内置模型提交自身 id；缺省时按 model 字段推断。
    #[serde(default)]
    pub template_model_id: Option<String>,
    /// 提示词优化模式（Seedream 5.0 pro）：standard / fast，缺省 standard。
    #[serde(default)]
    pub optimize_prompt_mode: Option<String>,
    /// 透明通道（Seedream 5.0 pro，仅 i2i 单参考图）：transparent / opaque。
    #[serde(default)]
    pub background: Option<String>,
    /// 联网搜索（Seedream 5.0 lite）：true 时提交 tools=[{type:"web_search"}]。
    #[serde(default)]
    pub web_search: Option<bool>,
    /// 图层拆分（Seedream 5.0 pro）：true 时提交 layer_decomposition，仅 i2i 单参考图。
    #[serde(default)]
    pub layer_decomposition: Option<bool>,
    #[serde(default)]
    pub references: Vec<String>,
    #[serde(default)]
    pub extra: Option<serde_json::Value>,
}

/// Seedream 5.0 pro 图层拆分产物的单张图层元数据。
/// 与 sidecar layers/{history_id}.json 中的数组项对齐（serde 默认 snake_case）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LayerMetaDto {
    /// 图层叠放顺序；底图固定 0，数值越大越靠上层。
    pub z_index: Option<i64>,
    /// 模型生成的图层名称/标签。
    pub name: Option<String>,
    /// 模型生成的图层语义描述。
    pub description: Option<String>,
    /// 输出底图坐标系中的绝对像素边界 [left, top, right, bottom]。
    pub bounding_box_absolute: Option<Vec<i64>>,
    /// 输出底图坐标系中的归一化边界 [left, top, right, bottom]（0..1000）。
    pub bounding_box_normalized: Option<Vec<i64>>,
}

/// 一次生成返回给前端的结果。local_paths 已落盘。
#[derive(Serialize, Deserialize, Clone)]
pub struct GenerationResultDto {
    pub history_id: i64,
    pub provider_id: String,
    pub model: String,
    pub local_paths: Vec<String>,
    pub remote_urls: Vec<String>,
    /// 写入 params_json 的完整参数快照（与库中记录同一份 JSON）
    pub params_json: String,
}

/// 用户为内置厂商自添加的模型行。
#[derive(Serialize, Deserialize, Clone)]
pub struct UserModelRow {
    pub id: i64,
    pub provider_id: String,
    pub model_id: String,
    pub name: String,
    pub template_model_id: String,
    pub params_json: Option<String>,
    pub created_at: String,
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
    /// 审计#12：remote_urls_json 从 DTO 移除——前端从未消费该字段（仅入库留档），
    /// 全量查询不再搬运这列，减少图库/启动回灌的序列化体积。
    pub starred: bool,
    pub thumbnail_path: Option<String>,
    /// 所属会话 ID（旧记录为 NULL，仅出现在图库，不归属任何会话）。
    pub session_id: Option<String>,
    /// 任务级错误信息（failed/running 状态行的原因；成功行为 NULL）。
    pub error: Option<String>,
}

/// 会话行（SQLite sessions 表，对齐 Codex threads 元数据索引的设计：
/// 会话列表是权威数据的可重建索引，不再依赖 localStorage）。
#[derive(Serialize, Deserialize, Clone)]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    /// 标题是否用户手动改过（自动命名不得覆盖显式标题）。
    pub name_manually_edited: bool,
    /// 创建时间（Unix 毫秒）。
    pub created_at: i64,
    /// 最近活动时间（Unix 毫秒，排序键）。
    pub updated_at: i64,
}

/// 生成进度事件 payload，通过 app.emit("gen-progress", ...) 推送前端。
/// task_id 对应 GenRequest.task_id，前端按它把进度路由到具体任务卡（多任务并发时互不串台）。
#[derive(Serialize, Clone)]
pub struct ProgressPayload {
    pub task_id: String,
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

/// 单次 HTTP 交换的调试记录，随任务写库（request_json / raw_response）。
/// 只记 method / URL / body，绝不记录鉴权头；body 在捕获时已脱敏
/// （超长 base64 图像块替换为长度标记），防止数据库膨胀。
#[derive(Clone)]
pub struct HttpRecord {
    pub method: &'static str,
    pub url: String,
    /// 请求体（GET 轮询无 body 时为 None）。
    pub request_body: Option<String>,
    pub status: u16,
    pub response_body: String,
}

/// 任务句柄。同步模式 task_id 可为空字符串，remote_urls 在 Submit 阶段即填入结果 URL。
pub struct TaskHandle {
    pub task_id: String,
    pub phase: TaskPhase,
    pub remote_urls: Vec<String>,
    pub error: Option<String>,
    /// 本次 submit 阶段发出的 HTTP 交换记录。
    pub http_log: Vec<HttpRecord>,
}

/// 轮询快照。remote_urls 仅在异步厂商 phase=Succeeded 时填入结果 URL（含 MiniMax 的二次 file 拉取）；
/// 同步厂商 poll 不读此字段（结果 URL 已在 TaskHandle.remote_urls）。
pub struct TaskSnapshot {
    pub phase: TaskPhase,
    pub progress: i32,
    pub message: Option<String>,
    pub remote_urls: Vec<String>,
    /// 本次轮询发出的 HTTP 交换记录（终态轮询写入历史）。
    pub http_log: Vec<HttpRecord>,
}
