//! Tauri command layer for SFTP: remote directory browsing, plus
//! download-watch-reupload file editing layered on an existing SSH
//! session's (lazily-opened, connection-lifetime) SFTP subsystem channel.

use std::collections::HashMap;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncRead, ReadBuf};
use tokio::sync::mpsc;
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
    /// The four `Transfer*` variants belong to an explicit upload (a dropped
    /// file); the three `Upload*` ones above belong to an edit being saved.
    /// Deliberately not merged: an edit's re-upload has no progress, nothing
    /// to cancel, and is keyed by the edit it belongs to rather than by a
    /// transfer. There is no `TransferStarted` — `sftp_upload_begin` returns
    /// the id, so it is in the caller's hands before the first chunk goes.
    TransferProgress {
        transfer_id: String,
        sent: u64,
    },
    TransferDone {
        transfer_id: String,
        remote_path: String,
    },
    TransferCancelled {
        transfer_id: String,
    },
    TransferFailed {
        transfer_id: String,
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
    /// Cancellation flags for uploads in flight, by transfer id. An entry
    /// exists only while its transfer does — the upload removes its own on
    /// every path out — so a cancel arriving late finds nothing and does
    /// nothing, which is the right outcome rather than a missing case.
    transfers: TokioMutex<HashMap<String, TransferEntry>>,
    next_id: AtomicU64,
}

impl SftpState {
    fn next_edit_id(&self) -> String {
        format!("edit-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    /// Shares the counter with `next_edit_id` on purpose: the two id spaces
    /// never have to be distinct, and one counter cannot hand out a duplicate.
    fn next_transfer_id(&self) -> String {
        format!("transfer-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
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

/// Whether a remote path is already taken, so the frontend can ask before an
/// upload replaces something.
///
/// Advisory only: the answer is stale the moment it is given, and the upload
/// below re-checks under the same `overwrite` flag. This exists so the
/// *question* can be asked before the transfer starts rather than after it has
/// spent a minute pushing bytes.
#[tauri::command]
pub async fn sftp_exists(
    session_id: String,
    path: String,
    ssh_state: State<'_, SshState>,
) -> Result<bool, String> {
    let session = crate::ssh::lookup(&ssh_state, &session_id).await?;
    let sftp = session
        .lock()
        .await
        .ready()?
        .get_or_open_sftp()
        .await
        .map_err(|e| e.to_string())?;
    sftp.try_exists(&path).await.map_err(|e| e.to_string())
}

/// The suffix an upload lands under before it is put in place.
const PART_SUFFIX: &str = ".wrustty-part";

/// A file arriving from the webview, chunk by chunk, as an `AsyncRead`.
///
/// **Why the bytes come through the webview at all.** Tauri's own drag-drop
/// handler would hand us a local path, and this would be a `File::open`. It is
/// off deliberately (`dragDropEnabled: false` in tauri.conf.json): on WebView2
/// it intercepts OS drag-and-drop and thereby breaks the page's own HTML5
/// events, which is what tab-to-pane dragging is built on. That was diagnosed
/// and fixed once already, so a file drop here is a DOM event, the webview
/// holds a `File` with no path anywhere on it, and the only route to the bytes
/// is IPC.
///
/// So they are streamed rather than handed over whole: the frontend slices the
/// file, each chunk goes straight into the SFTP write, and a file of any size
/// costs one chunk of memory on each side. The bounded channel is the
/// backpressure — without it a webview reading from a fast local disk would
/// queue the entire file in memory ahead of a slow network.
struct ChunkReader {
    rx: mpsc::Receiver<Vec<u8>>,
    current: Vec<u8>,
    pos: usize,
}

impl AsyncRead for ChunkReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        // Loops rather than taking one chunk per poll because an empty chunk
        // would otherwise read as end-of-file and silently truncate the
        // upload. The frontend does not send them; this is why it cannot.
        while self.pos >= self.current.len() {
            match self.rx.poll_recv(cx) {
                Poll::Ready(Some(chunk)) => {
                    self.current = chunk;
                    self.pos = 0;
                }
                // Every sender dropped: the transfer was finished or cancelled.
                Poll::Ready(None) => return Poll::Ready(Ok(())),
                Poll::Pending => return Poll::Pending,
            }
        }
        let n = std::cmp::min(buf.remaining(), self.current.len() - self.pos);
        buf.put_slice(&self.current[self.pos..self.pos + n]);
        self.pos += n;
        Poll::Ready(Ok(()))
    }
}

/// Whether a dropped file's name can be joined onto a remote directory.
///
/// The name comes from a `File` in the webview and is therefore already a bare
/// filename — this is the boundary saying so rather than assuming it. A name
/// carrying a separator or a `..` would write outside the directory the user
/// dropped on, which is the whole of what they chose by dropping there.
///
/// Deliberately narrower than the remote-name checks further up this file:
/// those guard a remote-chosen name being written to *local* disk, where
/// Windows device names and alternate data streams are the hazard. This guards
/// a local name being written to a *POSIX* host, where the hazard is the path
/// separator and nothing else.
fn is_usable_upload_name(name: &str) -> bool {
    !(name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0'))
}

/// One upload in flight.
struct TransferEntry {
    /// Dropping this is what tells the reader the file has ended — so
    /// finishing and cancelling are both "take the entry out of the map",
    /// and differ only in whether the flag was set on the way.
    tx: mpsc::Sender<Vec<u8>>,
    cancel: Arc<AtomicBool>,
}

/// How many chunks may be queued ahead of the network. Four is enough to keep
/// the writer fed across one round trip and small enough that a fast local
/// read cannot build a queue worth measuring.
const CHUNK_QUEUE: usize = 4;

/// Starts an upload and returns its transfer id.
///
/// **Nothing at the destination is touched until the whole file has arrived.**
/// The transfer goes to `<name>.wrustty-part` and is renamed into place only on
/// success, so a cancelled or failed upload — a dropped connection, a full
/// disk, a closed lid — leaves whatever was already there untouched rather
/// than truncated to however much got through. That is the promise `wr-fs`
/// makes for local stores, and it matters more here: the file being replaced
/// is on a machine the user may not be able to get back to easily.
///
/// The replace at the end is remove-then-rename because SFTP v3's rename will
/// not overwrite. The window between the two is real but small, and it opens
/// only once the new data is complete on the far side.
// A Tauri command's arguments are its wire format; grouping them into a struct
// to satisfy the lint would only move the same fields behind a name the
// frontend then has to construct.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sftp_upload_begin(
    app: AppHandle,
    session_id: String,
    remote_dir: String,
    name: String,
    overwrite: bool,
    channel: Channel<SftpEvent>,
    ssh_state: State<'_, SshState>,
    sftp_state: State<'_, SftpState>,
) -> Result<String, String> {
    if !is_usable_upload_name(&name) {
        return Err(format!("{name} is not a usable file name"));
    }
    // A remote directory is POSIX whatever the client is.
    let dir = remote_dir.trim_end_matches('/');
    let remote_path = format!("{dir}/{name}");
    let part_path = format!("{remote_path}{PART_SUFFIX}");

    let session = crate::ssh::lookup(&ssh_state, &session_id).await?;
    let sftp = session
        .lock()
        .await
        .ready()?
        .get_or_open_sftp()
        .await
        .map_err(|e| e.to_string())?;

    // Re-checked here rather than trusted from the frontend's own `exists`
    // call, which by then is several dialogs old.
    let exists = sftp
        .try_exists(&remote_path)
        .await
        .map_err(|e| e.to_string())?;
    if exists && !overwrite {
        return Err(format!("{remote_path} already exists"));
    }

    let transfer_id = sftp_state.next_transfer_id();
    let cancel = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<Vec<u8>>(CHUNK_QUEUE);
    sftp_state.transfers.lock().await.insert(
        transfer_id.clone(),
        TransferEntry {
            tx,
            cancel: cancel.clone(),
        },
    );

    let reader = ChunkReader {
        rx,
        current: Vec::new(),
        pos: 0,
    };
    let task_id = transfer_id.clone();
    tokio::spawn(async move {
        run_upload(
            app,
            sftp,
            reader,
            part_path,
            remote_path,
            exists,
            channel,
            task_id,
            cancel,
        )
        .await
    });

    Ok(transfer_id)
}

/// Drives one upload to its end and reports which end it was.
#[allow(clippy::too_many_arguments)]
async fn run_upload(
    app: AppHandle,
    sftp: std::sync::Arc<wr_sftp::SftpClient>,
    reader: ChunkReader,
    part_path: String,
    remote_path: String,
    replacing: bool,
    channel: Channel<SftpEvent>,
    transfer_id: String,
    cancel: Arc<AtomicBool>,
) {
    let progress_channel = channel.clone();
    let progress_id = transfer_id.clone();
    let progress_cancel = cancel.clone();
    let outcome = sftp
        .upload(&part_path, reader, move |sent| {
            let _ = progress_channel.send(SftpEvent::TransferProgress {
                transfer_id: progress_id.clone(),
                sent,
            });
            !progress_cancel.load(Ordering::Relaxed)
        })
        .await;

    // Cancelling drops the sender, which the reader sees as a clean
    // end-of-file — so a cancel that lands between the last chunk and the end
    // arrives as `Complete`. The flag is what tells the two apart, and it has
    // to be read after the transfer rather than only inside the callback.
    let cancelled = cancel.load(Ordering::Relaxed);

    let result: Result<bool, String> = match outcome {
        Err(e) => {
            let _ = sftp.remove_file(&part_path).await;
            Err(e.to_string())
        }
        Ok(_) if cancelled => {
            let _ = sftp.remove_file(&part_path).await;
            Ok(false)
        }
        Ok(wr_sftp::Transferred::Cancelled) => {
            let _ = sftp.remove_file(&part_path).await;
            Ok(false)
        }
        Ok(wr_sftp::Transferred::Complete) => {
            let placed = async {
                if replacing {
                    sftp.remove_file(&remote_path)
                        .await
                        .map_err(|e| format!("could not replace {remote_path}: {e}"))?;
                }
                sftp.rename(&part_path, &remote_path).await.map_err(|e| {
                    format!("uploaded, but could not move it into place as {remote_path}: {e}")
                })
            }
            .await;
            match placed {
                Ok(()) => Ok(true),
                Err(e) => {
                    // The bytes are all there under the part name; leaving it
                    // would be litter the user cannot see from the terminal.
                    let _ = sftp.remove_file(&part_path).await;
                    Err(e)
                }
            }
        }
    };

    let _ = match result {
        Ok(true) => channel.send(SftpEvent::TransferDone {
            transfer_id: transfer_id.clone(),
            remote_path,
        }),
        Ok(false) => channel.send(SftpEvent::TransferCancelled {
            transfer_id: transfer_id.clone(),
        }),
        Err(error) => channel.send(SftpEvent::TransferFailed {
            transfer_id: transfer_id.clone(),
            remote_path,
            error,
        }),
    };

    // The frontend removes the entry when it finishes or cancels; this covers
    // the transfer that ended on its own — a failure, or a webview that walked
    // away — so a dead transfer cannot hold its id forever.
    app.state::<SftpState>()
        .transfers
        .lock()
        .await
        .remove(&transfer_id);
}

/// One chunk of a file being uploaded.
///
/// Takes the bytes as the request's raw body rather than as a command
/// argument: an argument is serialized as a JSON array of numbers, which for a
/// quarter-megabyte chunk is roughly a megabyte of text to build, send and
/// parse. The transfer id rides in a header because the body is the file.
#[tauri::command]
pub async fn sftp_upload_chunk(
    request: tauri::ipc::Request<'_>,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    let transfer_id = request
        .headers()
        .get("transfer-id")
        .and_then(|v| v.to_str().ok())
        .ok_or("upload chunk arrived with no transfer id")?
        .to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("upload chunk arrived as something other than bytes".into());
    };

    // The sender is cloned out and the lock released before the send, which
    // may block on the queue being full — holding the map's lock for the
    // length of a network round trip would stall every other transfer.
    let tx = {
        let transfers = sftp_state.transfers.lock().await;
        transfers.get(&transfer_id).map(|e| e.tx.clone())
    }
    .ok_or("that upload is no longer running")?;

    tx.send(bytes.clone())
        .await
        .map_err(|_| "that upload is no longer running".to_string())
}

/// The file has no more chunks. Drops the sender, which the reader sees as
/// end-of-file; the transfer's own task reports how it went.
#[tauri::command]
pub async fn sftp_upload_finish(
    transfer_id: String,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    sftp_state.transfers.lock().await.remove(&transfer_id);
    Ok(())
}

/// Asks a running upload to stop. Sets the flag *before* dropping the sender,
/// so the task can tell a cancellation from a file that simply ended.
#[tauri::command]
pub async fn sftp_cancel_upload(
    transfer_id: String,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    if let Some(entry) = sftp_state.transfers.lock().await.remove(&transfer_id) {
        entry.cancel.store(true, Ordering::Relaxed);
    }
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
    use super::{is_inert_to_open, is_unsafe_windows_filename, is_usable_upload_name, ChunkReader};
    use tokio::sync::mpsc;

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

    /// A dropped name is joined onto the directory the user dropped on, so
    /// anything that could climb out of it has to be refused there.
    #[test]
    fn upload_names_that_would_escape_the_directory_are_refused() {
        for name in [
            "",
            ".",
            "..",
            "../etc/passwd",
            "a/b.txt",
            "a\\b.txt",
            "nul\0.txt",
        ] {
            assert!(!is_usable_upload_name(name), "{name:?} should be refused");
        }
        for name in [
            "notes.txt",
            "archive.tar.gz",
            ".bashrc",
            "a file with spaces.log",
        ] {
            assert!(is_usable_upload_name(name), "{name:?} should be accepted");
        }
    }

    /// The reader an upload streams from. The empty-chunk case is the one that
    /// matters: read as end-of-file it would truncate the upload silently, and
    /// the file would land looking complete.
    #[tokio::test]
    async fn chunk_reader_reassembles_the_stream() {
        use tokio::io::AsyncReadExt;

        let (tx, rx) = mpsc::channel::<Vec<u8>>(4);
        tokio::spawn(async move {
            tx.send(b"hello ".to_vec()).await.unwrap();
            tx.send(Vec::new()).await.unwrap();
            tx.send(b"world".to_vec()).await.unwrap();
            // Dropping the sender is what ends the file.
        });

        let mut reader = ChunkReader {
            rx,
            current: Vec::new(),
            pos: 0,
        };
        let mut out = Vec::new();
        reader.read_to_end(&mut out).await.unwrap();
        assert_eq!(out, b"hello world");
    }

    /// A file that was never written to is still a file: an upload of zero
    /// bytes has to end cleanly rather than hang waiting for a chunk.
    #[tokio::test]
    async fn chunk_reader_ends_on_an_empty_stream() {
        use tokio::io::AsyncReadExt;

        let (tx, rx) = mpsc::channel::<Vec<u8>>(1);
        drop(tx);
        let mut reader = ChunkReader {
            rx,
            current: Vec::new(),
            pos: 0,
        };
        let mut out = Vec::new();
        reader.read_to_end(&mut out).await.unwrap();
        assert!(out.is_empty());
    }
}
