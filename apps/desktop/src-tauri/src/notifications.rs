use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

#[allow(dead_code)]
pub fn show_review_ready(app: &AppHandle, title: &str) -> Result<(), String> {
    app.notification()
        .builder()
        .title("OPE · İnceleme hazır")
        .body(title)
        .show()
        .map_err(|error| error.to_string())
}
