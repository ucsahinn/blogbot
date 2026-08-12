fn main() {
    const COMMANDS: &[&str] = &[
        "get_bootstrap_snapshot", "engine_doctor", "get_prerequisite_status",
        "test_setup_connector", "save_setup_connector", "get_connector_state",
        "github_device_flow_status", "github_validate_repository",
        "github_preview_pull_request", "test_codex_runtime", "start_codex_login",
        "test_local_engine", "verify_local_integrity", "recover_local_workspace", "pick_local_folder", "local_dev_status", "start_local_dev",
        "stop_local_dev", "list_sources", "test_source", "scan_source",
        "scan_all_sources", "get_source_scan_status", "preview_opml", "save_sources", "review_source",
        "create_instant_draft", "get_review_revision", "read_revision_media", "repair_revision_media", "approve_revision",
        "approve_high_risk_revision", "enqueue_publication", "materialize_local_preview",
        "preview_publication", "get_operations", "get_engine_diagnostics", "export_diagnostics",
        "get_editorial_workspace", "promote_candidate", "dismiss_candidate", "retry_job",
        "request_revision_edit", "update_schedule_slot", "save_desktop_preferences",
        "complete_onboarding", "set_runtime_pause", "secure_store_status",
        "send_test_notification", "autostart_status", "set_autostart", "backup_verify",
        "backup_create", "backup_restore_preview", "backup_restore_apply",
        "automatic_backup_list", "automatic_backup_verify",
        "automatic_backup_restore_preview", "automatic_backup_restore_apply",
        "check_unsigned_update", "install_unsigned_update", "open_project_page",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Blogbot Tauri ACL manifest");
}
