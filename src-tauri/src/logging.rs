//! Per-session transcript logging: raw PTY/serial/telnet bytes written to a
//! timestamped file, mirroring PuTTY's "log all session output". The bytes
//! are written here, on the Rust side of the coalescer (see `coalesce.rs`),
//! not round-tripped back from the webview — the frontend only toggles
//! logging on/off. Besides skipping a whole IPC hop (as a JSON number
//! array, no less) on the output hot path, this means the log stays
//! complete even if the webview stalls or drops output.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct LoggingState {
    // A std (not tokio) mutex: `write` is called from the coalescer's flush
    // path, which is synchronous, and the critical section is one file
    // write — nothing awaits while holding it.
    files: Mutex<HashMap<String, std::fs::File>>,
}

/// Appends `bytes` to `session_id`'s log file, if logging is active for
/// that session (silently a no-op otherwise). Called by the coalescer on
/// every flush, so PTY output is logged exactly as it's sent to the UI.
pub(crate) fn write(state: &LoggingState, session_id: &str, bytes: &[u8]) {
    let mut files = state.files.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(file) = files.get_mut(session_id) {
        if let Err(e) = file.write_all(bytes) {
            log::warn!("session log write failed for {session_id}: {e}");
        }
    }
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
    state
        .files
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(session_id, file);
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn session_log_stop(
    session_id: String,
    state: State<'_, LoggingState>,
) -> Result<(), String> {
    state
        .files
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&session_id);
    Ok(())
}
