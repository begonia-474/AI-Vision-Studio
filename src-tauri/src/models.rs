use serde::{Deserialize, Serialize};
use ts_rs::TS;

// —— 前端 ↔ Rust 共享 DTO ——
// 审计#19：DTO 由 ts-rs 生成前端类型（scripts/typegen.mjs 设置 TS_RS_EXPORT_DIR 为
// src/types/generated/），本文件是唯一事实源，前端 src/types.ts 仅 re-export。
// Option 字段一律 `#[ts(optional = nullable)]`（前端构造请求时用 undefined 表示缺省，
// 后端可能回传 null）；serde_json::Value 手动映射为 Record<string, unknown>。
// 改名/新增字段后运行 `npm run typegen`。

/// 厂商元信息。
#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, rename = "ProviderInfo")]
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
#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export)]
pub struct GenRequest {
    /// 前端生成的任务 ID（一次提交一张任务卡），进度事件原样回传用于路由。
    #[serde(default)]
    pub task_id: String,
    /// 所属会话 ID（前端会话存储生成）；写库后用于启动时按会话恢复时间线。
    #[serde(default)]
    #[ts(optional = nullable)]
    pub session_id: Option<String>,
    pub provider_id: String,
    pub capability: String,
    pub prompt: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub negative_prompt: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub model: Option<String>,
    pub size: String,
    /// 生成张数。前端为 number（JS number 范围内），覆盖 ts-rs 默认的 bigint。
    #[ts(type = "number")]
    pub n: i64,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub aspect_ratio: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub quality: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub duration: Option<String>,
    /// 图像生图模式：single=每张图独立请求（循环 n 次）；group=一次请求组图 auto+max_images。
    #[serde(default)]
    #[ts(optional = nullable)]
    pub mode: Option<String>,
    /// 图像输出格式（火山方舟 Seedream 5.0 pro/lite 支持）：png / jpeg，缺省 jpeg。
    #[serde(default)]
    #[ts(optional = nullable)]
    pub output_format: Option<String>,
    /// 模板模型 id：用户自添加模型继承内置模板行为（尺寸区间/组图能力/专属参数），
    /// 内置模型提交自身 id；缺省时按 model 字段推断。
    #[serde(default)]
    #[ts(optional = nullable)]
    pub template_model_id: Option<String>,
    /// 提示词优化模式（Seedream 5.0 pro）：standard / fast，缺省 standard。
    #[serde(default)]
    #[ts(optional = nullable)]
    pub optimize_prompt_mode: Option<String>,
    /// 透明通道（Seedream 5.0 pro，仅 i2i 单参考图）：transparent / opaque。
    #[serde(default)]
    #[ts(optional = nullable)]
    pub background: Option<String>,
    /// 联网搜索（Seedream 5.0 lite）：true 时提交 tools=[{type:"web_search"}]。
    #[serde(default)]
    #[ts(optional = nullable)]
    pub web_search: Option<bool>,
    /// 图层拆分（Seedream 5.0 pro）：true 时提交 layer_decomposition，仅 i2i 单参考图。
    #[serde(default)]
    #[ts(optional = nullable)]
    pub layer_decomposition: Option<bool>,
    #[serde(default)]
    pub references: Vec<String>,
    /// 用户自添加模型透传：{ params: 用户按模型配置的自由参数 }。
    #[serde(default)]
    #[ts(type = "Record<string, unknown>", optional = nullable)]
    pub extra: Option<serde_json::Value>,
}

/// Seedream 5.0 pro 图层拆分产物的单张图层元数据。
/// 与 sidecar layers/{history_id}.json 中的数组项对齐（serde 默认 snake_case）。
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, rename = "LayerMeta")]
pub struct LayerMetaDto {
    /// 图层叠放顺序；底图固定 0，数值越大越靠上层。
    /// 前端按 number | null 消费（覆盖 ts-rs 默认 bigint）。
    #[ts(type = "number | null")]
    pub z_index: Option<i64>,
    /// 模型生成的图层名称/标签。
    pub name: Option<String>,
    /// 模型生成的图层语义描述。
    pub description: Option<String>,
    /// 输出底图坐标系中的绝对像素边界 [left, top, right, bottom]。
    #[ts(type = "Array<number> | null")]
    pub bounding_box_absolute: Option<Vec<i64>>,
    /// 输出底图坐标系中的归一化边界 [left, top, right, bottom]（0..1000）。
    #[ts(type = "Array<number> | null")]
    pub bounding_box_normalized: Option<Vec<i64>>,
}

/// 图层画布所需上下文：本地产物路径（与 sidecar 下标对齐）+ 图层元数据。
#[derive(Serialize, Clone, TS)]
#[ts(export, rename = "LayerComposition")]
pub struct LayerCompositionDto {
    pub paths: Vec<String>,
    pub layers: Vec<LayerMetaDto>,
}

/// 一次生成返回给前端的结果。local_paths 已落盘。
#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, rename = "GenerationResult")]
pub struct GenerationResultDto {
    /// 前端 number 语义（覆盖 ts-rs 默认 bigint）。
    #[ts(type = "number")]
    pub history_id: i64,
    pub provider_id: String,
    pub model: String,
    pub local_paths: Vec<String>,
    pub remote_urls: Vec<String>,
    /// 写入 params_json 的完整参数快照（与库中记录同一份 JSON）
    pub params_json: String,
}

/// 用户为内置厂商自添加的模型行。
#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export)]
pub struct UserModelRow {
    /// 前端 number 语义（覆盖 ts-rs 默认 bigint）。
    #[ts(type = "number")]
    pub id: i64,
    pub provider_id: String,
    pub model_id: String,
    pub name: String,
    pub template_model_id: String,
    pub params_json: Option<String>,
    pub created_at: String,
}

/// 历史记录条目（对应 SQLite tasks 表一行）。
#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, rename = "HistoryTask")]
pub struct HistoryTaskDto {
    /// 前端 number 语义（覆盖 ts-rs 默认 bigint）。
    #[ts(type = "number")]
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
#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export)]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    /// 标题是否用户手动改过（自动命名不得覆盖显式标题）。
    pub name_manually_edited: bool,
    /// 创建时间（Unix 毫秒）。前端 number 语义。
    #[ts(type = "number")]
    pub created_at: i64,
    /// 最近活动时间（Unix 毫秒，排序键）。
    #[ts(type = "number")]
    pub updated_at: i64,
}

/// 生成进度事件阶段（gen-progress 事件 phase 字段）。
/// 审计#19：原为魔法字符串（"submitting"/"running"/...），改为枚举后序列化输出不变
/// （serde rename_all lowercase），Rust 内部不再拼字符串；前端由 ts-rs 生成
/// union 类型 + `npm run typegen` 生成的 constants.ts 常量，消费处类型安全。
#[derive(Serialize, Clone, Copy, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ProgressPhase {
    Submitting,
    Running,
    Downloading,
    Done,
    Failed,
}

// ALL/as_str 仅供 export_bindings 测试生成前端常量使用；lib 构建（非 test）视为未用，
// 用 cfg_attr 豁免 dead_code（不用 expect，避免 test 构建因"预期满足"反向告警）。
#[cfg_attr(not(test), allow(dead_code))]
impl ProgressPhase {
    /// 全部阶段（按推进顺序）。typegen 用它生成前端常量（src/types/generated/constants.ts）。
    pub const ALL: [ProgressPhase; 5] = [
        ProgressPhase::Submitting,
        ProgressPhase::Running,
        ProgressPhase::Downloading,
        ProgressPhase::Done,
        ProgressPhase::Failed,
    ];

    /// 事件负载中的序列化值（与 serde rename_all="lowercase" 保持一致，勿单独改）。
    pub fn as_str(self) -> &'static str {
        match self {
            ProgressPhase::Submitting => "submitting",
            ProgressPhase::Running => "running",
            ProgressPhase::Downloading => "downloading",
            ProgressPhase::Done => "done",
            ProgressPhase::Failed => "failed",
        }
    }
}

/// 生成进度事件 payload，通过 app.emit("gen-progress", ...) 推送前端。
/// task_id 对应 GenRequest.task_id，前端按它把进度路由到具体任务卡（多任务并发时互不串台）。
#[derive(Serialize, Clone, TS)]
#[ts(export)]
pub struct ProgressPayload {
    pub task_id: String,
    pub phase: ProgressPhase,
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

// —— 前端类型生成（审计#19）——
// `npm run typegen`（scripts/typegen.mjs）调用 `cargo test export_bindings`，把所有
// derive(TS) 的 DTO 与常量重新导出到 src/types/generated/。生成文件提交进版本库，
// CI 校验一致性（git diff --exit-code）。未设置 TS_RS_EXPORT_DIR 时跳过（普通 cargo test）。

#[cfg(test)]
mod export_tests {
    use super::*;
    use ts_rs::TS;

    fn export_all_dtos() {
        // ts-rs 10 无 export_all 宏，逐个触发 TS::export_all（内部按依赖去重）。
        ProviderInfoDto::export_all().expect("导出 ProviderInfo 失败");
        GenRequest::export_all().expect("导出 GenRequest 失败");
        LayerMetaDto::export_all().expect("导出 LayerMeta 失败");
        LayerCompositionDto::export_all().expect("导出 LayerComposition 失败");
        GenerationResultDto::export_all().expect("导出 GenerationResult 失败");
        UserModelRow::export_all().expect("导出 UserModelRow 失败");
        HistoryTaskDto::export_all().expect("导出 HistoryTask 失败");
        SessionRow::export_all().expect("导出 SessionRow 失败");
        ProgressPhase::export_all().expect("导出 ProgressPhase 失败");
        ProgressPayload::export_all().expect("导出 ProgressPayload 失败");
    }

    /// 生成常量文件：progress phase 的 value 来自 Rust 枚举（唯一事实源），
    /// 类型引用 ts-rs 生成的 ProgressPhase.ts。
    fn export_constants(out_dir: &std::path::Path) {
        let phases: Vec<String> = ProgressPhase::ALL
            .iter()
            .map(|p| format!("\"{}\"", p.as_str()))
            .collect();
        let content = format!(
            "// 本文件由 `npm run typegen`（cargo test export_bindings）生成，请勿手动编辑。\n\
// 进度事件 phase 常量的唯一事实源是 Rust 侧 ProgressPhase 枚举（src-tauri/src/models.rs）。\n\
import type {{ ProgressPhase }} from \"./ProgressPhase\";\n\n\
/** gen-progress 事件阶段（与 Rust ProgressPhase 枚举一一对应） */\nexport const PROGRESS_PHASES: readonly ProgressPhase[] = [{}];\n",
            phases.join(", ")
        );
        std::fs::write(out_dir.join("constants.ts"), content).expect("写入 constants.ts 失败");
    }

    #[test]
    fn export_bindings() {
        // 经 scripts/typegen.mjs 调用时设置 TS_RS_EXPORT_DIR；普通 cargo test 跳过，
        // 避免 ts-rs 默认导出到 ./bindings。
        let Ok(out_dir) = std::env::var("TS_RS_EXPORT_DIR") else {
            eprintln!("[typegen] 跳过导出：未设置 TS_RS_EXPORT_DIR（请用 npm run typegen）");
            return;
        };
        let out_dir = std::path::PathBuf::from(out_dir);
        export_all_dtos();
        export_constants(&out_dir);
    }
}
