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
        .build()
        .expect("failed to build http client");

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(client)
        .invoke_handler(tauri::generate_handler![
            commands::list_providers,
            commands::save_api_key,
            commands::get_api_key,
            commands::delete_api_key,
            commands::test_api_key,
            commands::generate,
            commands::list_history,
            commands::set_star,
            commands::delete_histories,
            commands::list_custom_providers,
            commands::save_custom_provider,
            commands::delete_custom_provider,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
