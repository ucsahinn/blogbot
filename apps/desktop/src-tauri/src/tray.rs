use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, Emitter, Manager,
};

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
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
