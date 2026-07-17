//! Per-session transcript logging: raw PTY/serial/telnet bytes written to a
//! timestamped file, mirroring PuTTY's "log all session output". A plain
//! Rust command rather than exposing the fs plugin to the frontend, so
//! logging follows the same "Rust owns file I/O" boundary as everything else.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex as TokioMutex;

#[derive(Default)]
pub struct LoggingState {
    files: TokioMutex<HashMap<String, std::fs::File>>,
}

fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_log_dir()
        .map(|dir| dir.join("sessions"))
        .map_err(|e| e.to_string())
}

fn sanitize(label: &str) -> String {
    label
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Starts logging for `session_id`, returning the path of the created file.
#[tauri::command]
pub async fn session_log_start(
    app: AppHandle,
    session_id: String,
    label: String,
    state: State<'_, LoggingState>,
) -> Result<String, String> {
    let dir = logs_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}-{}.log", sanitize(&label), timestamp()));
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    // Session logs can contain anything typed or displayed in the
    // terminal — restrict to the owner, same as the vault and known_hosts
    // files. No-op on Windows, where the per-user %APPDATA% ACL already
    // covers this.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    state.files.lock().await.insert(session_id, file);
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn session_log_write(
    session_id: String,
    data: Vec<u8>,
    state: State<'_, LoggingState>,
) -> Result<(), String> {
    let mut files = state.files.lock().await;
    if let Some(file) = files.get_mut(&session_id) {
        file.write_all(&data).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn session_log_stop(
    session_id: String,
    state: State<'_, LoggingState>,
) -> Result<(), String> {
    state.files.lock().await.remove(&session_id);
    Ok(())
}
