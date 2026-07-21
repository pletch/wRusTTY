mod coalesce;
mod connection_status;
#[cfg(target_os = "windows")]
mod hello;
mod logging;
mod profiles;
mod serial;
mod session_lock;
mod sftp;
mod ssh;
mod telnet;
mod vault;
#[cfg(target_os = "windows")]
mod win_focus;
mod window_effects;
mod workspaces;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: if a second instance launches, this
        // callback fires in the *original* process and should just focus its
        // existing window rather than let a duplicate window open.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Persists window size/position/maximized-state to disk on close and
        // restores it on the next launch — registered before the window
        // itself is built (from tauri.conf.json, as part of .run() below),
        // which is what lets it apply saved state to the very first window.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(ssh::SshState::default())
        .manage(telnet::TelnetState::default())
        .manage(serial::SerialState::default())
        .manage(profiles::ProfileState::default())
        .manage(workspaces::WorkspaceState::default())
        .manage(vault::VaultState::default())
        .manage(logging::LoggingState::default())
        .manage(sftp::SftpState::default())
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_connect_profile,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            ssh::ssh_respond_host_key,
            ssh::ssh_add_forward,
            ssh::ssh_remove_forward,
            sftp::sftp_list_dir,
            sftp::sftp_canonicalize,
            sftp::sftp_edit_file,
            sftp::sftp_stop_watching,
            telnet::telnet_connect,
            telnet::telnet_write,
            telnet::telnet_resize,
            telnet::telnet_disconnect,
            serial::serial_list_ports,
            serial::serial_connect,
            serial::serial_write,
            serial::serial_set_dtr,
            serial::serial_set_rts,
            serial::serial_send_break,
            serial::serial_disconnect,
            profiles::list_sessions,
            profiles::save_session,
            profiles::delete_session,
            profiles::reorder_sessions,
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
            logging::session_log_start,
            logging::session_log_stop,
            logging::reveal_session_logs,
            window_effects::set_window_vibrancy,
        ])
        .setup(|app| {
            migrate_from_previous_identifier(app.handle());
            vault::migrate_os_unlock_key();
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            session_lock::register(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// One-time migration for the `sh.wrshell.app` → `sh.wrustty.app` rebrand:
/// `app_data_dir`/`app_config_dir` are `${base}/${identifier}` (see Tauri's
/// `PathResolver`), so changing the identifier alone would silently orphan
/// every existing saved session, vault file, known_hosts store, and
/// window-state file at the old path. Relocates them in place if they're
/// still there and nothing's already at the new path; a no-op on every
/// later launch once that's done. Best-effort — a failure here (e.g. no
/// prior install) shouldn't block startup.
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
