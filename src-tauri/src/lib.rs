#[cfg(target_os = "android")]
mod android_biometric;
#[cfg(target_os = "android")]
mod android_files;
mod atomic_file;
#[cfg(desktop)]
mod attention;
mod coalesce;
mod command_history;
mod connection_status;
// The elevated host is Windows-only; elsewhere a stand-in with the same
// commands says so, which keeps the handler list below the same everywhere.
#[cfg(windows)]
mod elevation;
#[cfg(all(desktop, not(windows)))]
#[path = "elevation_unsupported.rs"]
mod elevation;

#[cfg(desktop)]
pub use elevation::elevated_entry_point;
mod fonts;
#[cfg(target_os = "windows")]
mod hello;
#[cfg(target_os = "android")]
mod keep_alive;
#[cfg(desktop)]
mod local;
#[cfg(desktop)]
mod local_open;
#[cfg(desktop)]
mod local_shells;
mod logging;
mod profiles;
#[cfg(desktop)]
mod putty_import;
#[cfg(desktop)]
mod serial;
#[cfg(desktop)]
mod session_import;
#[cfg_attr(not(test), allow(dead_code))]
mod session_keep;
mod session_lock;
mod session_registry;
mod sftp;
#[cfg(desktop)]
mod shell_icon;
mod ssh;
#[cfg(desktop)]
mod ssh_config_import;
mod telnet;
mod theme_import;
mod vault;
mod wake;
#[cfg(target_os = "windows")]
mod win_focus;
#[cfg(desktop)]
mod window_effects;
mod workspaces;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Must be registered first: if a second instance launches, this callback
    // fires in the *original* process and should just focus its existing window
    // rather than let a duplicate window open.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    }));

    // Persists window size/position/maximized-state to disk on close and
    // restores it on the next launch — registered before the window itself is
    // built (from tauri.conf.json, as part of .run() below), which is what lets
    // it apply saved state to the very first window.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    // The transports a phone doesn't get. See docs/ANDROID_PLAN.md, "Rust gating".
    #[cfg(desktop)]
    let builder = builder
        .manage(local::LocalState::default())
        .manage(elevation::ElevatedState::default())
        .manage(serial::SerialState::default());

    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(keep_alive::init())
        .plugin(android_files::init())
        .plugin(android_biometric::init());

    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Native toasts for a command that finished while you were elsewhere.
        // See attention.rs for why the taskbar flash exists alongside it.
        .plugin(tauri_plugin_notification::init())
        .manage(ssh::SshState::default())
        .manage(telnet::TelnetState::default())
        .manage(profiles::ProfileState::default())
        .manage(command_history::HistoryState::default())
        .manage(workspaces::WorkspaceState::default())
        .manage(vault::VaultState::default())
        .manage(logging::LoggingState::default())
        .manage(sftp::SftpState::default())
        .invoke_handler(tauri::generate_handler![
            #[cfg(desktop)]
            local_open::open_local_path,
            ssh::ssh_connect,
            ssh::ssh_connect_profile,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            ssh::ssh_respond_host_key,
            ssh::ssh_respond_auth_prompt,
            ssh::ssh_list_known_hosts,
            ssh::ssh_forget_host_key,
            ssh::ssh_forget_host,
            ssh::ssh_add_forward,
            ssh::ssh_remove_forward,
            ssh::ssh_list_forwards,
            ssh::ssh_retry_forward,
            wake::wake_host,
            fonts::list_fonts,
            theme_import::read_theme_file,
            sftp::sftp_list_dir,
            sftp::sftp_canonicalize,
            #[cfg(desktop)]
            sftp::sftp_edit_file,
            sftp::sftp_list_edits,
            sftp::sftp_save_edit,
            sftp::sftp_respond_sudo_prompt,
            sftp::sftp_elevate_edit,
            sftp::sftp_remote_identity,
            sftp::sftp_stop_watching,
            sftp::sftp_exists,
            sftp::sftp_upload_begin,
            sftp::sftp_upload_chunk,
            sftp::sftp_upload_finish,
            sftp::sftp_upload_path,
            sftp::sftp_download_begin,
            sftp::sftp_cancel_transfer,
            sftp::sftp_rename,
            sftp::sftp_remove,
            sftp::sftp_mkdir,
            sftp::sftp_chmod,
            sftp::sftp_count_tree,
            telnet::telnet_connect,
            telnet::telnet_write,
            telnet::telnet_resize,
            telnet::telnet_disconnect,
            #[cfg(desktop)]
            local_shells::local_list_shells,
            #[cfg(desktop)]
            shell_icon::local_shell_icon,
            #[cfg(desktop)]
            elevation::elevated_connect,
            #[cfg(desktop)]
            elevation::elevated_write,
            #[cfg(desktop)]
            elevation::elevated_resize,
            #[cfg(desktop)]
            elevation::elevated_disconnect,
            #[cfg(desktop)]
            local::local_connect,
            #[cfg(desktop)]
            local::local_connect_profile,
            #[cfg(desktop)]
            local::local_write,
            #[cfg(desktop)]
            local::local_resize,
            #[cfg(desktop)]
            local::local_disconnect,
            #[cfg(desktop)]
            serial::serial_list_ports,
            #[cfg(desktop)]
            serial::serial_connect,
            #[cfg(desktop)]
            serial::serial_write,
            #[cfg(desktop)]
            serial::serial_connect_profile,
            #[cfg(desktop)]
            serial::serial_set_dtr,
            #[cfg(desktop)]
            serial::serial_set_rts,
            #[cfg(desktop)]
            serial::serial_send_break,
            #[cfg(desktop)]
            serial::serial_disconnect,
            profiles::list_sessions,
            profiles::save_session,
            profiles::delete_session,
            profiles::reorder_sessions,
            command_history::command_history_record,
            command_history::command_history_suggest,
            command_history::command_history_accepted,
            command_history::command_history_list,
            command_history::command_history_forget,
            command_history::command_history_allow,
            command_history::command_history_forget_imported,
            command_history::command_history_harvest,
            #[cfg(desktop)]
            putty_import::putty_sessions_available,
            #[cfg(desktop)]
            putty_import::putty_import_sessions,
            #[cfg(desktop)]
            ssh_config_import::ssh_config_sessions_available,
            #[cfg(desktop)]
            ssh_config_import::ssh_config_import_sessions,
            workspaces::list_workspaces,
            workspaces::save_workspace,
            workspaces::delete_workspace,
            vault::vault_status,
            vault::vault_create,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_delete,
            vault::vault_set_credential,
            vault::vault_import_key,
            vault::vault_delete_credential,
            vault::vault_has_credential,
            vault::vault_export,
            vault::vault_import,
            vault::vault_os_unlock_available,
            vault::vault_os_unlock_method,
            vault::vault_enable_os_unlock,
            vault::vault_disable_os_unlock,
            vault::vault_unlock_with_os,
            vault::vault_begin_master_password_reset,
            vault::vault_reset_master_password,
            logging::session_log_start,
            logging::session_log_stop,
            logging::reveal_session_logs,
            logging::write_pane_dump,
            #[cfg(desktop)]
            window_effects::set_window_vibrancy,
            #[cfg(target_os = "android")]
            keep_alive::keep_alive_set_sessions,
            coalesce::delivery_stats,
            coalesce::reset_delivery_stats,
            coalesce::ack_delivery,
            coalesce::set_inflight_window,
            #[cfg(desktop)]
            attention::flash_window,
        ])
        .setup(|app| {
            migrate_from_previous_identifier(app.handle());
            vault::migrate_os_unlock_key();
            // Registered in release builds too: the webview console isn't visible on a
            // user's machine, so frontend faults (reportEngineFailure in
            // components/Terminal.tsx) land in %LOCALAPPDATA%/sh.wrustty.app/logs. In
            // release, third-party crates are capped at warn, since russh and wry
            // narrate connection detail at info/debug.
            let log_builder = if cfg!(debug_assertions) {
                tauri_plugin_log::Builder::default().level(log::LevelFilter::Info)
            } else {
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Warn)
                    .level_for("wrustty_lib", log::LevelFilter::Info)
                    // Frontend records arrive as target `webview:<location>`;
                    // fern matches per-target filters by prefix, so this one
                    // covers every location.
                    .level_for(tauri_plugin_log::WEBVIEW_TARGET, log::LevelFilter::Info)
            };
            app.handle().plugin(log_builder.build())?;
            session_lock::register(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// One-time migration for the `sh.wrshell.app` to `sh.wrustty.app` rename:
/// app data and config dirs are `${base}/${identifier}`, so existing sessions,
/// vault, known_hosts and window state are moved if still at the old path and
/// nothing is at the new one. Best-effort; never blocks startup.
fn migrate_from_previous_identifier(app: &tauri::AppHandle) {
    const PREVIOUS_IDENTIFIER: &str = "sh.wrshell.app";

    let path = app.path();
    let bases = [path.data_dir(), path.config_dir()];
    let new_dirs = [path.app_data_dir(), path.app_config_dir()];

    for (old_base, new_dir) in bases.into_iter().zip(new_dirs) {
        let (Ok(old_base), Ok(new_dir)) = (old_base, new_dir) else {
            continue;
        };
        let old_dir = old_base.join(PREVIOUS_IDENTIFIER);
        if old_dir.exists() && !new_dir.exists() {
            if let Err(e) = std::fs::rename(&old_dir, &new_dir) {
                log::warn!(
                    "failed to migrate app data from {} to {}: {e}",
                    old_dir.display(),
                    new_dir.display()
                );
            }
        }
    }
}
