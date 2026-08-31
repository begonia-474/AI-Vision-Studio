mod commands;
mod models;
mod params;
mod providers;
mod registry;
mod reveal;
mod storage;

use reqwest::Client;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .setup(|app| {
            // 解析数据目录（debug 本地 .data/，release 平台标准目录）+ 建库 + asset scope 授权。
            // 启动即完成，避免首条命令才建表带来的延迟与并发问题。
            if let Err(e) = storage::init(app.handle()) {
                eprintln!("警告：初始化存储失败: {}", e);
            } else {
                // 审计#12：inputs 参考图 GC（整目录枚举 + 逐文件 metadata/删除）原先同步
                // 阻塞窗口拉起，改为后台线程执行（目录与 schema 已在 init 内就绪）。
                std::thread::Builder::new()
                    .name("storage-startup-gc".into())
                    .spawn(storage::run_startup_gc)
                    .map_err(|e| format!("启动参考图 GC 线程失败: {e}"))?;
            }
            Ok(())
        })
        .manage(client)
        .invoke_handler(tauri::generate_handler![
            commands::list_providers,
            commands::get_app_dir,
            commands::save_api_key,
            commands::get_api_key,
            commands::delete_api_key,
            commands::test_api_key,
            commands::save_workspace_id,
            commands::get_workspace_id,
            commands::generate,
            commands::list_history,
            commands::list_history_page,
            commands::parse_history_params,
            commands::list_builtin_models,
            commands::list_sessions,
            commands::upsert_session,
            commands::delete_session,
            commands::set_star,
            commands::delete_histories,
            commands::get_layer_meta,
            commands::get_layer_composition,
            commands::export_layer_composition,
            commands::ensure_thumbnails,
            commands::list_user_models,
            commands::save_user_model,
            commands::delete_user_model,
            commands::reveal_in_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
