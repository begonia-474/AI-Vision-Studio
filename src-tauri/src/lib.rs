mod commands;
mod models;
mod providers;
mod storage;

use reqwest::Client;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动即建库，避免首条命令才建表带来的延迟与并发问题。
    if let Err(e) = storage::ensure_schema() {
        eprintln!("警告：初始化历史库失败: {}", e);
    }

    let client = Client::builder()
        .user_agent("AIVisionStudio/0.1")
        // 超时保护：无超时下 TCP 悬挂/厂商无响应会让任务永久卡 loading。
        // 连接 20s；整请求 120s（提交/轮询均在此内）；大文件下载在 save_remote 单独放宽。
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .expect("failed to build http client");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(client)
        .invoke_handler(tauri::generate_handler![
            commands::list_providers,
            commands::save_api_key,
            commands::get_api_key,
            commands::delete_api_key,
            commands::test_api_key,
            commands::save_workspace_id,
            commands::get_workspace_id,
            commands::generate,
            commands::list_history,
            commands::list_sessions,
            commands::upsert_session,
            commands::delete_session,
            commands::set_star,
            commands::delete_histories,
            commands::ensure_thumbnails,
            commands::list_user_models,
            commands::save_user_model,
            commands::delete_user_model,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
