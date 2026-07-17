mod coalesce;
mod connection_status;
mod logging;
mod profiles;
mod serial;
mod session_lock;
mod sftp;
mod ssh;
mod telnet;
mod vault;

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
        .manage(ssh::SshState::default())
        .manage(telnet::TelnetState::default())
        .manage(serial::SerialState::default())
        .manage(profiles::ProfileState::default())
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
            serial::serial_disconnect,
            profiles::list_sessions,
            profiles::save_session,
            profiles::delete_session,
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
            vault::vault_enable_os_unlock,
            vault::vault_disable_os_unlock,
            vault::vault_unlock_with_os,
            logging::session_log_start,
            logging::session_log_write,
            logging::session_log_stop,
        ])
        .setup(|app| {
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
