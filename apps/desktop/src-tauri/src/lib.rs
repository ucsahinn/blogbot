mod commands;
mod engine_bridge;
mod notifications;
mod secure_store;
mod tray;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(commands::DesktopState::default())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let bridge = engine_bridge::EngineBridge::discover(app.handle());
            // Never block the WebView startup on a sidecar handshake. A
            // damaged/migrating local database, a missing packaged asset, or
            // a temporarily unavailable engine must leave the UI usable so
            // Doctor can explain and recover it instead of making the exe
            // appear frozen.
            let runtime_ready = bridge.is_running();
            if let Ok(directory) = app.path().app_local_data_dir() {
                let directory = directory
                    .parent()
                    .map(std::path::Path::to_path_buf)
                    .unwrap_or(directory)
                    .join("Blogbot")
                    .join("diagnostics");
                let _ = std::fs::create_dir_all(&directory);
                let detail = format!(
                    "engine_running={}\nlast_error={}\n",
                    runtime_ready,
                    bridge.last_error().unwrap_or_else(|| "none".to_string())
                );
                let _ = std::fs::write(directory.join("startup-state.log"), detail);
            }
            commands::set_engine_ready(&app.state::<commands::DesktopState>(), runtime_ready);
            app.manage(bridge);
            tray::install(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap_snapshot,
            commands::engine_doctor,
            commands::get_prerequisite_status,
            commands::test_setup_connector,
            commands::save_setup_connector,
            commands::github_device_flow_start,
            commands::github_device_flow_status,
            commands::github_validate_repository,
            commands::github_preview_pull_request,
            commands::test_codex_runtime,
            commands::start_codex_login,
            commands::test_local_engine,
            commands::pick_local_folder,
            commands::local_dev_status,
            commands::start_local_dev,
            commands::stop_local_dev,
            commands::get_local_dev_logs,
            commands::list_sources,
            commands::test_source,
            commands::scan_source,
            commands::scan_all_sources,
            commands::get_source_scan_status,
            commands::preview_opml,
            commands::save_sources,
            commands::create_instant_draft,
            commands::get_review_revision,
            commands::approve_revision,
            commands::approve_high_risk_revision,
            commands::enqueue_publication,
            commands::materialize_local_preview,
            commands::preview_publication,
            commands::get_operations,
            commands::get_engine_diagnostics,
            commands::export_diagnostics,
            commands::get_editorial_workspace,
            commands::promote_candidate,
            commands::dismiss_candidate,
            commands::retry_job,
            commands::request_revision_edit,
            commands::update_schedule_slot,
            commands::save_desktop_preferences,
            commands::complete_onboarding,
            commands::set_runtime_pause,
            commands::secure_store_status,
            commands::send_test_notification,
            commands::autostart_status,
            commands::set_autostart
            ,commands::backup_verify
            ,commands::backup_create
            ,commands::backup_restore_preview
            ,commands::backup_restore_apply
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("Blogbot desktop runtime failed");
}
