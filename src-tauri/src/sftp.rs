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

/// One live edit watch, as reported to the frontend by `sftp_list_edits`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveEdit {
    pub edit_id: String,
    pub remote_path: String,
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
        .ready()?
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
        .ready()?
        .get_or_open_sftp()
        .await
        .map_err(|e| e.to_string())?;
    sftp.canonicalize(&path).await.map_err(|e| e.to_string())
}

/// Extensions handed to the OS opener without asking first.
///
/// The path-traversal check further down guards the *filename*; this guards
/// what happens once the file is opened, which is the larger risk. Opening
/// dispatches to the OS default handler by extension, and on Windows a
/// remote `.hta`, `.lnk`, `.scr`, `.js`, `.wsf`, `.ps1` or `.bat` runs on
/// double-click. The user did click a file in the Files panel, so this is not
/// a silent RCE — but "I opened a file to read it" and "I ran a program a
/// remote host gave me" should not be the same gesture, and the panel gives
/// no indication that they are.
///
/// So: inert-on-every-platform opens directly, everything else asks. Note the
/// omissions — `.js` and `.py` are text a user plausibly wants to edit over
/// SFTP, but both have an *executing* default handler on Windows (Windows
/// Script Host and the `py` launcher), which is precisely the case this
/// exists to catch. An extra click on those is the cost of the list meaning
/// something.
const INERT_EXTENSIONS: &[&str] = &[
    "txt",
    "md",
    "markdown",
    "rst",
    "log",
    "text",
    "conf",
    "cfg",
    "ini",
    "yaml",
    "yml",
    "toml",
    "json",
    "xml",
    "csv",
    "tsv",
    "properties",
    "env",
    "diff",
    "patch",
    "sql",
    "sh",
    "bash",
    "zsh",
    "fish",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "rs",
    "go",
    "java",
    "kt",
    "rb",
    "php",
    "pl",
    "lua",
    "ts",
    "tsx",
    "jsx",
    "css",
    "scss",
    "gitignore",
    // `sshd.service`, `centos.repo`, `sources.list` — these three do reach the
    // extension branch. `dockerfile` did not: the file is called `Dockerfile`,
    // which has no dot and is already inert via the `None` branch, so the entry
    // only ever matched `something.dockerfile`.
    "service",
    "repo",
    "list",
];

// Deliberately *not* inert, though it is plain text and looks like it belongs:
//
// `svg`. On Windows the default `.svg` handler is a browser — Edge, out of the
// box. SVG is XML that can carry `<script>`, and opening one from a `file://`
// temp path executes it. It is a weaker primitive than `.hta` (browser sandbox,
// opaque origin, no direct filesystem reach) but it is still script execution
// from a file a remote host chose the contents of, which is the line this list
// is drawn along. Everything remaining above is inert in every handler it
// plausibly reaches. The cost is one extra click for someone editing an SVG
// over SFTP.

/// Windows filename classes that a POSIX-shaped `..`/separator check doesn't
/// cover, and that a remote host chooses the name for.
///
/// Applied on every platform rather than under `cfg(windows)`. A name that is
/// unsafe on the primary target isn't worth accepting on a dev machine either,
/// and gating it would mean the tests below say nothing on a Linux CI runner.
///
/// - **Reserved device names.** `tempdir.join("NUL")` opens the null device,
///   not a file. The write succeeds, the watcher watches nothing, and the
///   re-upload has nothing to send — the user edits what they think is a remote
///   file and loses the work silently. `NUL.txt` is still `NUL`, hence the
///   comparison against the stem.
/// - **Alternate data streams.** `notes.txt:payload` joins to a stream on
///   `notes.txt` rather than a file of its own, and nothing in Explorer shows
///   it. (The extension check reads `txt:payload` and prompts, so this is
///   defence in depth rather than the only guard.)
/// - **Trailing dots and spaces.** Stripped during path normalisation, so the
///   path written isn't the name asked for.
/// - **Characters Windows simply forbids.** `< > " | ? *` are not a hazard —
///   the write fails either way — they are here so that it fails with this
///   function's message naming the file, rather than with a raw OS error from
///   `std::fs::write` about a path the user never typed. A remote host is
///   entitled to name a file `what?`, and someone on Linux editing it through
///   this deserves to be told why it can't be edited from here.
fn is_unsafe_windows_filename(basename: &str) -> bool {
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = basename.split('.').next().unwrap_or("");
    basename.contains(':')
        || basename.contains(['<', '>', '"', '|', '?', '*'])
        || basename.ends_with(' ')
        || basename.ends_with('.')
        || RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r))
}

/// Whether `basename` can go straight to the OS opener.
///
/// The comparison is on the *last* extension only, which is the one the OS
/// dispatches on — so `notes.txt.exe` is correctly treated as an `exe`, not
/// as a text file. A name with no extension at all is inert: there's no
/// handler to dispatch to, and the OS falls back to an "open with" chooser.
fn is_inert_to_open(basename: &str) -> bool {
    match basename.rsplit_once('.') {
        None => true,
        Some((stem, ext)) => {
            // A leading-dot name like `.bashrc` is a stem, not an extension.
            if stem.is_empty() {
                return true;
            }
            let ext = ext.to_ascii_lowercase();
            INERT_EXTENSIONS.contains(&ext.as_str())
        }
    }
}

/// Asks before opening something whose handler might execute it. Same shape
/// as a browser's download warning, and defaults to not opening: a dismissed
/// or failed dialog reads as "no".
async fn confirm_risky_open(app: &AppHandle, basename: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "\"{basename}\" is a type of file that can run code when it is opened, \
             and it came from the remote host.\n\n\
             Only open it if you trust that host. Open anyway?"
        ))
        .title("Open remote file?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });

    rx.await.unwrap_or(false)
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
            // Re-asked on every open, not just the first. The warning is
            // about the act of opening, and a watch that's already running
            // isn't evidence the user meant to open it again.
            let basename = local_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if !is_inert_to_open(&basename) && !confirm_risky_open(&app, &basename).await {
                return Ok(id);
            }
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
        .ready()?
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
    if basename == ".." || basename.contains('\\') || is_unsafe_windows_filename(basename) {
        return Err(format!("unsafe remote filename: {basename}"));
    }
    // `session_id` is backend-generated (`ssh-{n}`) in practice, but it
    // arrives here from the webview and lands in a filesystem path, so it
    // gets filtered rather than trusted. Anything outside `[A-Za-z0-9._-]`
    // is dropped instead of rejected: the prefix is cosmetic — it exists to
    // make a stray temp directory identifiable — and failing an edit over it
    // would be a worse trade than an odd-looking directory name.
    let id_slug: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(32)
        .collect();
    let temp_dir = tempfile::Builder::new()
        .prefix(&format!("wrustty-sftp-{id_slug}-"))
        .tempdir()
        .map_err(|e| e.to_string())?;
    let local_path = temp_dir.path().join(basename);
    std::fs::write(&local_path, &bytes).map_err(|e| e.to_string())?;

    // Downloaded and watched either way — declining only means the file
    // isn't handed to the OS opener. The user can still reach it from the
    // panel, and the watcher below is what makes an external edit round-trip.
    let open_it = is_inert_to_open(basename) || confirm_risky_open(&app, basename).await;
    if open_it {
        app.opener()
            .open_path(local_path.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string())?;
    }

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
                        .ready()?
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

/// Every edit currently being watched for a session.
///
/// Watches outlive the Files panel that started them — deliberately, since
/// there's no way to know when an external editor is done, and stopping early
/// would silently drop the user's next save. That makes the panel's own
/// memory of what it opened an unreliable indicator: reopen the panel and it
/// has forgotten watches that are still very much running and still uploading
/// on save. This is the authoritative list to render from instead.
#[tauri::command]
pub async fn sftp_list_edits(
    session_id: String,
    sftp_state: State<'_, SftpState>,
) -> Result<Vec<ActiveEdit>, String> {
    let edits = sftp_state.edits.lock().await;
    Ok(edits
        .iter()
        .filter(|(_, e)| e.session_id == session_id)
        .map(|(id, e)| ActiveEdit {
            edit_id: id.clone(),
            remote_path: e.remote_path.clone(),
        })
        .collect())
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
    // One lock, one pass. This used to collect the stale ids under a first
    // lock and then re-acquire it per id to remove them — but nothing in the
    // removal is async, so there was never a reason to let go of the lock in
    // between. The dropped `EditEntry`s stop their watcher threads and delete
    // their temp dirs from `Drop`, synchronously and while the lock is still
    // held; that was equally true of the per-id `remove` this replaces.
    sftp_state
        .edits
        .lock()
        .await
        .retain(|_, e| e.session_id != session_id);
}

#[cfg(test)]
mod tests {
    use super::{is_inert_to_open, is_unsafe_windows_filename};

    /// The device-name half is the one with teeth: without it a remote file
    /// called `NUL` is written to the null device, and every later edit is
    /// silently discarded while the user believes it is being uploaded.
    #[test]
    fn windows_hostile_filenames_are_rejected() {
        for name in [
            "NUL",
            "nul",
            "NUL.txt",
            "con.log",
            "COM1",
            "lpt9.conf",
            "AUX",
            // A reserved stem stays reserved however many extensions follow
            // it, which is why the comparison is against the first segment
            // rather than the last.
            "nul.d.ts",
            "notes.txt:payload",
            "report.txt ",
            "report.txt.",
            // Legal on the remote host, refused by Windows. Caught here only
            // so the message names the file instead of `std::fs::write`
            // returning a bare OS error about a path the user never typed.
            "what?",
            "a<b",
            "a>b",
            "quote\".txt",
            "pipe|dream",
            "star*.log",
        ] {
            assert!(
                is_unsafe_windows_filename(name),
                "{name} should be refused before it reaches the filesystem"
            );
        }
    }

    /// The guard has to stay narrow — it runs on every SFTP edit, and a false
    /// positive means a file the user simply cannot open.
    #[test]
    fn ordinary_filenames_are_left_alone() {
        for name in [
            "notes.txt",
            "console.log",
            "communication.md",
            "auxiliary.conf",
            "LPT.txt",
            "COM10.txt",
            ".bashrc",
            "my report.txt",
        ] {
            assert!(
                !is_unsafe_windows_filename(name),
                "{name} should be allowed"
            );
        }
    }

    #[test]
    fn text_and_source_files_open_directly() {
        for name in [
            "notes.txt",
            "nginx.conf",
            "Config.YAML",
            "main.rs",
            "deploy.sh",
            "README",
            ".bashrc",
            "app.tsx",
        ] {
            assert!(is_inert_to_open(name), "{name} should open without asking");
        }
    }

    /// The point of the list. `.js` and `.py` are here deliberately: both are
    /// editable text, and both execute on double-click on Windows.
    #[test]
    fn executable_handlers_are_confirmed_first() {
        for name in [
            "payload.hta",
            "shortcut.lnk",
            "setup.scr",
            "run.bat",
            "run.cmd",
            "task.ps1",
            "dropper.js",
            "script.py",
            "installer.msi",
            "tool.exe",
            // Plain text, but Edge is the default handler on Windows and SVG
            // carries <script>.
            "logo.svg",
        ] {
            assert!(
                !is_inert_to_open(name),
                "{name} should require confirmation"
            );
        }
    }

    /// The OS dispatches on the last extension, so a double extension must
    /// not be read as the harmless-looking first one.
    #[test]
    fn double_extension_is_judged_by_the_last_one() {
        assert!(!is_inert_to_open("invoice.txt.exe"));
        assert!(is_inert_to_open("archive.tar.md"));
    }
}
