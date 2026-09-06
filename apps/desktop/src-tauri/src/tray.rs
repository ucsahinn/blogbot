use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Manager,
};

#[derive(Debug, Clone, Copy)]
pub struct TrayProjection {
    pub connected: bool,
    pub review_count: usize,
    pub failure_count: usize,
    pub scheduled_count: usize,
}

#[derive(Debug, PartialEq, Eq)]
struct TrayLabels {
    connection: String,
    approvals: String,
    failures: String,
    upcoming: String,
}

struct ReviewNotificationState {
    initialized: bool,
    count: usize,
}

struct TrayStatusItems {
    connection: MenuItem<tauri::Wry>,
    approvals: MenuItem<tauri::Wry>,
    failures: MenuItem<tauri::Wry>,
    upcoming: MenuItem<tauri::Wry>,
    review_notification: Mutex<ReviewNotificationState>,
}

fn project_labels(projection: TrayProjection) -> TrayLabels {
    TrayLabels {
        connection: if projection.connected {
            "Bağlantı · hazır".to_string()
        } else {
            "Bağlantı · kullanılamıyor".to_string()
        },
        approvals: format!("Onay bekleyen · {}", projection.review_count),
        failures: format!("Başarısız iş · {}", projection.failure_count),
        upcoming: format!("Yaklaşan yayın · {}", projection.scheduled_count),
    }
}

fn review_ready_transition(initialized: bool, previous: usize, current: usize) -> bool {
    initialized && current > previous
}

pub fn update(app: &AppHandle, projection: TrayProjection) -> Result<bool, String> {
    let labels = project_labels(projection);
    let items = app.state::<TrayStatusItems>();
    items
        .connection
        .set_text(labels.connection)
        .map_err(|error| error.to_string())?;
    items
        .approvals
        .set_text(labels.approvals)
        .map_err(|error| error.to_string())?;
    items
        .failures
        .set_text(labels.failures)
        .map_err(|error| error.to_string())?;
    items
        .upcoming
        .set_text(labels.upcoming)
        .map_err(|error| error.to_string())?;

    let mut review = items
        .review_notification
        .lock()
        .map_err(|_| "TRAY_REVIEW_STATE_UNAVAILABLE".to_string())?;
    let notify = review_ready_transition(review.initialized, review.count, projection.review_count);
    review.initialized = true;
    review.count = projection.review_count;
    Ok(notify)
}

pub fn install(app: &mut App) -> tauri::Result<()> {
    let connection = MenuItem::with_id(
        app,
        "connection",
        "Bağlantı · kontrol bekliyor",
        false,
        None::<&str>,
    )?;
    let approvals = MenuItem::with_id(
        app,
        "approvals",
        "Onay bekleyen · eşitleme bekleniyor",
        false,
        None::<&str>,
    )?;
    let failures = MenuItem::with_id(
        app,
        "failures",
        "Başarısız iş · eşitleme bekleniyor",
        false,
        None::<&str>,
    )?;
    let upcoming = MenuItem::with_id(
        app,
        "upcoming",
        "Yaklaşan yayın · eşitleme bekleniyor",
        false,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "open", "OPE'yi aç", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "Şimdi eşitle", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Güvenli biçimde çık", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &connection,
            &approvals,
            &failures,
            &upcoming,
            &open,
            &sync,
            &quit,
        ],
    )?;
    app.manage(TrayStatusItems {
        connection: connection.clone(),
        approvals: approvals.clone(),
        failures: failures.clone(),
        upcoming: upcoming.clone(),
        review_notification: Mutex::new(ReviewNotificationState {
            initialized: false,
            count: 0,
        }),
    });

    let mut builder = TrayIconBuilder::new()
        .tooltip("OPE · OpenPostEditör")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "sync" => {
                let _ = app.emit("blogbot-sync-requested", ());
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                // "Safe quit" must actually be safe: stop the owned sidecar and
                // the local dev-server tree here, because app.exit ends the
                // event loop without unwinding managed state.
                crate::shutdown_owned_processes(app);
                app.exit(0);
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{project_labels, review_ready_transition, TrayProjection};

    #[test]
    fn live_projection_updates_all_four_tray_rows() {
        let labels = project_labels(TrayProjection {
            connected: true,
            review_count: 3,
            failure_count: 2,
            scheduled_count: 4,
        });

        assert_eq!(labels.connection, "Bağlantı · hazır");
        assert_eq!(labels.approvals, "Onay bekleyen · 3");
        assert_eq!(labels.failures, "Başarısız iş · 2");
        assert_eq!(labels.upcoming, "Yaklaşan yayın · 4");
    }

    #[test]
    fn a_new_review_count_notifies_once_but_bootstrap_and_repeats_do_not() {
        assert!(!review_ready_transition(false, 0, 2));
        assert!(review_ready_transition(true, 2, 3));
        assert!(!review_ready_transition(true, 3, 3));
        assert!(!review_ready_transition(true, 3, 1));
    }
}
