pub mod kling;
pub mod minimax;
pub mod volcark;
pub mod wanxiang;

pub use kling::KlingProvider;
pub use minimax::MiniMaxProvider;
pub use volcark::VolcArkProvider;
pub use wanxiang::WanxiangProvider;

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

/// 已注册厂商的元信息列表。
pub fn all_providers() -> Vec<ProviderInfoDto> {
    vec![
        VolcArkProvider::info(),
        MiniMaxProvider::info(),
        WanxiangProvider::info(),
        KlingProvider::info(),
    ]
}

/// 按 id 取一个 provider 实例。未命中返回 None。
pub fn get_provider(id: &str, client: reqwest::Client) -> Option<Box<dyn GenerationProvider>> {
    match id {
        "volcark" => Some(Box::new(VolcArkProvider::new(client))),
        "minimax" => Some(Box::new(MiniMaxProvider::new(client))),
        "wanxiang" => Some(Box::new(WanxiangProvider::new(client))),
        "kling" => Some(Box::new(KlingProvider::new(client))),
        _ => None,
    }
}
