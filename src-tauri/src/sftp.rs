//! Tauri command layer for SFTP: remote directory browsing, plus
//! download-watch-reupload file editing layered on an existing SSH
//! session's (lazily-opened, connection-lifetime) SFTP subsystem channel.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex as TokioMutex;
use wr_sftp::RemoteEntry;

use crate::ssh::SshState;

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SftpEvent {
    Uploading {
        edit_id: String,
        remote_path: String,
    },
    Uploaded {
        edit_id: String,
        remote_path: String,
    },
    UploadFailed {
        edit_id: String,
        remote_path: String,
        error: String,
    },
}

struct EditEntry {
    session_id: String,
    remote_path: String,
    local_path: PathBuf,
    // Held only for their Drop impls: dropping the debouncer stops the
    // watcher thread, and dropping the TempDir deletes the directory (and
    // the file inside it) from disk.
    _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
    _temp_dir: tempfile::TempDir,
}

#[derive(Default)]
pub struct SftpState {
    edits: TokioMutex<HashMap<String, EditEntry>>,
    next_id: AtomicU64,
}

impl SftpState {
    fn next_edit_id(&self) -> String {
        format!("edit-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }
}

#[tauri::command]
pub async fn sftp_list_dir(
    session_id: String,
    path: String,
    ssh_state: State<'_, SshState>,
) -> Result<Vec<RemoteEntry>, String> {
    let session = crate::ssh::lookup(&ssh_state, &session_id).await?;
    let sftp = session
        .lock()
        .await
        .get_or_open_sftp()
        .await
        .map_err(|e| e.to_string())?;
    sftp.list_dir(&path).await.map_err(|e| e.to_string())
}

/// Resolves `.`/`""` to the real remote home directory, so the file browser
/// has a sensible starting point instead of guessing `/home/<user>`.
#[tauri::command]
pub async fn sftp_canonicalize(
    session_id: String,
    path: String,
    ssh_state: State<'_, SshState>,
) -> Result<String, String> {
    let session = crate::ssh::lookup(&ssh_state, &session_id).await?;
    let sftp = session
        .lock()
        .await
        .get_or_open_sftp()
        .await
        .map_err(|e| e.to_string())?;
    sftp.canonicalize(&path).await.map_err(|e| e.to_string())
}

/// Downloads a remote file to a local temp copy, opens it in the OS's
/// default application for that file type, and watches it for changes —
/// re-uploading over SFTP on every save. Returns an edit id that identifies
/// this watch (for `sftp_stop_watching`).
///
/// If the same remote file is already being watched, reuses the existing
/// temp file/watcher instead of starting a second, competing one.
#[tauri::command]
pub async fn sftp_edit_file(
    app: AppHandle,
    session_id: String,
    remote_path: String,
    channel: Channel<SftpEvent>,
    ssh_state: State<'_, SshState>,
    sftp_state: State<'_, SftpState>,
) -> Result<String, String> {
    {
        let edits = sftp_state.edits.lock().await;
        if let Some((id, entry)) = edits
            .iter()
            .find(|(_, e)| e.session_id == session_id && e.remote_path == remote_path)
        {
            let local_path = entry.local_path.clone();
            let id = id.clone();
            drop(edits);
            app.opener()
                .open_path(local_path.to_string_lossy(), None::<&str>)
                .map_err(|e| e.to_string())?;
            return Ok(id);
        }
    }

    let session = crate::ssh::lookup(&ssh_state, &session_id).await?;
    let sftp = session
        .lock()
        .await
        .get_or_open_sftp()
        .await
        .map_err(|e| e.to_string())?;
    let bytes = sftp.read(&remote_path).await.map_err(|e| e.to_string())?;

    // Lands under the OS temp dir, not app-private storage — external
    // editors expect a normal-looking path, and the basename is preserved
    // (rather than a generated id) so the editor's title bar and any
    // extension-based syntax highlighting behave the same as opening the
    // file directly.
    let basename = remote_path
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("remote-file");
    // `rsplit('/')` already rules out a forward slash, but a hostile or
    // just differently-shaped server could still hand back `..` itself or
    // a name containing a backslash (a path separator on Windows, where
    // this temp file eventually gets opened) — either could escape the
    // freshly created temp directory once joined onto it.
    if basename == ".." || basename.contains('\\') {
        return Err(format!("unsafe remote filename: {basename}"));
    }
    let temp_dir = tempfile::Builder::new()
        .prefix(&format!("wr-shell-sftp-{session_id}-"))
        .tempdir()
        .map_err(|e| e.to_string())?;
    let local_path = temp_dir.path().join(basename);
    std::fs::write(&local_path, &bytes).map_err(|e| e.to_string())?;

    app.opener()
        .open_path(local_path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())?;

    let edit_id = sftp_state.next_edit_id();
    let watch_path = local_path.clone();
    let watch_remote_path = remote_path.clone();
    let watch_edit_id = edit_id.clone();
    let watch_session = session.clone();
    // The debouncer's callback runs on its own plain OS thread, not on the
    // tokio runtime — spawn back onto the runtime to do the actual
    // (async) re-read + re-upload + event push.
    let rt_handle = tokio::runtime::Handle::current();

    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            if !events.iter().any(|e| e.paths.contains(&watch_path)) {
                return;
            }
            let local_path = watch_path.clone();
            let remote_path = watch_remote_path.clone();
            let edit_id = watch_edit_id.clone();
            let session = watch_session.clone();
            let channel = channel.clone();
            rt_handle.spawn(async move {
                let _ = channel.send(SftpEvent::Uploading {
                    edit_id: edit_id.clone(),
                    remote_path: remote_path.clone(),
                });
                let result: Result<(), String> = async {
                    let bytes = tokio::fs::read(&local_path)
                        .await
                        .map_err(|e| e.to_string())?;
                    let sftp = session
                        .lock()
                        .await
                        .get_or_open_sftp()
                        .await
                        .map_err(|e| e.to_string())?;
                    sftp.write(&remote_path, &bytes)
                        .await
                        .map_err(|e| e.to_string())
                }
                .await;
                let event = match result {
                    Ok(()) => SftpEvent::Uploaded {
                        edit_id,
                        remote_path,
                    },
                    Err(error) => SftpEvent::UploadFailed {
                        edit_id,
                        remote_path,
                        error,
                    },
                };
                let _ = channel.send(event);
            });
        },
    )
    .map_err(|e| e.to_string())?;

    // Watching the parent directory (not the file itself) non-recursively
    // catches editors that save via delete-and-recreate or
    // write-swap-then-rename, not just in-place writes — a direct watch on
    // the file can end up bound to an inode that gets unlinked on save.
    debouncer
        .watcher()
        .watch(temp_dir.path(), RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    sftp_state.edits.lock().await.insert(
        edit_id.clone(),
        EditEntry {
            session_id,
            remote_path,
            local_path,
            _debouncer: debouncer,
            _temp_dir: temp_dir,
        },
    );

    Ok(edit_id)
}

/// Stops watching an edit and deletes its local temp copy. This deletes the
/// local file even if the external editor still has unsaved changes open —
/// the frontend should warn before calling this.
#[tauri::command]
pub async fn sftp_stop_watching(
    edit_id: String,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    sftp_state.edits.lock().await.remove(&edit_id);
    Ok(())
}

/// Removes every edit watch tied to a session that just disconnected —
/// called from `ssh::ssh_disconnect`.
pub(crate) async fn stop_watching_session(sftp_state: &SftpState, session_id: &str) {
    let stale: Vec<String> = {
        let edits = sftp_state.edits.lock().await;
        edits
            .iter()
            .filter(|(_, e)| e.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect()
    };
    for edit_id in stale {
        sftp_state.edits.lock().await.remove(&edit_id);
    }
}
