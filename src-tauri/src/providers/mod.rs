pub mod dashscope;
pub mod kling;
pub mod minimax;
pub mod modelscope;
pub mod volcark;

pub use dashscope::DashScopeProvider;
pub use kling::KlingProvider;
pub use minimax::MiniMaxProvider;
pub use modelscope::ModelScopeProvider;
pub use volcark::VolcArkProvider;

use async_trait::async_trait;

use crate::models::{GenRequest, ProviderInfoDto, TaskHandle, TaskSnapshot};

/// 统一生成提供商契约。同步厂商（豆包图像/通义 wan2.6/MiniMax 图像）与异步厂商
/// （豆包视频/可灵/通义视频/MiniMax 视频）实现同一接口。
/// 下载落盘不放在 trait 内，由 commands 层调用 storage 完成，使 provider 与本地存储解耦。
#[async_trait]
pub trait GenerationProvider: Send + Sync {
    /// 提交生成任务。同步厂商返回 Succeeded + remote_urls；异步厂商返回 Submitted + task_id。
    async fn submit(&self, req: &GenRequest, api_key: &str) -> Result<TaskHandle, String>;
    /// 推进任务状态。同步厂商立即返回终态；异步厂商调原厂查询接口，
    /// Succeeded 时在 snapshot.remote_urls 填入结果 URL（含 MiniMax 的二次 file 拉取）。
    async fn poll(&self, handle: &TaskHandle, api_key: &str) -> Result<TaskSnapshot, String>;
    /// 廉价鉴权校验（不产生生成消耗）。
    async fn test_connectivity(&self, api_key: &str) -> Result<String, String>;
    /// 默认模型标识。
    fn default_model(&self) -> &str;
}

/// 响应体写库前脱敏：JSON 中超过阈值的字符串（base64 图像块、data URL 等）
/// 替换为长度标记，保留结构便于阅读；非 JSON 响应超长时按字符数截断。
/// 保证单条记录体积有界，数据库不因图像数据膨胀。
pub fn sanitize_body(text: &str) -> String {
    const MAX_STR: usize = 2048;
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(v) => serde_json::to_string(&truncate_json_strings(v, MAX_STR)).unwrap_or_default(),
        Err(_) if text.chars().count() > MAX_STR * 4 => {
            let head: String = text.chars().take(MAX_STR).collect();
            format!("<非 JSON 响应过长，前 {} 字符: {}…>", MAX_STR, head)
        }
        Err(_) => text.to_string(),
    }
}

fn truncate_json_strings(v: serde_json::Value, max: usize) -> serde_json::Value {
    match v {
        serde_json::Value::String(s) if s.chars().count() > max => {
            serde_json::Value::String(format!("<省略超长文本，原 {} 字符>", s.chars().count()))
        }
        serde_json::Value::Array(a) => serde_json::Value::Array(
            a.into_iter()
                .map(|x| truncate_json_strings(x, max))
                .collect(),
        ),
        serde_json::Value::Object(o) => serde_json::Value::Object(
            o.into_iter()
                .map(|(k, x)| (k, truncate_json_strings(x, max)))
                .collect(),
        ),
        other => other,
    }
}

/// 已注册厂商的元信息列表（全部为内置厂商）。
pub fn all_providers() -> Vec<ProviderInfoDto> {
    vec![
        VolcArkProvider::info(),
        MiniMaxProvider::info(),
        DashScopeProvider::info(),
        KlingProvider::info(),
        ModelScopeProvider::info(),
    ]
}

/// 按 id 取一个 provider 实例。未命中返回 None。
pub fn get_provider(id: &str, client: reqwest::Client) -> Option<Box<dyn GenerationProvider>> {
    match id {
        "volcark" => Some(Box::new(VolcArkProvider::new(client))),
        "minimax" => Some(Box::new(MiniMaxProvider::new(client))),
        "wanxiang" => Some(Box::new(DashScopeProvider::new(client))),
        "kling" => Some(Box::new(KlingProvider::new(client))),
        "modelscope" => Some(Box::new(ModelScopeProvider::new(client))),
        _ => None,
    }
}
