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
use tokio::sync::Mutex as TokioMutex;
use tokio::sync::{mpsc, oneshot};
use wr_sftp::RemoteEntry;
use wr_ssh::{SudoError, SudoWriter};
use zeroize::Zeroizing;

use crate::session_registry::Slot;
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
    /// A configured editor that this app launched has exited.
    ///
    /// Only ever sent when the editor was started by `externalEditor` rather
    /// than handed to the OS: the default opener returns the instant it has
    /// dispatched the file, usually to an editor that was already running, so
    /// there is no process whose exit means anything. That is the whole reason
    /// the "watching" chip has to be dismissed by hand without this setting.
    ///
    /// `still_watching` is the misconfiguration case — see
    /// `MIN_EDITOR_LIFETIME`. The watch is intact and the user needs to know
    /// their command is missing its wait flag.
    EditorExited {
        edit_id: String,
        remote_path: String,
        still_watching: bool,
    },
    /// The remote file changed under an edit, and the save was **not** made.
    ///
    /// Nothing has been written when this arrives — the point is that the save
    /// stopped. The frontend asks; `sftp_save_edit` with `force` is how the
    /// user says to overwrite anyway.
    UploadConflict {
        edit_id: String,
        remote_path: String,
        /// Unix seconds, for a message that can say *when* rather than only
        /// that it happened. `None` if the server stopped reporting one.
        remote_modified: Option<i64>,
    },
    /// The `Transfer*` variants belong to an explicit transfer in either
    /// direction — a dropped file, a picked file, a download; the three
    /// `Upload*` ones above belong to an edit being saved. Deliberately not
    /// merged: an edit's re-upload has no progress, nothing to cancel, and is
    /// keyed by the edit it belongs to rather than by a transfer.
    ///
    /// Direction is not on the wire. Every transfer is started by a frontend
    /// call that already knows which way it goes, and the id comes back from
    /// that call — so a field saying so would only be something to keep in
    /// sync.
    ///
    /// Sent only when the *backend* is the one that learned the total: a
    /// download (from `stat`) and an upload from a local path (from the file's
    /// own metadata). A dropped file is sized by the webview before the
    /// transfer exists, so there is nothing to report.
    TransferStarted {
        transfer_id: String,
        remote_path: String,
        total: u64,
    },
    TransferProgress {
        transfer_id: String,
        /// Bytes moved so far, whichever way they were going. For a folder this
        /// is the running total across every file in it, so one progress bar
        /// still means one thing.
        transferred: u64,
    },
    /// Which file a folder transfer is on now. Never sent for a single file —
    /// the transfer is already named by `TransferStarted`.
    ///
    /// `index` is 1-based, because it is shown to a human as "3 of 57".
    TransferFile {
        transfer_id: String,
        name: String,
        index: u64,
        count: u64,
    },
    /// Something the user should know about a transfer that still succeeded —
    /// so far, only the symlinks a recursive copy passed over. A copy quietly
    /// missing entries is the kind of thing found out much later, by something
    /// that needed one.
    TransferNote {
        transfer_id: String,
        note: String,
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
    /// The connection went away under this transfer, and it is waiting for the
    /// session to come back rather than needing anything from the user.
    ///
    /// Distinct from `TransferFailed` because the two ask for opposite things.
    /// A failure wants attention — a full disk, a permission, a name that will
    /// not do — and its row offers Retry. This wants none: the reconnect is
    /// already running, and the transfer picks up by itself when it lands. A
    /// row that says "failed" here would send the user to fix something that is
    /// about to fix itself, and a Retry pressed mid-outage only fails again.
    TransferInterrupted {
        transfer_id: String,
    },
    /// The session came back and this transfer is running again, from where it
    /// got to. Sent under the *same* transfer id, so the row continues.
    TransferResumed {
        transfer_id: String,
    },
    /// A file the connected user cannot write is being opened as root, and sudo
    /// on the far end wants a password. Answered by `sftp_respond_sudo_prompt`.
    ///
    /// Sent on the panel's own channel rather than the connection's, because
    /// this is not authentication to the *host* — the session is already up and
    /// authenticated. It is a second, unrelated credential, and the dialog has
    /// to be told apart from the SSH one at a glance or the user types the
    /// wrong secret into it.
    SudoPrompt {
        request_id: String,
        remote_path: String,
        /// A password was already tried and rejected. The dialog says so rather
        /// than reappearing blank, which reads as a dropped keystroke.
        retry: bool,
    },
}

/// One live edit watch, as reported to the frontend by `sftp_list_edits`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveEdit {
    pub edit_id: String,
    pub remote_path: String,
    /// Whether a root helper is running for this edit. Rendered, because a
    /// standing privilege the user cannot see is one they cannot decide to end
    /// — and stopping the watch is how they end it.
    pub elevated: bool,
}

struct EditEntry {
    session_id: String,
    remote_path: String,
    local_path: PathBuf,
    /// The remote mtime this edit's local copy was taken from, and what a save
    /// checks against before it writes.
    ///
    /// Shared with the watcher rather than read out of the map, because the
    /// watcher's callback has no handle on `SftpState` — and updated after every
    /// successful save, so the *next* save compares against what this edit just
    /// wrote rather than against a value that is now two saves old and conflicts
    /// with itself.
    expected_mtime: Arc<TokioMutex<Option<i64>>>,
    /// The privileged half of this edit — empty until, and unless, it is
    /// opened or saved as root.
    ///
    /// Always present as a cell even when the edit is not elevated, and that is
    /// the whole point of its shape. The file watcher captures this once, when
    /// the watch is created, and goes on using that capture for every save
    /// afterwards. If elevation were a plain `Option` swapped into the map
    /// later, `sftp_elevate_edit` would elevate an entry the watcher can no
    /// longer see — and the next Ctrl-S would fail exactly the way the
    /// elevation was meant to fix, having reported success.
    ///
    /// Behind a mutex because the helper is one stream carrying a request and
    /// its reply, and two saves interleaved on it would read each other's
    /// answers.
    elevated: SharedElevation,
    // Held only for their Drop impls: dropping the debouncer stops the
    // watcher thread, and dropping the TempDir deletes the directory (and
    // the file inside it) from disk.
    _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
    _temp_dir: tempfile::TempDir,
}

/// Everything that makes one edit privileged: the root helper, and the
/// unprivileged scratch file on the host that saves are staged through.
///
/// Dropping this is the teardown. The helper is holding a channel, so dropping
/// closes it, the root `sh` on the far end reads EOF and exits, and the
/// privilege is gone — for every route that ends an edit, including the ones
/// nobody wrote code for here (the pane closing, the session dropping, the app
/// quitting). See `wr_ssh::sudo` for why privilege is held as a process rather
/// than as a remembered password.
/// The elevated state of one edit, shared between the watcher, the panel and
/// whatever elevates it.
type SharedElevation = Arc<Elevation>;

/// Whether an edit is elevated, and the helper that makes it so.
///
/// Two representations of one fact, which is a thing to justify. The helper has
/// to sit behind an async mutex: it is a single stream carrying a request and
/// its reply, and a save holds it for a full round trip to the host. The flag
/// exists so that *asking* whether an edit is elevated never has to wait for
/// that round trip — `sftp_list_edits` reads it for every watch on a session
/// while holding the edits map, and blocking there on someone else's save would
/// freeze the whole Files panel behind one slow write.
///
/// They cannot drift because `install` is the only thing that sets either, and
/// it sets both.
#[derive(Default)]
struct Elevation {
    state: TokioMutex<Option<ElevatedEdit>>,
    installed: AtomicBool,
}

impl Elevation {
    /// Lock-free, and deliberately so — see the type's own note.
    fn is_installed(&self) -> bool {
        self.installed.load(Ordering::Relaxed)
    }

    /// Takes the helper, unless one is already here.
    ///
    /// Returning the loser's helper rather than dropping it inside the lock is
    /// not fussiness: dropping an `ElevatedEdit` spawns a cleanup task, and
    /// doing that while holding this mutex would have a save waiting on it.
    async fn install(&self, elevated: ElevatedEdit) -> Option<ElevatedEdit> {
        let mut slot = self.state.lock().await;
        if slot.is_some() {
            return Some(elevated);
        }
        *slot = Some(elevated);
        self.installed.store(true, Ordering::Relaxed);
        None
    }
}

struct ElevatedEdit {
    writer: SudoWriter,
    /// A `0600` file in the host's `/tmp`, owned by the connected user, made
    /// once and rewritten by every save. Reused rather than remade because a
    /// name that never changes is one the helper's destination check and this
    /// module's cleanup can both be sure of.
    staged_path: String,
    /// Kept only so the staged file can be unlinked when this drops — the last
    /// moment anything knows both that the file exists and that nothing needs
    /// it any more.
    session: Arc<TokioMutex<Slot<wr_ssh::SshSession>>>,
}

impl Drop for ElevatedEdit {
    fn drop(&mut self) {
        // Best-effort, and deliberately not waited on: this runs from whichever
        // path removed the edit, and none of them should block on a round trip
        // to tidy up a temporary file. A host that never hears this is left
        // with an empty `0600` file in `/tmp`, which is what any interrupted
        // `mktemp` leaves and what `/tmp` exists to absorb.
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let session = self.session.clone();
        let staged = self.staged_path.clone();
        handle.spawn(async move {
            let sftp = {
                let guard = session.lock().await;
                match guard.ready() {
                    Ok(session) => session.get_or_open_sftp().await.ok(),
                    Err(_) => None,
                }
            };
            if let Some(sftp) = sftp {
                let _ = sftp.remove_file(&staged).await;
            }
        });
    }
}

#[derive(Default)]
pub struct SftpState {
    edits: TokioMutex<HashMap<String, EditEntry>>,
    /// Transfers in flight, either direction, by transfer id. An entry exists
    /// only while its transfer does — every path out removes its own — so a
    /// cancel arriving late finds nothing and does nothing, which is the right
    /// outcome rather than a missing case.
    transfers: TokioMutex<HashMap<String, TransferEntry>>,
    /// Transfers whose connection went away under them, waiting for it to come
    /// back. Keyed by the same transfer id, which is what lets the restart
    /// continue the row the user is already watching.
    ///
    /// A separate map rather than a flag on the entry above, because the two
    /// have opposite lifetimes: a live entry is removed by whichever path ends
    /// the transfer, and the whole point here is to hold on to something *after*
    /// that has happened. The running task still tears itself down normally; it
    /// simply does so having already been copied here.
    interrupted: TokioMutex<HashMap<String, InterruptedTransfer>>,
    /// Sudo password prompts waiting on an answer, by request id.
    ///
    /// No owning session id beside the sender, unlike SSH's equivalent maps:
    /// every waiter here gives up on its own after `SUDO_PROMPT_TIMEOUT`, so an
    /// entry cannot outlive the thing that made it and there is nothing for a
    /// disconnect to go and clean up.
    pending_sudo: TokioMutex<HashMap<String, oneshot::Sender<Option<Zeroizing<String>>>>>,
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

    fn next_sudo_request_id(&self) -> String {
        format!("sudo-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }
}

/// The SFTP client for browsing and editing — small, frequent operations that
/// have to stay responsive.
async fn browse_client(
    ssh_state: &State<'_, SshState>,
    session_id: &str,
) -> Result<Arc<wr_sftp::SftpClient>, String> {
    let session = crate::ssh::lookup(ssh_state, session_id).await?;
    let sftp = session
        .lock()
        .await
        .ready()?
        .get_or_open_sftp()
        .await
        .map_err(|e| e.to_string())?;
    Ok(sftp)
}

/// The SFTP client for bulk transfers, on a channel of its own.
///
/// One client serialises everything asked of it, so a download running for a
/// minute would otherwise hold up every directory listing behind it — the
/// panel would freeze for the length of the transfer it is showing progress
/// for. Anything with a progress bar comes here; everything else uses
/// `browse_client`.
async fn transfer_client(
    ssh_state: &State<'_, SshState>,
    session_id: &str,
) -> Result<Arc<wr_sftp::SftpClient>, String> {
    let session = crate::ssh::lookup(ssh_state, session_id).await?;
    let sftp = session
        .lock()
        .await
        .ready()?
        .get_or_open_transfer_sftp()
        .await
        .map_err(|e| e.to_string())?;
    Ok(sftp)
}

#[tauri::command]
pub async fn sftp_list_dir(
    session_id: String,
    path: String,
    ssh_state: State<'_, SshState>,
) -> Result<Vec<RemoteEntry>, String> {
    browse_client(&ssh_state, &session_id)
        .await?
        .list_dir(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Resolves `.`/`""` to the real remote home directory, so the file browser
/// has a sensible starting point instead of guessing `/home/<user>`.
#[tauri::command]
pub async fn sftp_canonicalize(
    session_id: String,
    path: String,
    ssh_state: State<'_, SshState>,
) -> Result<String, String> {
    browse_client(&ssh_state, &session_id)
        .await?
        .canonicalize(&path)
        .await
        .map_err(|e| e.to_string())
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

/// The placeholder a configured editor command may put the file path in.
const EDITOR_FILE_PLACEHOLDER: &str = "{file}";

/// How long after the editor exits before the watch is torn down.
///
/// An editor writes the file and then exits, and the two are close enough
/// together that the write's debounce (300 ms) is usually still pending when
/// the process is already gone. Tearing down immediately deletes the temp
/// directory out from under a save that was about to happen — the user's last
/// edit, lost, at the exact moment they believe they are done. A second and a
/// half is far longer than the debounce plus a local read, and it is time
/// nobody is waiting on: the editor window has already closed.
const EDITOR_EXIT_GRACE: Duration = Duration::from_millis(1500);

/// Below this, the editor is assumed not to have waited.
///
/// The whole mechanism rests on the configured command *blocking* until the
/// user is finished — `code --wait`, `subl --wait`, `gvim -f`. Without the
/// flag, the launcher hands the file to a running instance and returns at once,
/// which would look exactly like "the user closed the editor instantly" and
/// tear down a watch they are still typing into. So a suspiciously fast exit is
/// treated as a misconfiguration rather than an answer: the watch stays, and
/// the frontend is told why.
const MIN_EDITOR_LIFETIME: Duration = Duration::from_secs(3);

/// Splits a configured editor command into a program and its arguments, with
/// the file path substituted in.
///
/// **Backslash is not an escape character here.** It is the path separator on
/// the platform this app targets, and treating `C:\Program Files\Foo\foo.exe`
/// as a string of escapes is how a setting that looks obviously correct fails
/// mysteriously. Only the double quote groups, which is enough for the one hard
/// case — a program path with spaces in it.
///
/// `{file}` marks where the path goes, anywhere in any argument
/// (`--file={file}` works). A command with no placeholder gets the path
/// appended, since that is what every editor's own command line looks like.
fn parse_editor_command(
    command: &str,
    file: &std::path::Path,
) -> Result<(String, Vec<String>), String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut has_token = false;
    for c in command.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                // An empty pair of quotes is still an argument — `foo "" bar`
                // has three — so the token is marked as started here rather
                // than only by a character landing in it.
                has_token = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has_token {
                    tokens.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        tokens.push(current);
    }
    if quoted {
        return Err("editor command has an unclosed quote".into());
    }

    let mut tokens = tokens.into_iter();
    let program = tokens
        .next()
        .filter(|p| !p.is_empty())
        .ok_or("editor command is empty")?;
    let path = file.to_string_lossy().into_owned();
    let mut args: Vec<String> = tokens
        .map(|arg| arg.replace(EDITOR_FILE_PLACEHOLDER, &path))
        .collect();
    if !command.contains(EDITOR_FILE_PLACEHOLDER) {
        args.push(path);
    }
    Ok((program, args))
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

/// Who the session is connected as, on the host's own terms.
///
/// Exists so the panel can tell, *before* trying, whether a write would be
/// refused — and route straight to sudo rather than making the user watch an
/// attempt fail first.
///
/// Numeric, because that is what a directory listing actually carries. SFTP v3
/// — what OpenSSH speaks — has no owner *names* in its attributes at all, and
/// `russh_sftp` decodes those fields as `None` unconditionally. A predicate
/// written against names could never fire on any host, which is exactly what
/// happened the first time this was built.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteIdentity {
    /// The numeric uid, which is what a decision is actually made from.
    ///
    /// `None` when `id` could not be read at all, which the frontend treats as
    /// "predict nothing" rather than as "denied".
    pub uid: Option<u32>,
    /// Every group the user is in, numerically — the primary group included.
    pub gids: Vec<u32>,
    /// `None` when the host reported no name for the uid — an account with no
    /// passwd entry, which happens on appliances and in some container images.
    /// Display only; nothing decides anything from it.
    pub user: Option<String>,
}

/// Reads `id`'s one line of output.
///
/// `uid=1000(tim) gid=1000(tim) groups=1000(tim),27(sudo)` is the shape on
/// every Unix worth naming, and `LC_ALL=C` keeps it that shape. Anything that
/// does not parse yields an empty identity, which the frontend reads as "do not
/// guess" rather than as "denied" — a wrong guess in that direction would put a
/// sudo prompt in front of a file the user could have written all along.
fn parse_id_output(out: &str) -> RemoteIdentity {
    let line = out.lines().find(|l| l.contains("uid=")).unwrap_or("");

    // The value between `key=` and the next space: `1000(tim)` for `uid`, or
    // the whole comma-separated list for `groups`.
    let field = |key: &str| -> Option<&str> {
        let rest = line.split(&format!("{key}=")).nth(1)?;
        let end = rest.find(' ').unwrap_or(rest.len());
        Some(&rest[..end])
    };
    // `1000(tim)` -> 1000. The number is the part before any parenthesis, and
    // it is the only part that has to be there.
    let id_of = |spec: &str| -> Option<u32> { spec.split('(').next()?.trim().parse::<u32>().ok() };
    let name_of = |spec: &str| -> Option<String> {
        let open = spec.find('(')?;
        let close = spec.rfind(')')?;
        (close > open + 1).then(|| spec[open + 1..close].to_string())
    };

    let uid_spec = field("uid").unwrap_or("");
    // The primary gid is in `groups=` on every implementation worth naming, but
    // it is only *guaranteed* to be in `gid=` — so take both and let the set
    // sort out the duplicate.
    let mut gids: Vec<u32> = field("gid").and_then(id_of).into_iter().collect();
    if let Some(list) = field("groups") {
        for spec in list.split(',') {
            if let Some(gid) = id_of(spec) {
                if !gids.contains(&gid) {
                    gids.push(gid);
                }
            }
        }
    }

    RemoteIdentity {
        uid: id_of(uid_spec),
        gids,
        user: name_of(uid_spec),
    }
}

/// Asks the host who this session is.
///
/// One `exec` channel, once, and the panel caches it for the session — the
/// answer cannot change under a connection that stays authenticated as the same
/// user. Failure is not an error worth surfacing: a host that will not run `id`
/// (a restricted shell, an appliance CLI, `ForceCommand`) simply leaves the
/// panel unable to predict, which is the state it was in before this existed.
#[tauri::command]
pub async fn sftp_remote_identity(
    session_id: String,
    ssh_state: State<'_, SshState>,
) -> Result<RemoteIdentity, String> {
    let session = crate::ssh::lookup(&ssh_state, &session_id).await?;
    let out = {
        let guard = session.lock().await;
        guard
            .ready()?
            .exec_capture("env LC_ALL=C id", 4096, Duration::from_secs(10))
            .await
            .map_err(|e| e.to_string())?
    };
    Ok(parse_id_output(&String::from_utf8_lossy(&out)))
}

/// How long a sudo password prompt waits before it counts as cancelled.
///
/// A bound rather than an ownership map is what keeps this from leaking: the
/// panel that raised the prompt can be closed, the pane can go away, the
/// webview can stop listening, and the task parked on the answer still ends.
/// Two minutes is long enough to go and look a password up and short enough
/// that a forgotten dialog does not pin a task for the life of the process.
const SUDO_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// How many times a rejected password may be retyped before the open is
/// abandoned. Three is the shape of every login prompt; more would be this app
/// deciding on its own to keep guessing at someone's credential.
const SUDO_PASSWORD_ATTEMPTS: usize = 3;

/// What came back from a sudo password prompt.
enum SudoAnswer {
    Given(Zeroizing<String>),
    /// The user said no, or nothing was listening to ask in the first place.
    Cancelled,
    /// The prompt went out and no answer ever came.
    ///
    /// Worth telling apart from a cancel even though both abandon the open: a
    /// cancel is the user deciding, and this is the dialog never having reached
    /// them. Reported in those words, because "cancelled" for a prompt nobody
    /// saw sends the reader looking for a click that never happened.
    Unanswered,
}

/// Puts a sudo password prompt in front of the user and waits for the answer.
///
/// The answer arrives in `Zeroizing` and stays that way through to the one
/// `sudo` invocation it authenticates. Nothing here writes it anywhere, logs
/// it, or hands it back to the webview.
async fn ask_sudo_password(
    sftp_state: &SftpState,
    channel: &Channel<SftpEvent>,
    remote_path: &str,
    retry: bool,
) -> SudoAnswer {
    let request_id = sftp_state.next_sudo_request_id();
    let (tx, rx) = oneshot::channel();
    sftp_state
        .pending_sudo
        .lock()
        .await
        .insert(request_id.clone(), tx);

    log::info!("sudo: asking for a password for {remote_path} (retry: {retry})");
    if channel
        .send(SftpEvent::SudoPrompt {
            request_id: request_id.clone(),
            remote_path: remote_path.to_string(),
            retry,
        })
        .is_err()
    {
        // Nothing is listening on the panel's channel, which means the panel
        // that asked for this is gone. Logged rather than silent: from the
        // user's side it is indistinguishable from a dialog that never
        // rendered, and those have very different causes.
        log::warn!("sudo: nothing was listening for the password prompt");
        sftp_state.pending_sudo.lock().await.remove(&request_id);
        return SudoAnswer::Cancelled;
    }

    let answered = tokio::time::timeout(SUDO_PROMPT_TIMEOUT, rx).await;
    // Unconditionally, including on the timeout path — the entry holds a
    // sender nobody will ever use again either way.
    sftp_state.pending_sudo.lock().await.remove(&request_id);
    match answered {
        Ok(Ok(Some(password))) => SudoAnswer::Given(password),
        // An explicit "no" from the dialog, or the panel answering on its way
        // out.
        Ok(Ok(None)) | Ok(Err(_)) => SudoAnswer::Cancelled,
        Err(_) => SudoAnswer::Unanswered,
    }
}

/// The user's answer to a sudo prompt, or `None` for "cancel".
///
/// Wrapped for zeroizing the moment it arrives, and never persisted: a sudo
/// password is not the session's credential and has no business in the vault,
/// in a profile, or in a log line.
#[tauri::command]
pub async fn sftp_respond_sudo_prompt(
    request_id: String,
    password: Option<String>,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    let password = password.map(Zeroizing::new);
    if let Some(tx) = sftp_state.pending_sudo.lock().await.remove(&request_id) {
        let _ = tx.send(password);
    }
    Ok(())
}

/// Authenticates a privileged helper for one file, and optionally reads the
/// file down through it.
///
/// `sink` separates the two callers. Opening a file the user cannot *read*
/// needs the download to come through sudo, so it passes one. Elevating an edit
/// that is already open — the far commoner case, a world-readable file that
/// only root may write — passes `None`, because the local copy is the user's
/// work in progress and re-reading the host's version over it would throw away
/// everything they had typed.
///
/// The password's whole life is this function. It authenticates the helper, is
/// used again for the read on its own channel — sudo's timestamp does not carry
/// between `exec` channels, so the second call has to pay for itself — and is
/// dropped on the way out. What the edit keeps is the running helper.
///
/// The first attempt deliberately carries no password at all. A host with a
/// `NOPASSWD` sudoers entry never has to be asked, and one wasted round trip is
/// a much better trade than a dialog the user did not need to see.
async fn open_elevated(
    session: Arc<TokioMutex<Slot<wr_ssh::SshSession>>>,
    sftp_state: &SftpState,
    channel: &Channel<SftpEvent>,
    remote_path: &str,
    sink: Option<&mut tokio::fs::File>,
) -> Result<ElevatedEdit, String> {
    let runner = {
        let guard = session.lock().await;
        guard.ready()?.sudo().map_err(|e| e.to_string())?
    };

    // Authentication first, before anything is created on the host or written
    // locally: a host that will not give this user root should cost nothing to
    // find out about.
    let mut password: Option<Zeroizing<String>> = None;
    let writer = match runner.start_writer(None).await {
        Ok(writer) => writer,
        Err(e) if e.needs_password() => {
            let mut attempt = 0;
            loop {
                let candidate =
                    match ask_sudo_password(sftp_state, channel, remote_path, attempt > 0).await {
                        SudoAnswer::Given(candidate) => candidate,
                        SudoAnswer::Cancelled => {
                            return Err("opening this file as root was cancelled".to_string())
                        }
                        SudoAnswer::Unanswered => {
                            return Err(format!(
                                "no answer to the sudo password prompt after {}s — if no dialog                                  appeared, this is a bug rather than a timeout",
                                SUDO_PROMPT_TIMEOUT.as_secs()
                            ))
                        }
                    };
                match runner.start_writer(Some(&candidate)).await {
                    Ok(writer) => {
                        password = Some(candidate);
                        break writer;
                    }
                    Err(e) if e.is_retryable_password() => {
                        attempt += 1;
                        if attempt >= SUDO_PASSWORD_ATTEMPTS {
                            return Err(SudoError::WrongPassword.to_string());
                        }
                    }
                    Err(e) => return Err(e.to_string()),
                }
            }
        }
        Err(e) => return Err(e.to_string()),
    };

    if let Some(sink) = sink {
        runner
            .read_file(remote_path, password.as_ref(), sink)
            .await
            .map_err(|e| format!("could not read {remote_path} as root: {e}"))?;
    }

    let staged_path = runner
        .make_staging_file()
        .await
        .map_err(|e| format!("could not prepare a staging file on the host: {e}"))?;

    // No probe copy here, deliberately. The helper has already said READY,
    // which is what proves it is running as root; the only thing a trial copy
    // could add is a trial destination, and there is no harmless one — copying
    // the staging file onto itself is an error in every `cp` there is.
    Ok(ElevatedEdit {
        writer,
        staged_path,
        session,
    })
}

/// Downloads a remote file to a local temp copy, opens it in the OS's
/// default application for that file type, and watches it for changes —
/// re-uploading over SFTP on every save. Returns an edit id that identifies
/// this watch (for `sftp_stop_watching`).
///
/// If the same remote file is already being watched, reuses the existing
/// temp file/watcher instead of starting a second, competing one.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_edit_file(
    app: AppHandle,
    session_id: String,
    remote_path: String,
    // `editor_command` is the `externalEditor` setting: a command that must
    // *block* until the user is done with the file. Empty hands the file to the
    // OS instead, which is the default and cannot report anything back.
    editor_command: String,
    // Open this one as root. Never the panel's first move: it asks only after
    // an ordinary open has actually been refused, so a user who can already
    // write the file is never offered privilege they do not need, and one who
    // cannot has said out loud that they want it.
    elevate: bool,
    channel: Channel<SftpEvent>,
    ssh_state: State<'_, SshState>,
    sftp_state: State<'_, SftpState>,
) -> Result<String, String> {
    let editor = Some(editor_command.trim())
        .filter(|c| !c.is_empty())
        .map(str::to_owned);

    {
        let edits = sftp_state.edits.lock().await;
        if let Some((id, entry)) = edits
            .iter()
            .find(|(_, e)| e.session_id == session_id && e.remote_path == remote_path)
        {
            let local_path = entry.local_path.clone();
            let id = id.clone();
            drop(edits);
            open_in_editor(
                &app,
                editor.as_deref(),
                &local_path,
                &id,
                &remote_path,
                &channel,
            )
            .await?;
            return Ok(id);
        }
    }

    let session = crate::ssh::lookup(&ssh_state, &session_id).await?;
    // On the browsing channel rather than the transfer one, deliberately.
    // Editing is a round trip — this download and the re-upload on every save —
    // and putting the two halves on different channels would let a save queue
    // behind an unrelated download while the user waits, having pressed Ctrl-S
    // and been told nothing. A large file opened for editing does hold up
    // browsing for its duration, which is the cost of that choice; the panel
    // says "Opening" while it happens.
    let sftp = browse_client(&ssh_state, &session_id).await?;

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
    // Streamed into the temp file rather than read whole and written whole.
    // Nothing here needs the bytes in memory, and `read` would hold the file
    // twice over — once returned, once written — for a file whose size is
    // whatever the remote host says it is. No progress and no cancellation:
    // an edit has no UI for either, and the callback exists only because
    // `download` reports through it.
    //
    // Ordered after the filename checks on purpose. It used to run before
    // them, which meant a file the panel was never going to be able to open
    // was downloaded in full first.
    let mut file = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| e.to_string())?;
    // Made whether or not this edit is elevated: the file watcher captures it
    // once, and a later `sftp_elevate_edit` fills in this same cell rather than
    // leaving the watcher looking at a stale one. See `EditEntry::elevated`.
    let elevated: SharedElevation = Arc::new(Elevation::default());
    if elevate {
        // Read through sudo rather than SFTP. Note what this does *not* do:
        // stage a root-owned copy anywhere on the host. The bytes come straight
        // down the channel into the local temp file, so a file the user needed
        // root to read is never left readable by anyone else on the far end.
        let opened = open_elevated(
            session.clone(),
            &sftp_state,
            &channel,
            &remote_path,
            Some(&mut file),
        )
        .await?;
        // Cannot come back: this cell was made a moment ago and the edit it
        // belongs to is not in the map yet, so nothing else can have raced it.
        elevated.install(opened).await;
    } else {
        sftp.download(&remote_path, file, |_| true)
            .await
            .map_err(|e| e.to_string())?;
    }
    // Taken *after* the download, not before: the window that matters runs from
    // the moment this copy stopped reading to the moment it is written back, so
    // anchoring at the end of the read is what makes "changed since" mean
    // "changed since I looked". A stat that fails leaves `None`, which disables
    // the check rather than blocking every save — see `save_edit`.
    let expected_mtime = Arc::new(TokioMutex::new(
        sftp.stat(&remote_path).await.ok().and_then(|s| s.modified),
    ));

    let edit_id = sftp_state.next_edit_id();
    let watch_expected = expected_mtime.clone();
    let watch_elevated = elevated.clone();
    let watch_path = local_path.clone();
    let watch_remote_path = remote_path.clone();
    let watch_edit_id = edit_id.clone();
    let watch_session = session.clone();
    // The debouncer's callback runs on its own plain OS thread, not on the
    // tokio runtime — spawn back onto the runtime to do the actual
    // (async) re-read + re-upload + event push.
    let rt_handle = tokio::runtime::Handle::current();

    // Cloned for the watcher; the original stays here to launch the editor with
    // once the watch is registered.
    let watch_channel = channel.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        None,
        move |result: DebounceEventResult| {
            let channel = &watch_channel;
            let Ok(events) = result else { return };
            if !events.iter().any(|e| e.paths.contains(&watch_path)) {
                return;
            }
            let local_path = watch_path.clone();
            let remote_path = watch_remote_path.clone();
            let edit_id = watch_edit_id.clone();
            let session = watch_session.clone();
            let channel = channel.clone();
            let expected = watch_expected.clone();
            let elevated = watch_elevated.clone();
            rt_handle.spawn(async move {
                // Never forced. A save the *watcher* noticed is the one that
                // has to ask — the user pressed Ctrl-S in an editor and has no
                // idea anything else touched the file. Forcing is a separate,
                // deliberate answer to the question this may raise.
                save_edit(
                    session,
                    edit_id,
                    remote_path,
                    local_path,
                    expected,
                    elevated,
                    false,
                    channel,
                )
                .await;
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
            remote_path: remote_path.clone(),
            local_path: local_path.clone(),
            expected_mtime,
            elevated,
            _debouncer: debouncer,
            _temp_dir: temp_dir,
        },
    );

    // After the watch is registered, not before. Launching first would open a
    // window on a file nothing is yet watching, and a fast typist's first save
    // would go nowhere.
    open_in_editor(
        &app,
        editor.as_deref(),
        &local_path,
        &edit_id,
        &remote_path,
        &channel,
    )
    .await?;

    Ok(edit_id)
}

/// Puts the local copy in front of the user, by whichever of the two routes is
/// configured.
///
/// The difference between them is not just which program opens: it is whether
/// this app ever finds out the user is finished. The OS opener returns as soon
/// as it has dispatched the file — usually to an editor that was already
/// running — so there is no process to wait on and the watch has to be
/// dismissed by hand. A configured command that blocks gives a real signal, and
/// the watch can end itself.
async fn open_in_editor(
    app: &AppHandle,
    editor: Option<&str>,
    local_path: &std::path::Path,
    edit_id: &str,
    remote_path: &str,
    channel: &Channel<SftpEvent>,
) -> Result<(), String> {
    let basename = local_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    let Some(command) = editor else {
        // The OS-handler route, and the reason `INERT_EXTENSIONS` exists:
        // opening dispatches by extension, and on Windows a remote `.hta`,
        // `.js` or `.ps1` *runs*. Re-asked on every open, not just the first —
        // the warning is about the act of opening, and a watch that is already
        // running is not evidence the user meant to open it again.
        if !is_inert_to_open(&basename) && !confirm_risky_open(app, &basename).await {
            return Ok(());
        }
        return app
            .opener()
            .open_path(local_path.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string());
    };

    // No extension confirmation on this path, and that is not an oversight.
    // The prompt guards against the *OS handler* for a type being something
    // that executes it; a named text editor is not that handler, and
    // `code --wait payload.hta` opens a file rather than running one. Asking
    // anyway would train the user to dismiss a warning that no longer means
    // anything, which is how the warning stops working where it does matter.
    let (program, args) = parse_editor_command(command, local_path)?;
    let mut child = tokio::process::Command::new(&program)
        .args(&args)
        .spawn()
        .map_err(|e| format!("could not start the editor ({program}): {e}"))?;

    let app = app.clone();
    let channel = channel.clone();
    let edit_id = edit_id.to_owned();
    let remote_path = remote_path.to_owned();
    tokio::spawn(async move {
        let started = tokio::time::Instant::now();
        let _ = child.wait().await;
        let waited = started.elapsed();

        // A launcher that handed the file to a running instance and returned —
        // the missing-wait-flag case. Tearing the watch down here would delete
        // the temp file out from under an editor the user is still typing in.
        if waited < MIN_EDITOR_LIFETIME {
            let _ = channel.send(SftpEvent::EditorExited {
                edit_id,
                remote_path,
                still_watching: true,
            });
            return;
        }

        // Long enough for the debounced save of whatever the editor wrote on
        // its way out to have fired and finished.
        tokio::time::sleep(EDITOR_EXIT_GRACE).await;
        let existed = app
            .state::<SftpState>()
            .edits
            .lock()
            .await
            .remove(&edit_id)
            .is_some();
        if existed {
            let _ = channel.send(SftpEvent::EditorExited {
                edit_id,
                remote_path,
                still_watching: false,
            });
        }
    });
    Ok(())
}

/// Writes an edit's local copy back to the host, unless the host's copy moved
/// underneath it.
///
/// **The check is the point.** `write` is `CREATE | TRUNCATE`, so without it a
/// remote file that changed between download and save is replaced with no
/// warning and no trace — a colleague's edit, a config-management run, or the
/// user's own other session, gone, while the panel says "Saved". Comparing the
/// mtime is cheap and catches all three.
///
/// It is deliberately advisory, not a lock:
///
/// - **A one-second mtime is all SFTP v3 offers**, so two writes inside the same
///   second are indistinguishable. That is a narrow window and it is the one
///   this cannot close; a real answer needs a hash or a server-side lock, and
///   neither is worth the round trips for a feature whose job is to catch the
///   colleague who edited it this morning.
/// - **A server that reports no mtime disables the check** rather than blocking
///   every save. Refusing to save to a host that will not answer the question
///   would make the file uneditable, which is a worse failure than the one being
///   guarded against.
/// - **`force` skips it entirely**, which is what the user chose when they
///   answered the prompt.
///
/// On success the expectation is advanced to what was just written, so the next
/// save compares against this save rather than conflicting with itself forever.
#[allow(clippy::too_many_arguments)]
async fn save_edit(
    session: Arc<TokioMutex<Slot<wr_ssh::SshSession>>>,
    edit_id: String,
    remote_path: String,
    local_path: PathBuf,
    expected_mtime: Arc<TokioMutex<Option<i64>>>,
    // Filled in when this edit is elevated, and then the only way its bytes can
    // be written back — the SFTP subsystem would be refused for the same reason
    // the ordinary write was.
    elevated: SharedElevation,
    force: bool,
    channel: Channel<SftpEvent>,
) {
    let _ = channel.send(SftpEvent::Uploading {
        edit_id: edit_id.clone(),
        remote_path: remote_path.clone(),
    });

    let outcome: Result<Option<i64>, String> = async {
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

        if !force {
            let expected = *expected_mtime.lock().await;
            // Both sides have to be known for a mismatch to mean anything. A
            // file that has since been deleted also lands here (the stat
            // fails) — and re-creating it is the reasonable reading of a save,
            // so that is not treated as a conflict.
            if let (Some(expected), Ok(current)) = (expected, sftp.stat(&remote_path).await) {
                if current.modified.is_some_and(|m| m != expected) {
                    return Ok(Some(current.modified.unwrap_or_default()));
                }
            }
        }

        match elevated.state.lock().await.as_mut() {
            None => sftp
                .write(&remote_path, &bytes)
                .await
                .map_err(|e| e.to_string())?,
            // Two steps, because neither half can do the other's job: SFTP can
            // write as the connected user but not as root, and the root helper
            // can move bytes already on the host but has no way to receive
            // them. So the save lands in the user's own `0600` scratch file
            // first and the helper copies it into place.
            //
            // The destination is only ever touched by that copy, so a save that
            // dies between the two leaves the remote file exactly as it was.
            Some(elevated) => {
                let staged = elevated.staged_path.clone();
                sftp.write(&staged, &bytes)
                    .await
                    .map_err(|e| format!("could not stage the save on the host: {e}"))?;
                elevated
                    .writer
                    .copy_into(&staged, &remote_path)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        // Re-stat rather than assume: the mtime the server recorded is the one
        // the next save has to match, and it is the server's clock that decides
        // it, not this machine's.
        *expected_mtime.lock().await = sftp.stat(&remote_path).await.ok().and_then(|s| s.modified);
        Ok(None)
    }
    .await;

    let event = match outcome {
        Ok(None) => SftpEvent::Uploaded {
            edit_id,
            remote_path,
        },
        Ok(Some(remote_modified)) => SftpEvent::UploadConflict {
            edit_id,
            remote_path,
            remote_modified: Some(remote_modified),
        },
        Err(error) => SftpEvent::UploadFailed {
            edit_id,
            remote_path,
            error,
        },
    };
    let _ = channel.send(event);
}

/// Saves a watched edit on demand — the answer to a conflict prompt.
///
/// `force: true` is the user saying "overwrite it anyway", having been told
/// what they would be overwriting. `force: false` re-runs the same check the
/// watcher does, which is what makes this usable as a plain "try that save
/// again" after a failure.
///
/// The channel is taken as an argument rather than remembered from
/// `sftp_edit_file`: watches outlive the panel that started them, so the panel
/// asking this question is not necessarily the one that opened the file, and
/// the reply has to go to whoever is listening now.
#[tauri::command]
pub async fn sftp_save_edit(
    edit_id: String,
    force: bool,
    channel: Channel<SftpEvent>,
    ssh_state: State<'_, SshState>,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    let (session_id, remote_path, local_path, expected_mtime, elevated) = {
        let edits = sftp_state.edits.lock().await;
        let entry = edits
            .get(&edit_id)
            .ok_or("that file is no longer being watched")?;
        (
            entry.session_id.clone(),
            entry.remote_path.clone(),
            entry.local_path.clone(),
            entry.expected_mtime.clone(),
            entry.elevated.clone(),
        )
    };
    let session = crate::ssh::lookup(&ssh_state, &session_id).await?;
    save_edit(
        session,
        edit_id,
        remote_path,
        local_path,
        expected_mtime,
        elevated,
        force,
        channel,
    )
    .await;
    Ok(())
}

/// Turns an edit that is already open into a privileged one, so its saves go
/// through root.
///
/// This is the case the feature mostly exists for, and it is not the one that
/// looks obvious from the outside. A file under `/etc` is typically
/// world-readable and root-writable, so opening it works perfectly and it is
/// the *save*, minutes later, that is refused. Elevating at that point costs
/// the user nothing they have typed: the local copy is untouched, only the way
/// back to the host changes.
///
/// Does not save. The panel calls `sftp_save_edit` afterwards, which keeps the
/// mtime conflict check on the same footing it has for every other save — an
/// elevated write must not become a way to skip past a warning that someone
/// else changed the file.
///
/// Idempotent: an edit that is already elevated is left exactly as it is rather
/// than being given a second helper.
#[tauri::command]
pub async fn sftp_elevate_edit(
    edit_id: String,
    channel: Channel<SftpEvent>,
    ssh_state: State<'_, SshState>,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    let (session_id, remote_path, elevated) = {
        let edits = sftp_state.edits.lock().await;
        let entry = edits
            .get(&edit_id)
            .ok_or("that file is no longer being watched")?;
        (
            entry.session_id.clone(),
            entry.remote_path.clone(),
            entry.elevated.clone(),
        )
    };

    // Checked before the round trip and again under the lock below, because
    // between the two there is a prompt with a human in it — long enough for
    // the same file to be elevated by a second panel.
    if elevated.is_installed() {
        return Ok(());
    }

    let session = crate::ssh::lookup(&ssh_state, &session_id).await?;
    let opened = open_elevated(session, &sftp_state, &channel, &remote_path, None).await?;

    // A helper handed back is one that lost the race with another panel doing
    // the same thing. Dropping it here — outside the lock, which `install` is
    // careful to make possible — ends it immediately rather than leaving a
    // second root shell running on the host with nothing pointing at it.
    drop(elevated.install(opened).await);
    Ok(())
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
            // Lock-free, so this cannot end up waiting on a save that is
            // holding the helper — see `Elevation`.
            elevated: e.elevated.is_installed(),
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
    browse_client(&ssh_state, &session_id)
        .await?
        .try_exists(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Refuses to touch a path that an edit watch is still pointing at.
///
/// A watch holds the remote path it re-uploads to, and nothing renames or
/// re-targets it. So renaming a watched file means the next save recreates the
/// *old* name beside the new one, and deleting a watched file means the next
/// save brings it back — in both cases minutes later, triggered by the user
/// saving in an editor they have every reason to think is still pointed at the
/// right file. Neither reports an error; both look like the app undoing what
/// the user just did.
///
/// Refusing is the honest fix. Re-targeting the watch on rename is the better
/// one and is not hard, but the delete case has no such answer, and one rule
/// covering both is easier to rely on than two that differ.
async fn refuse_if_being_edited(
    sftp_state: &State<'_, SftpState>,
    session_id: &str,
    path: &str,
) -> Result<(), String> {
    let edits = sftp_state.edits.lock().await;
    let watched = edits
        .values()
        .any(|e| e.session_id == session_id && e.remote_path == path);
    if watched {
        let name = path.rsplit('/').next().unwrap_or(path);
        return Err(format!(
            "{name} is open for editing. Stop watching it first — otherwise the next save \
             would write it back."
        ));
    }
    Ok(())
}

/// Where a rename lands: the source's own parent, plus a validated bare name.
///
/// This is the whole of the guarantee that a rename cannot become a move. The
/// new name never contributes a directory component — `is_usable_remote_name`
/// refuses a separator — and the parent comes from the path being renamed
/// rather than from anything the caller said, so there is no argument that
/// could redirect it.
fn rename_target(path: &str, new_name: &str) -> Result<String, String> {
    if !is_usable_remote_name(new_name) {
        return Err(format!("{new_name} is not a usable file name"));
    }
    // A remote path is absolute in practice — the panel starts from
    // `canonicalize` — and a relative one has no parent to put the result
    // beside. Rooting it would silently rename into `/`, which is the one
    // outcome worth refusing outright rather than guessing at.
    let (parent, _) = path
        .rsplit_once('/')
        .ok_or_else(|| format!("{path} has no directory to rename within"))?;
    Ok(format!("{parent}/{new_name}"))
}

/// Renames a remote entry within its own directory.
///
/// The destination is built from the *source's* parent plus a validated bare
/// name, so this cannot move anything: renaming `passwd` to `../../etc/passwd`
/// renames it to a file called `..`-something in the same directory, or is
/// refused outright. A move is a different feature with a different UI, and
/// having "rename" quietly be one is how a user loses track of a file.
#[tauri::command]
pub async fn sftp_rename(
    session_id: String,
    path: String,
    new_name: String,
    ssh_state: State<'_, SshState>,
    sftp_state: State<'_, SftpState>,
) -> Result<String, String> {
    let target = rename_target(&path, &new_name)?;
    refuse_if_being_edited(&sftp_state, &session_id, &path).await?;
    if target == path {
        return Ok(target);
    }

    let sftp = browse_client(&ssh_state, &session_id).await?;
    // SFTP v3's rename does not replace, and servers disagree about how they
    // say so — several return a bare "failure". Checking first turns that into
    // a sentence naming the file. It is advisory (something could appear in the
    // gap) but the server still refuses in that case, so the race costs a
    // confusing message rather than a lost file.
    if sftp.try_exists(&target).await.map_err(|e| e.to_string())? {
        return Err(format!("{new_name} already exists here."));
    }
    sftp.rename(&path, &target)
        .await
        .map_err(|e| e.to_string())?;
    Ok(target)
}

/// Deletes a remote file, or an empty directory.
///
/// Whether it is a directory is settled here by `stat` rather than taken from
/// the caller: the frontend's answer comes from a listing that may be minutes
/// old, and getting it wrong means calling `rmdir` on a file (which fails
/// confusingly) or `unlink` on a directory (likewise). One round trip buys the
/// right verb and the right error.
///
/// A non-empty directory is left to the server to refuse. SFTP has no recursive
/// delete, so honouring one here would mean walking the tree — the same queue
/// recursive transfer needs, and far too sharp an edge to grow implicitly out
/// of a menu item labelled "Delete".
#[tauri::command]
pub async fn sftp_remove(
    session_id: String,
    path: String,
    recursive: bool,
    ssh_state: State<'_, SshState>,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    refuse_if_being_edited(&sftp_state, &session_id, &path).await?;

    let sftp = browse_client(&ssh_state, &session_id).await?;
    let stat = sftp.stat(&path).await.map_err(|e| e.to_string())?;
    if !stat.is_dir {
        return sftp
            .remove_file(&path)
            .await
            .map_err(|e| format!("could not delete {path}: {e}"));
    }
    if !recursive {
        return sftp.remove_dir(&path).await.map_err(|e| {
            format!("could not delete {path}: {e} (a directory has to be empty first)")
        });
    }

    // Walked first, so the count in the confirmation the user already answered
    // is the count that gets deleted, and so a tree too large to reason about
    // is refused before anything is removed rather than partway through.
    //
    // The walk skips symlinks, which is exactly right here: it means deleting a
    // directory containing a link to `/etc` removes the link and not `/etc`.
    // The links themselves still have to go, or the directories holding them
    // will not be empty — `remove_file` is the correct verb for one, and it
    // unlinks without touching what it points at.
    let plan = plan_remote_tree(&sftp, &path).await?;
    for file in &plan.files {
        let victim = format!("{path}/{}", file.relative);
        sftp.remove_file(&victim)
            .await
            .map_err(|e| format!("could not delete {victim}: {e}"))?;
    }
    // Children before parents: `rmdir` only works on an empty directory, and
    // the plan is sorted parents-first.
    for dir in plan.dirs.iter().rev() {
        let victim = format!("{path}/{dir}");
        remove_dir_with_links(&sftp, &victim).await?;
    }
    remove_dir_with_links(&sftp, &path).await
}

/// `rmdir`, after unlinking any symlinks the walk deliberately passed over.
///
/// Listing again rather than remembering them from the plan: they are the only
/// entries the walk drops, this is the one place that needs them, and a second
/// small listing costs less than carrying a parallel structure through
/// `TreePlan` for the sake of one caller.
async fn remove_dir_with_links(sftp: &wr_sftp::SftpClient, dir: &str) -> Result<(), String> {
    let entries = sftp
        .list_dir(dir)
        .await
        .map_err(|e| format!("could not read {dir}: {e}"))?;
    for entry in entries.iter().filter(|e| e.is_symlink) {
        let victim = format!("{dir}/{}", entry.name);
        sftp.remove_file(&victim)
            .await
            .map_err(|e| format!("could not delete {victim}: {e}"))?;
    }
    sftp.remove_dir(dir)
        .await
        .map_err(|e| format!("could not delete {dir}: {e}"))
}

/// How much a recursive delete is about to remove, so the confirmation can say
/// so before it happens.
///
/// A separate command rather than a flag on the delete: "are you sure" is worth
/// almost nothing, and "this removes 341 files in 27 directories" is worth a
/// great deal, but only if the user sees it *before* answering.
#[tauri::command]
pub async fn sftp_count_tree(
    session_id: String,
    path: String,
    ssh_state: State<'_, SshState>,
) -> Result<TreeCount, String> {
    let sftp = browse_client(&ssh_state, &session_id).await?;
    let plan = plan_remote_tree(&sftp, &path).await?;
    Ok(TreeCount {
        files: plan.files.len() as u64,
        dirs: plan.dirs.len() as u64,
        bytes: plan.total_bytes,
        links: plan.skipped_links as u64,
    })
}

/// What a directory holds, for a confirmation that can be specific.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeCount {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub links: u64,
}

/// Sets the permission bits on a remote path.
///
/// The mode arrives as a number the frontend parsed from octal, not as a
/// string: "what does `755` mean" is a question with one answer, and parsing it
/// in two places is how the two come to disagree. Anything outside the
/// permission bits is refused here rather than silently masked, because a
/// caller sending `100755` has misunderstood something and quietly turning it
/// into `755` would hide that.
#[tauri::command]
pub async fn sftp_chmod(
    session_id: String,
    path: String,
    mode: u32,
    ssh_state: State<'_, SshState>,
) -> Result<(), String> {
    if mode > 0o7777 {
        return Err(format!("{mode:o} is not a permission mode"));
    }
    browse_client(&ssh_state, &session_id)
        .await?
        .chmod(&path, mode)
        .await
        .map_err(|e| format!("could not change permissions on {path}: {e}"))
}

/// Creates a directory inside `parent`.
#[tauri::command]
pub async fn sftp_mkdir(
    session_id: String,
    parent: String,
    name: String,
    ssh_state: State<'_, SshState>,
) -> Result<String, String> {
    if !is_usable_remote_name(&name) {
        return Err(format!("{name} is not a usable directory name"));
    }
    let dir = parent.trim_end_matches('/');
    let path = format!("{dir}/{name}");

    let sftp = browse_client(&ssh_state, &session_id).await?;
    // Same reasoning as the rename: `mkdir` on an existing path fails, and the
    // server's word for it is rarely "that already exists".
    if sftp.try_exists(&path).await.map_err(|e| e.to_string())? {
        return Err(format!("{name} already exists here."));
    }
    sftp.create_dir(&path)
        .await
        .map_err(|e| format!("could not create {path}: {e}"))?;
    Ok(path)
}

/// The suffix an upload lands under before it is put in place.
const PART_SUFFIX: &str = ".wrustty-part";

/// How many entries a recursive transfer will take on before refusing.
///
/// Not a performance limit — a cap on how wrong a mistake can go. Dropping a
/// folder chosen by accident, or one whose contents are far larger than the
/// user pictured, should be a sentence saying so rather than a walk that runs
/// for minutes before the first byte moves. 20,000 covers a source tree or a
/// year of logs; anything past it is a job for `tar`.
const MAX_TREE_ENTRIES: usize = 20_000;

/// One file in a planned recursive transfer, named relative to the root.
struct PlannedFile {
    /// Always `/`-separated, whichever side it came from — it is joined onto a
    /// remote path in one direction and a `PathBuf` in the other, and one
    /// convention is what keeps the two runners symmetrical.
    relative: String,
    size: u64,
    /// Unix seconds, where the source reported one. Only used to decide whether
    /// a destination copy is already up to date — see `is_already_there`.
    modified: Option<i64>,
}

/// A local timestamp as the Unix seconds the remote side speaks in.
///
/// Local metadata is a `SystemTime` and remote metadata is already seconds, so
/// one of the two has to be converted before they can be compared at all. A
/// pre-epoch time gives `None` rather than a negative number: it cannot come
/// from a file this app wrote, and treating it as unknown falls back to the
/// size-only rule instead of inventing an ordering.
fn unix_seconds(time: Option<std::time::SystemTime>) -> Option<i64> {
    time.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

/// What resume needs to know about one side of one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileFacts {
    size: u64,
    modified: Option<i64>,
}

/// Whether the destination copy can be left alone.
///
/// This is the whole of resume, and it is worth being precise about what it
/// claims. It is **not** "these files are identical" — nothing short of reading
/// both could say that, and reading both is the transfer this exists to avoid.
/// It is "the destination looks like the result of already having copied this",
/// which is the question actually being asked when someone re-runs a transfer
/// that died partway.
///
/// Size must match, and where both sides report an mtime the destination's must
/// be at least the source's. That second test is what stops a *changed* source
/// of coincidentally equal size being skipped — the common shape of which is an
/// edited config file, where a one-character change leaves the size alone. The
/// direction is deliberate: neither side's clock is trusted against the other's,
/// only "the copy is not older than what it was copied from", and a
/// freshly-written destination always satisfies that because writing it set its
/// mtime to now.
///
/// When either side reports no mtime it falls back to size alone and the caller
/// says how many files were skipped, because a silent size-only skip is exactly
/// the kind of thing found out much later by something that needed the file.
fn is_already_there(src: &FileFacts, dst: Option<&FileFacts>) -> bool {
    let Some(dst) = dst else { return false };
    if dst.size != src.size {
        return false;
    }
    match (src.modified, dst.modified) {
        (Some(src_mtime), Some(dst_mtime)) => dst_mtime >= src_mtime,
        _ => true,
    }
}

/// A failed file transfer, and whether trying it again is worth anything.
///
/// The flag has to travel with the message because the decision is made where
/// the error is understood — `SftpError::is_transient` — and acted on a level
/// up, where the retry loop lives. A bare `String` would have meant
/// re-classifying by matching on text.
struct TransferFailure {
    message: String,
    transient: bool,
}

impl TransferFailure {
    /// The default. Anything local — a part file that cannot be created, a
    /// rename that will not go through — is reported as-is: those do not clear
    /// on their own, and the Retry button covers the case where the user has
    /// fixed the cause.
    fn permanent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            transient: false,
        }
    }

    fn from_sftp(error: wr_sftp::SftpError) -> Self {
        Self {
            transient: error.is_transient(),
            message: error.to_string(),
        }
    }
}

/// How many times a per-file transfer is retried before the job gives up.
///
/// Small, because `SftpError::is_transient` only claims errors the protocol
/// itself calls timing — so an attempt that fails twice is telling the truth,
/// and a longer ladder would only delay it.
const TRANSFER_ATTEMPTS: u32 = 3;

/// First backoff step; doubles each retry (200, 400 ms).
const TRANSFER_BACKOFF: Duration = Duration::from_millis(200);

/// Runs one file's transfer, retrying only what is worth retrying.
///
/// The retry is narrow by design. It covers a server hiccup mid-copy, which is
/// otherwise fatal to a 500-file job on file 400 — but it cannot cover a dropped
/// connection, because the session caches its SFTP client and would hand back
/// the same dead channel every time. That case is answered by resume plus the
/// Retry button, not here.
/// Each attempt starts the file over rather than continuing it — the part file
/// is recreated, so a retry cannot append to the half a failed attempt left.
/// Progress for that file therefore goes backwards on a retry, which is the
/// truth about what is being sent.
async fn with_retries<F, Fut>(mut attempt: F) -> Result<wr_sftp::Transferred, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<wr_sftp::Transferred, TransferFailure>>,
{
    let mut delay = TRANSFER_BACKOFF;
    for remaining in (0..TRANSFER_ATTEMPTS).rev() {
        match attempt().await {
            Ok(outcome) => return Ok(outcome),
            Err(e) if remaining > 0 && e.transient => {
                tokio::time::sleep(delay).await;
                delay *= 2;
            }
            Err(e) => return Err(e.message),
        }
    }
    unreachable!("the last attempt always returns")
}

/// What a recursive transfer is going to do, worked out before it starts.
///
/// Walking first costs a pass over the tree and buys the two things a folder
/// transfer needs and a single-file one does not: a total to show progress
/// against, and the chance to refuse an unreasonable job before anything has
/// been created at the destination.
#[derive(Default)]
struct TreePlan {
    /// Relative directory paths, parents before children.
    dirs: Vec<String>,
    files: Vec<PlannedFile>,
    total_bytes: u64,
    /// Symlinks passed over. Reported rather than silently dropped — see
    /// `plan_remote_tree`.
    skipped_links: usize,
}

impl TreePlan {
    fn is_oversized(&self) -> bool {
        self.dirs.len() + self.files.len() > MAX_TREE_ENTRIES
    }

    /// Parents before children, so creating them in order always works.
    /// Lexicographic order does this for `/`-separated relative paths: `a`
    /// sorts before `a/b`.
    fn sorted(mut self) -> Self {
        self.dirs.sort();
        self.files.sort_by(|a, b| a.relative.cmp(&b.relative));
        self
    }
}

/// Walks a remote directory tree.
///
/// **Symlinks are skipped, not followed.** Following them means a link to `/`
/// copies the filesystem and a link to an ancestor never terminates, and this
/// walk has no way to tell a useful link from either. Copying them *as links*
/// would be better, and SFTP can do it — but a link's target is meaningful only
/// on the host it came from, so recreating one locally produces something
/// broken that looks like it worked. Skipping and saying how many were skipped
/// is the only option that is never quietly wrong.
async fn plan_remote_tree(sftp: &wr_sftp::SftpClient, root: &str) -> Result<TreePlan, String> {
    let mut plan = TreePlan::default();
    // Breadth is irrelevant here and a stack avoids a deque; order is imposed
    // at the end by `sorted`.
    let mut pending = vec![String::new()];
    while let Some(rel) = pending.pop() {
        let dir = if rel.is_empty() {
            root.to_string()
        } else {
            format!("{root}/{rel}")
        };
        let entries = sftp
            .list_dir(&dir)
            .await
            .map_err(|e| format!("could not read {dir}: {e}"))?;
        absorb_listing(&mut plan, &rel, &dir, root, entries, &mut pending)?;
    }
    Ok(plan.sorted())
}

/// Folds one directory listing into the plan.
///
/// Split out from the walk above so the refusal below can be exercised without
/// a server, because that refusal is the whole trust boundary of the download
/// direction: every name here was chosen by the *remote host*, and the relative
/// paths built from them are joined straight onto the local directory the user
/// picked.
fn absorb_listing(
    plan: &mut TreePlan,
    rel: &str,
    dir: &str,
    root: &str,
    entries: Vec<wr_sftp::RemoteEntry>,
    pending: &mut Vec<String>,
) -> Result<(), String> {
    for entry in entries {
        // The mirror of the check `plan_local_tree` makes on names read off the
        // local filesystem — and the more important of the two, because these
        // names come from the other side of the connection.
        //
        // `PathBuf::join` neither normalises nor refuses: a `..` component
        // survives to the OS, so a server answering with `..` walks the
        // download one directory further up per level, and an *absolute* name
        // discards the base path entirely — `local_root.join("C:\\…\\Startup\\
        // evil.bat")` is that path and nothing else. `part_path_for` does not
        // catch either, since it inspects only the basename and the traversal
        // lives in the directory portion.
        //
        // The whole job is refused rather than the entry skipped, matching the
        // local walk: a server sending `..` is not one whose remaining entries
        // are worth trusting.
        //
        // `is_usable_remote_name` alone is not enough here, because it is the
        // POSIX-shaped check and these names land on *Windows*. It lets a colon
        // through, and `local_root.join("C:evil.dll")` is `C:evil.dll` — a
        // drive-relative path that discards the base and resolves against the
        // process's working directory (for another drive, against its root,
        // so `D:Users/…` is `D:\Users\…`). The basename check in
        // `part_path_for` cannot see it either, since `file_name()` of that
        // path is just `evil.dll`. The Windows-name rules reject the colon and
        // every other name that cannot be written as itself.
        if !is_usable_remote_name(&entry.name) || is_unsafe_windows_filename(&entry.name) {
            return Err(format!(
                "{dir} contains a name this cannot copy: {}",
                entry.name
            ));
        }
        let child = if rel.is_empty() {
            entry.name.clone()
        } else {
            format!("{rel}/{}", entry.name)
        };
        // Checked before `is_dir`, which is true for a link *to* a
        // directory and would otherwise send the walk straight into it.
        if entry.is_symlink {
            plan.skipped_links += 1;
            continue;
        }
        if entry.is_dir {
            plan.dirs.push(child.clone());
            pending.push(child);
        } else {
            plan.total_bytes += entry.size;
            plan.files.push(PlannedFile {
                relative: child,
                size: entry.size,
                modified: entry.modified,
            });
        }
        if plan.is_oversized() {
            return Err(format!(
                "{root} holds more than {MAX_TREE_ENTRIES} entries — too much to copy from \
                 here. Archive it on the host first."
            ));
        }
    }
    Ok(())
}

/// Walks a local directory tree, for an upload.
///
/// Symlinks are skipped for the same reasons as the remote walk, and with the
/// extra Windows wrinkle that a directory junction is a reparse point most
/// tools present as an ordinary directory — `symlink_metadata` is what tells
/// them apart, so it is what this asks.
async fn plan_local_tree(root: &std::path::Path) -> Result<TreePlan, String> {
    let mut plan = TreePlan::default();
    let mut pending = vec![String::new()];
    while let Some(rel) = pending.pop() {
        let dir = if rel.is_empty() {
            root.to_path_buf()
        } else {
            root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
        };
        let mut reader = tokio::fs::read_dir(&dir)
            .await
            .map_err(|e| format!("could not read {}: {e}", dir.display()))?;
        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|e| format!("could not read {}: {e}", dir.display()))?
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            // The remote side is POSIX and the name is about to be joined onto
            // a remote path, so a name this app could not send has to be caught
            // here rather than halfway through the transfer.
            if !is_usable_remote_name(&name) {
                return Err(format!(
                    "{} contains a file this cannot send: {name}",
                    dir.display()
                ));
            }
            let child = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let meta = tokio::fs::symlink_metadata(entry.path())
                .await
                .map_err(|e| format!("could not read {}: {e}", entry.path().display()))?;
            if meta.is_symlink() {
                plan.skipped_links += 1;
                continue;
            }
            if meta.is_dir() {
                plan.dirs.push(child.clone());
                pending.push(child);
            } else {
                plan.total_bytes += meta.len();
                plan.files.push(PlannedFile {
                    relative: child,
                    size: meta.len(),
                    modified: unix_seconds(meta.modified().ok()),
                });
            }
            if plan.is_oversized() {
                return Err(format!(
                    "{} holds more than {MAX_TREE_ENTRIES} entries — too much to send from here.",
                    root.display()
                ));
            }
        }
    }
    Ok(plan.sorted())
}

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

/// `root` joined with a plan's `/`-separated relative path — refused unless
/// every component of that path is a plain name.
///
/// The name checks at planning time are what should keep a bad path out of a
/// plan; this is the backstop at the point of use, where a miss would decide
/// what gets written to local disk. `PathBuf::join` replaces the base outright
/// for anything carrying a root or a drive prefix (`C:x` included, which has a
/// prefix but no root), and keeps `..` as given — so a relative path made of
/// anything other than `Normal` components is not one that stays under `root`.
fn local_target(root: &std::path::Path, relative: &str) -> Result<PathBuf, String> {
    let relative = std::path::Path::new(relative);
    let plain = relative
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)));
    if !plain || relative.as_os_str().is_empty() {
        return Err(format!(
            "refusing a path that would land outside {}: {}",
            root.display(),
            relative.display()
        ));
    }
    Ok(root.join(relative))
}

/// Whether a name can be joined onto a remote directory.
///
/// Guards every path where the app builds a remote path out of a directory the
/// user chose and a name that came from somewhere else: an upload's filename, a
/// rename's new name, a new directory's name. In each case the directory *is*
/// the user's choice, and a name carrying a separator or a `..` would silently
/// act somewhere else — the difference between renaming a file and moving it
/// into `/etc`.
///
/// Deliberately narrower than the remote-name checks further up this file:
/// those guard a remote-chosen name being written to *local* disk, where
/// Windows device names and alternate data streams are the hazard. This guards
/// a name being acted on over a *POSIX* host, where the hazard is the path
/// separator and nothing else.
fn is_usable_remote_name(name: &str) -> bool {
    !(name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0'))
}

/// One transfer in flight.
struct TransferEntry {
    /// The chunk sender, for an upload whose bytes arrive from the webview.
    /// Dropping it is what tells the reader the file has ended — so finishing
    /// and cancelling are both "take the entry out of the map", and differ
    /// only in whether the flag was set on the way.
    ///
    /// `None` for every transfer the backend reads for itself: a download, and
    /// an upload from a local path. Those have no chunks coming and end when
    /// the file does, so the flag below is the whole of their control.
    tx: Option<mpsc::Sender<Vec<u8>>>,
    cancel: Arc<AtomicBool>,
    /// The session carrying it, so a reconnect can find the transfers its own
    /// drop interrupted rather than every transfer in the app.
    session_id: String,
    /// How to run this transfer again, or `None` for one that cannot be.
    /// See [`RestartSpec`].
    restart: Option<RestartSpec>,
    /// Where this transfer reports. Kept so a restart continues on the same
    /// channel, and so the row the user is watching carries on rather than a
    /// second one appearing beside it.
    channel: Channel<SftpEvent>,
}

/// What it takes to run a transfer again from the top.
///
/// Only the arguments, deliberately — not a captured client or a half-finished
/// job. Re-running goes back through the same command body, and that body
/// re-resolves its SFTP client from the session; the `OnceCell` behind it is
/// reset when a session disconnects, so after a reconnect the second run opens
/// a channel on the connection that came back rather than the one that died.
/// That is the whole reason this can be as simple as "call it again".
///
/// A restart always passes `resume: true`, which is the same thing the Retry
/// button does: skip what already looks copied, so a folder that died on file
/// 400 of 500 costs the remaining hundred.
/// A transfer waiting for its session to come back.
struct InterruptedTransfer {
    session_id: String,
    spec: RestartSpec,
    channel: Channel<SftpEvent>,
}

#[derive(Clone)]
enum RestartSpec {
    /// Covers a single file and a folder alike: the command stats the path and
    /// decides which it is, so one variant is honestly enough for both.
    Download {
        remote_path: String,
        local_path: String,
    },
    Upload {
        remote_dir: String,
        local_path: String,
        overwrite: bool,
    },
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
    let (sftp, remote_path, part_path, exists) =
        prepare_upload(&ssh_state, &session_id, &remote_dir, &name, overwrite).await?;

    let transfer_id = sftp_state.next_transfer_id();
    let cancel = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<Vec<u8>>(CHUNK_QUEUE);
    sftp_state.transfers.lock().await.insert(
        transfer_id.clone(),
        TransferEntry {
            tx: Some(tx),
            cancel: cancel.clone(),
            session_id: session_id.clone(),
            // The one kind that cannot be re-run. Its bytes arrive from the
            // webview, which is holding a `File` the backend has no path for —
            // there is nothing here to read them from a second time. A drop
            // during one of these is reported as needing the user, because it
            // does: only they can drag the file again.
            restart: None,
            channel: channel.clone(),
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

/// Uploads a file the user picked from a dialog, streaming it straight off
/// local disk.
///
/// The other route exists because a *dropped* file reaches the webview as a
/// `File` with no path on it, so its bytes have to travel over IPC. A picker
/// hands over a path, so they don't: this opens the file in Rust and the
/// webview never touches a byte. Same destination guarantees as the drop —
/// part file, rename into place — and the same cancellation.
///
/// The name is taken from the path rather than accepted as an argument. It is
/// the one the user saw in the dialog, and a second argument would only be
/// somewhere for the two to disagree.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sftp_upload_path(
    app: AppHandle,
    session_id: String,
    remote_dir: String,
    local_path: String,
    overwrite: bool,
    // See `sftp_download_begin`. Only meaningful for a folder.
    resume: bool,
    channel: Channel<SftpEvent>,
    ssh_state: State<'_, SshState>,
    sftp_state: State<'_, SftpState>,
) -> Result<String, String> {
    begin_upload_path(
        app,
        &ssh_state,
        &sftp_state,
        session_id,
        remote_dir,
        local_path,
        overwrite,
        resume,
        channel,
        None,
    )
    .await
}

/// The body of [`sftp_upload_path`]. See [`begin_download`] for why the
/// transfer id can be supplied rather than minted.
#[allow(clippy::too_many_arguments)]
async fn begin_upload_path(
    app: AppHandle,
    ssh_state: &State<'_, SshState>,
    sftp_state: &State<'_, SftpState>,
    session_id: String,
    remote_dir: String,
    local_path: String,
    overwrite: bool,
    resume: bool,
    channel: Channel<SftpEvent>,
    existing_id: Option<String>,
) -> Result<String, String> {
    let local = PathBuf::from(&local_path);
    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("{local_path} has no file name"))?;

    // A directory is walked before anything is created on the far side, so an
    // unreadable or unreasonable tree is refused while the host is still
    // untouched.
    if local.is_dir() {
        let plan = plan_local_tree(&local).await?;
        return start_upload_tree(
            app,
            ssh_state,
            sftp_state,
            &session_id,
            &remote_dir,
            &name,
            local,
            plan,
            resume,
            channel,
            existing_id,
        )
        .await;
    }

    // Opened before the destination is prepared: a file that cannot be read is
    // the user's own pick and the fastest thing to find out about, and doing it
    // first means nothing has been created on the far side to clean up.
    let file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("could not open {local_path}: {e}"))?;
    let total = file.metadata().await.map(|m| m.len()).unwrap_or(0);

    let (sftp, remote_path, part_path, exists) =
        prepare_upload(ssh_state, &session_id, &remote_dir, &name, overwrite).await?;

    let transfer_id = existing_id.unwrap_or_else(|| sftp_state.next_transfer_id());
    let cancel = Arc::new(AtomicBool::new(false));
    // No chunk sender: the bytes are read here, not sent in. The flag is the
    // whole of this transfer's control.
    sftp_state.transfers.lock().await.insert(
        transfer_id.clone(),
        TransferEntry {
            tx: None,
            cancel: cancel.clone(),
            session_id: session_id.clone(),
            restart: Some(RestartSpec::Upload {
                remote_dir: remote_dir.clone(),
                local_path: local_path.clone(),
                overwrite,
            }),
            channel: channel.clone(),
        },
    );

    let _ = channel.send(SftpEvent::TransferStarted {
        transfer_id: transfer_id.clone(),
        remote_path: remote_path.clone(),
        total,
    });

    let task_id = transfer_id.clone();
    tokio::spawn(async move {
        run_upload(
            app,
            sftp,
            file,
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

/// Registers and launches a recursive upload.
///
/// Split out only because `sftp_upload_path` would otherwise have two halves
/// that share nothing but their arguments — a folder has no single destination
/// file to check for, no `overwrite` question (it merges into whatever is
/// there), and no part file of its own.
#[allow(clippy::too_many_arguments)]
async fn start_upload_tree(
    app: AppHandle,
    ssh_state: &State<'_, SshState>,
    sftp_state: &State<'_, SftpState>,
    session_id: &str,
    remote_dir: &str,
    name: &str,
    local_root: PathBuf,
    plan: TreePlan,
    resume: bool,
    channel: Channel<SftpEvent>,
    existing_id: Option<String>,
) -> Result<String, String> {
    if !is_usable_remote_name(name) {
        return Err(format!("{name} is not a usable directory name"));
    }
    let remote_root = format!("{}/{name}", remote_dir.trim_end_matches('/'));
    let sftp = transfer_client(ssh_state, session_id).await?;

    let transfer_id = existing_id.unwrap_or_else(|| sftp_state.next_transfer_id());
    let cancel = Arc::new(AtomicBool::new(false));
    sftp_state.transfers.lock().await.insert(
        transfer_id.clone(),
        TransferEntry {
            tx: None,
            cancel: cancel.clone(),
            session_id: session_id.to_string(),
            // The *parent* directory and the local root, which is what
            // `sftp_upload_path` takes — re-running it walks the tree again and
            // rebuilds the plan, rather than replaying a plan made against a
            // local directory that may have changed meanwhile.
            restart: Some(RestartSpec::Upload {
                remote_dir: remote_dir.to_string(),
                local_path: local_root.to_string_lossy().into_owned(),
                overwrite: false,
            }),
            channel: channel.clone(),
        },
    );

    let _ = channel.send(SftpEvent::TransferStarted {
        transfer_id: transfer_id.clone(),
        remote_path: remote_root.clone(),
        total: plan.total_bytes,
    });

    let task_id = transfer_id.clone();
    tokio::spawn(async move {
        run_upload_tree(
            app,
            sftp,
            local_root,
            remote_root,
            plan,
            resume,
            channel,
            task_id,
            cancel,
        )
        .await
    });
    Ok(transfer_id)
}

/// Everything both upload routes settle before a byte moves: the name is
/// usable, the channel is open, and the destination is either free or the user
/// has said to replace it. Returns the client, the destination, the part path
/// it lands under first, and whether something is being replaced.
async fn prepare_upload(
    ssh_state: &State<'_, SshState>,
    session_id: &str,
    remote_dir: &str,
    name: &str,
    overwrite: bool,
) -> Result<(Arc<wr_sftp::SftpClient>, String, String, bool), String> {
    if !is_usable_remote_name(name) {
        return Err(format!("{name} is not a usable file name"));
    }
    // A remote directory is POSIX whatever the client is.
    let dir = remote_dir.trim_end_matches('/');
    let remote_path = format!("{dir}/{name}");
    let part_path = format!("{remote_path}{PART_SUFFIX}");

    let sftp = transfer_client(ssh_state, session_id).await?;

    // Re-checked here rather than trusted from the frontend's own `exists`
    // call, which by then is several dialogs old.
    let exists = sftp
        .try_exists(&remote_path)
        .await
        .map_err(|e| e.to_string())?;
    if exists && !overwrite {
        return Err(format!("{remote_path} already exists"));
    }
    Ok((sftp, remote_path, part_path, exists))
}

/// Drives one upload to its end and reports which end it was.
///
/// Generic over the source because there are two: a `ChunkReader` fed from the
/// webview by a dropped file, and a plain `tokio::fs::File` for one picked
/// from disk. Everything after the first byte — the part file, the progress,
/// the cancellation, the rename into place — is identical, and this is the
/// half worth having exactly once.
#[allow(clippy::too_many_arguments)]
async fn run_upload<R>(
    app: AppHandle,
    sftp: std::sync::Arc<wr_sftp::SftpClient>,
    reader: R,
    part_path: String,
    remote_path: String,
    replacing: bool,
    channel: Channel<SftpEvent>,
    transfer_id: String,
    cancel: Arc<AtomicBool>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let progress_channel = channel.clone();
    let progress_id = transfer_id.clone();
    let progress_cancel = cancel.clone();
    let outcome = sftp
        .upload(&part_path, reader, move |transferred| {
            let _ = progress_channel.send(SftpEvent::TransferProgress {
                transfer_id: progress_id.clone(),
                transferred,
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
        transfers.get(&transfer_id).and_then(|e| e.tx.clone())
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

/// Asks a running transfer to stop, in either direction. Sets the flag *before*
/// dropping the entry — and with it any chunk sender — so the task can tell a
/// cancellation from a file that simply ended.
///
/// Either way the transfer stops between chunks, so this is bounded by one
/// chunk's round trip rather than by what is left of the file.
#[tauri::command]
pub async fn sftp_cancel_transfer(
    transfer_id: String,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    if let Some(entry) = sftp_state.transfers.lock().await.remove(&transfer_id) {
        entry.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Where a download lands before it is put in place — and the check that the
/// destination is somewhere it may land at all.
///
/// The name is checked because the save dialog's *suggestion* came from the
/// remote host, and the user very likely accepted it: this is a remote-chosen
/// name being written to local disk, so it inherits the rules every other such
/// name does. Without the check, downloading a file called `NUL` writes to the
/// null device and reports success — the user loses the file and is told it
/// arrived.
///
/// The part file is a *sibling* of the destination, not a temp-directory entry.
/// A rename across filesystems isn't atomic and degrades to a copy, which would
/// undo the whole reason for staging the download in the first place.
fn part_path_for(local: &std::path::Path) -> Result<PathBuf, String> {
    let basename = local
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("{} has no file name", local.display()))?;
    if is_unsafe_windows_filename(&basename) {
        return Err(format!("unsafe local filename: {basename}"));
    }
    Ok(local.with_file_name(format!("{basename}{PART_SUFFIX}")))
}

/// Downloads a remote file to a local path the user chose, streaming it.
///
/// The mirror of `sftp_upload_path`, and asymmetric with the *drop* upload on
/// purpose: a save dialog hands over a real local path, so the bytes never
/// cross IPC in this direction — Rust reads the SFTP stream and writes
/// straight to disk. There is no chunk command and no transfer-id header
/// because there is nothing for the webview to carry.
///
/// **Nothing at the destination is touched until the whole file has arrived**,
/// the same promise the upload makes: the download lands under
/// `<name>.wrustty-part` beside its destination and is renamed over it only on
/// success. Downloading a newer copy over a file and losing the connection
/// halfway should not cost the user the copy they already had.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sftp_download_begin(
    app: AppHandle,
    session_id: String,
    remote_path: String,
    local_path: String,
    // Skip destination files that already look copied. Set when the user
    // presses Retry on a failed transfer, which is what makes "it died on file
    // 400 of 500" cost the remaining hundred rather than all five.
    resume: bool,
    channel: Channel<SftpEvent>,
    ssh_state: State<'_, SshState>,
    sftp_state: State<'_, SftpState>,
) -> Result<String, String> {
    begin_download(
        app,
        &ssh_state,
        &sftp_state,
        session_id,
        remote_path,
        local_path,
        resume,
        channel,
        None,
    )
    .await
}

/// The body of [`sftp_download_begin`], reachable without an IPC call.
///
/// `existing_id` reuses a transfer id rather than minting one, which is what a
/// restart after a reconnect passes: the frontend is already showing a row
/// under that id, and continuing it says "this is the same job, still going"
/// where a new id would say "the old one died and here is another".
#[allow(clippy::too_many_arguments)]
async fn begin_download(
    app: AppHandle,
    ssh_state: &State<'_, SshState>,
    sftp_state: &State<'_, SftpState>,
    session_id: String,
    remote_path: String,
    local_path: String,
    resume: bool,
    channel: Channel<SftpEvent>,
    existing_id: Option<String>,
) -> Result<String, String> {
    let local = PathBuf::from(&local_path);
    // Validates the destination name before anything is created, and is what
    // the per-file staging will use.
    part_path_for(&local)?;

    let sftp = transfer_client(ssh_state, &session_id).await?;

    // Before creating anything locally, so a path that isn't there fails with
    // the remote's own words and leaves no debris.
    let stat = sftp
        .stat(&remote_path)
        .await
        .map_err(|e| format!("could not read {remote_path}: {e}"))?;

    // A folder is walked first: the total to show progress against, and the
    // chance to refuse an unreasonable job, both come from that pass.
    let plan = if stat.is_dir {
        Some(plan_remote_tree(&sftp, &remote_path).await?)
    } else {
        None
    };
    let total = plan.as_ref().map_or(stat.size, |p| p.total_bytes);

    let transfer_id = existing_id.unwrap_or_else(|| sftp_state.next_transfer_id());
    let cancel = Arc::new(AtomicBool::new(false));
    sftp_state.transfers.lock().await.insert(
        transfer_id.clone(),
        TransferEntry {
            tx: None,
            cancel: cancel.clone(),
            session_id: session_id.clone(),
            restart: Some(RestartSpec::Download {
                remote_path: remote_path.clone(),
                local_path: local_path.clone(),
            }),
            channel: channel.clone(),
        },
    );

    // Sent rather than returned because the total is something only this side
    // knows, and a progress bar that has to wait for the first chunk to learn
    // its own length starts life as a spinner for no reason.
    let _ = channel.send(SftpEvent::TransferStarted {
        transfer_id: transfer_id.clone(),
        remote_path: remote_path.clone(),
        total,
    });

    let task_id = transfer_id.clone();
    tokio::spawn(async move {
        match plan {
            Some(plan) => {
                run_download_tree(
                    app,
                    sftp,
                    remote_path,
                    local,
                    plan,
                    resume,
                    channel,
                    task_id,
                    cancel,
                )
                .await
            }
            None => run_download(app, sftp, local, remote_path, channel, task_id, cancel).await,
        }
    });

    Ok(transfer_id)
}

/// Streams one remote file to one local path, staged and renamed.
///
/// The single-file download and every file of a folder download go through
/// here, so "the destination is not touched until the whole file has arrived"
/// is one piece of code rather than a property two paths have to keep
/// agreeing on.
///
/// `progress` is called with *this file's* running byte count; a folder
/// transfer adds its own base to make that a job total.
async fn download_one(
    sftp: &wr_sftp::SftpClient,
    remote: &str,
    local: &std::path::Path,
    progress: impl FnMut(u64) -> bool,
) -> Result<wr_sftp::Transferred, TransferFailure> {
    let part = part_path_for(local).map_err(TransferFailure::permanent)?;
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| {
        TransferFailure::permanent(format!("could not write to {}: {e}", part.display()))
    })?;

    let outcome = sftp.download(remote, &mut file, progress).await;
    let placed: Result<wr_sftp::Transferred, TransferFailure> = match outcome {
        Err(e) => Err(TransferFailure::from_sftp(e)),
        Ok(wr_sftp::Transferred::Cancelled) => Ok(wr_sftp::Transferred::Cancelled),
        Ok(wr_sftp::Transferred::Complete) => {
            // Before the rename, not after: a rename that lands while the
            // contents are still only in the page cache is exactly the
            // truncated-file outcome the part file exists to prevent.
            match file.sync_all().await {
                Ok(()) => {
                    // Dropped here so Windows isn't asked to rename a file it
                    // still holds an open handle on.
                    drop(file);
                    let (from, to) = (part.clone(), local.to_path_buf());
                    // `replace_atomic` sleeps through a backoff ladder on the
                    // Windows failures that clear on their own, so it does not
                    // belong on the runtime's thread.
                    tokio::task::spawn_blocking(move || wr_fs::replace_atomic(&from, &to))
                        .await
                        .map_err(|e| e.to_string())
                        .and_then(|r| r.map_err(|e| e.to_string()))
                        .map(|()| wr_sftp::Transferred::Complete)
                        .map_err(|e| {
                            TransferFailure::permanent(format!(
                                "downloaded, but could not move it into place as {}: {e}",
                                local.display()
                            ))
                        })
                }
                Err(e) => Err(TransferFailure::permanent(format!(
                    "could not finish writing {}: {e}",
                    local.display()
                ))),
            }
        }
    };

    // Whatever happened, the part file must not outlive it — a failed download
    // that leaves `report.log.wrustty-part` next to the real file is litter the
    // user has to identify and clean up themselves. On success it is gone
    // already, having been renamed; `remove_file` then finds nothing, which is
    // why the error is dropped.
    if !matches!(placed, Ok(wr_sftp::Transferred::Complete)) {
        let _ = tokio::fs::remove_file(&part).await;
    }
    placed
}

/// Puts a finished `.wrustty-part` into place on the host.
///
/// Remove-then-rename because SFTP v3's rename will not overwrite. The window
/// between the two is real but small, and it opens only once the new data is
/// complete on the far side.
async fn place_remote_part(
    sftp: &wr_sftp::SftpClient,
    part_path: &str,
    remote_path: &str,
    replacing: bool,
) -> Result<(), String> {
    if replacing {
        sftp.remove_file(remote_path)
            .await
            .map_err(|e| format!("could not replace {remote_path}: {e}"))?;
    }
    sftp.rename(part_path, remote_path)
        .await
        .map_err(|e| format!("uploaded, but could not move it into place as {remote_path}: {e}"))
}

/// Streams one local file to one remote path, staged and renamed. The mirror of
/// `download_one`, and used by the same two callers in the other direction.
async fn upload_one(
    sftp: &wr_sftp::SftpClient,
    local: &std::path::Path,
    remote: &str,
    progress: impl FnMut(u64) -> bool,
) -> Result<wr_sftp::Transferred, TransferFailure> {
    let part_path = format!("{remote}{PART_SUFFIX}");
    let file = tokio::fs::File::open(local).await.map_err(|e| {
        TransferFailure::permanent(format!("could not open {}: {e}", local.display()))
    })?;
    let replacing = sftp
        .try_exists(remote)
        .await
        .map_err(TransferFailure::from_sftp)?;

    let outcome = sftp.upload(&part_path, file, progress).await;
    let placed: Result<wr_sftp::Transferred, TransferFailure> = match outcome {
        Err(e) => Err(TransferFailure::from_sftp(e)),
        Ok(wr_sftp::Transferred::Cancelled) => Ok(wr_sftp::Transferred::Cancelled),
        Ok(wr_sftp::Transferred::Complete) => {
            place_remote_part(sftp, &part_path, remote, replacing)
                .await
                .map(|()| wr_sftp::Transferred::Complete)
                .map_err(TransferFailure::permanent)
        }
    };
    if !matches!(placed, Ok(wr_sftp::Transferred::Complete)) {
        let _ = sftp.remove_file(&part_path).await;
    }
    placed
}

/// Drives one download to its end and reports which end it was.
#[allow(clippy::too_many_arguments)]
async fn run_download(
    app: AppHandle,
    sftp: std::sync::Arc<wr_sftp::SftpClient>,
    local: PathBuf,
    remote_path: String,
    channel: Channel<SftpEvent>,
    transfer_id: String,
    cancel: Arc<AtomicBool>,
) {
    // A single file gets the same retry as one inside a folder. There is no
    // resume for it — half a file is not a file, and the part-file staging
    // means there is never half a file at the destination to resume onto.
    let outcome = with_retries(|| {
        let progress_channel = channel.clone();
        let progress_id = transfer_id.clone();
        let progress_cancel = cancel.clone();
        download_one(&sftp, &remote_path, &local, move |transferred| {
            let _ = progress_channel.send(SftpEvent::TransferProgress {
                transfer_id: progress_id.clone(),
                transferred,
            });
            !progress_cancel.load(Ordering::Relaxed)
        })
    })
    .await;

    // Same reasoning as the upload: a cancel that lands after the last chunk
    // arrives as `Complete`, and the flag is what tells the two apart.
    let cancelled = cancel.load(Ordering::Relaxed);
    finish_transfer(&app, &channel, transfer_id, remote_path, outcome, cancelled).await;
}

/// Copies a whole remote directory down, file by file.
///
/// **There is no atomic tree.** Each *file* keeps the guarantee it has on its
/// own — staged beside its destination, renamed into place — but a job that
/// stops halfway leaves the files it already finished. That is deliberate:
/// staging the whole tree somewhere else and moving it at the end would double
/// the disk needed and turn a resumable nuisance into an all-or-nothing one,
/// and there is no atomic directory swap to reach for anyway. What matters is
/// that no *individual* file is ever left half-written, and that the failure
/// says how far it got.
#[allow(clippy::too_many_arguments)]
async fn run_download_tree(
    app: AppHandle,
    sftp: std::sync::Arc<wr_sftp::SftpClient>,
    remote_root: String,
    local_root: PathBuf,
    plan: TreePlan,
    resume: bool,
    channel: Channel<SftpEvent>,
    transfer_id: String,
    cancel: Arc<AtomicBool>,
) {
    let count = plan.files.len() as u64;
    let mut skipped = 0u64;
    let outcome = async {
        // Every directory first, including the empty ones — a folder that
        // copies without its empty subdirectories has not been copied.
        tokio::fs::create_dir_all(&local_root)
            .await
            .map_err(|e| format!("could not create {}: {e}", local_root.display()))?;
        for dir in &plan.dirs {
            let path = local_target(&local_root, dir)?;
            tokio::fs::create_dir_all(&path)
                .await
                .map_err(|e| format!("could not create {}: {e}", path.display()))?;
        }

        let mut base = 0u64;
        for (i, file) in plan.files.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Ok(wr_sftp::Transferred::Cancelled);
            }
            let remote = format!("{remote_root}/{}", file.relative);
            let local = local_target(&local_root, &file.relative)?;

            if resume {
                let dst = tokio::fs::metadata(&local).await.ok().map(|m| FileFacts {
                    size: m.len(),
                    modified: unix_seconds(m.modified().ok()),
                });
                let src = FileFacts {
                    size: file.size,
                    modified: file.modified,
                };
                if is_already_there(&src, dst.as_ref()) {
                    // Counted as done: the bar measures the job the user asked
                    // for, not the part of it that happened to need doing.
                    base += file.size;
                    skipped += 1;
                    continue;
                }
            }

            let _ = channel.send(SftpEvent::TransferFile {
                transfer_id: transfer_id.clone(),
                name: file.relative.clone(),
                index: i as u64 + 1,
                count,
            });

            let outcome = with_retries(|| {
                let progress_channel = channel.clone();
                let progress_id = transfer_id.clone();
                let progress_cancel = cancel.clone();
                download_one(&sftp, &remote, &local, move |bytes| {
                    let _ = progress_channel.send(SftpEvent::TransferProgress {
                        transfer_id: progress_id.clone(),
                        // The job's running total, not this file's — one bar,
                        // one meaning, however many files it is made of.
                        transferred: base + bytes,
                    });
                    !progress_cancel.load(Ordering::Relaxed)
                })
            })
            .await
            .map_err(|e| format!("{} ({} of {count}): {e}", file.relative, i + 1))?;

            if matches!(outcome, wr_sftp::Transferred::Cancelled) {
                return Ok(wr_sftp::Transferred::Cancelled);
            }
            // The planned size, not what arrived: a file that grew since the
            // walk would otherwise push the bar past its own total, and the
            // total is what the walk measured.
            base += file.size;
        }
        Ok(wr_sftp::Transferred::Complete)
    }
    .await;

    note_what_was_skipped(&channel, &transfer_id, plan.skipped_links, skipped);

    let cancelled = cancel.load(Ordering::Relaxed);
    finish_transfer(&app, &channel, transfer_id, remote_root, outcome, cancelled).await;
}

/// Reports the two kinds of file a recursive transfer passed over.
///
/// Both are said out loud rather than buried, and for the same reason: a copy
/// quietly missing entries is the kind of thing found out much later, by
/// something that needed one. Resume's skip is the more dangerous of the two to
/// leave silent, because it is the one that looks like a complete copy.
fn note_what_was_skipped(
    channel: &Channel<SftpEvent>,
    transfer_id: &str,
    links: usize,
    already_there: u64,
) {
    let mut notes: Vec<String> = Vec::new();
    if already_there > 0 {
        notes.push(format!(
            "{already_there} file{} already up to date and left alone",
            if already_there == 1 { "" } else { "s" }
        ));
    }
    if links > 0 {
        notes.push(format!(
            "{links} symbolic link{} skipped — a link's target only means something on the host it \
             came from",
            if links == 1 { "" } else { "s" }
        ));
    }
    if !notes.is_empty() {
        let _ = channel.send(SftpEvent::TransferNote {
            transfer_id: transfer_id.to_owned(),
            note: notes.join("; "),
        });
    }
}

/// Sends a whole local directory up. The mirror of `run_download_tree`, with
/// the same partial-failure semantics.
#[allow(clippy::too_many_arguments)]
async fn run_upload_tree(
    app: AppHandle,
    sftp: std::sync::Arc<wr_sftp::SftpClient>,
    local_root: PathBuf,
    remote_root: String,
    plan: TreePlan,
    resume: bool,
    channel: Channel<SftpEvent>,
    transfer_id: String,
    cancel: Arc<AtomicBool>,
) {
    let count = plan.files.len() as u64;
    let mut skipped = 0u64;
    let outcome = async {
        // `create_dir` fails on one that already exists, and re-sending into an
        // existing tree is an ordinary thing to want — so an existing directory
        // is not an error here, only a failure to create a missing one is.
        for dir in std::iter::once(&String::new()).chain(plan.dirs.iter()) {
            let path = if dir.is_empty() {
                remote_root.clone()
            } else {
                format!("{remote_root}/{dir}")
            };
            if !sftp.try_exists(&path).await.map_err(|e| e.to_string())? {
                sftp.create_dir(&path)
                    .await
                    .map_err(|e| format!("could not create {path}: {e}"))?;
            }
        }

        let mut base = 0u64;
        for (i, file) in plan.files.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Ok(wr_sftp::Transferred::Cancelled);
            }
            let local = local_target(&local_root, &file.relative)?;
            let remote = format!("{remote_root}/{}", file.relative);

            if resume {
                let dst = sftp.stat(&remote).await.ok().map(|s| FileFacts {
                    size: s.size,
                    modified: s.modified,
                });
                let src = FileFacts {
                    size: file.size,
                    modified: file.modified,
                };
                if is_already_there(&src, dst.as_ref()) {
                    base += file.size;
                    skipped += 1;
                    continue;
                }
            }

            let _ = channel.send(SftpEvent::TransferFile {
                transfer_id: transfer_id.clone(),
                name: file.relative.clone(),
                index: i as u64 + 1,
                count,
            });

            let outcome = with_retries(|| {
                let progress_channel = channel.clone();
                let progress_id = transfer_id.clone();
                let progress_cancel = cancel.clone();
                upload_one(&sftp, &local, &remote, move |bytes| {
                    let _ = progress_channel.send(SftpEvent::TransferProgress {
                        transfer_id: progress_id.clone(),
                        transferred: base + bytes,
                    });
                    !progress_cancel.load(Ordering::Relaxed)
                })
            })
            .await
            .map_err(|e| format!("{} ({} of {count}): {e}", file.relative, i + 1))?;

            if matches!(outcome, wr_sftp::Transferred::Cancelled) {
                return Ok(wr_sftp::Transferred::Cancelled);
            }
            base += file.size;
        }
        Ok(wr_sftp::Transferred::Complete)
    }
    .await;

    note_what_was_skipped(&channel, &transfer_id, plan.skipped_links, skipped);

    let cancelled = cancel.load(Ordering::Relaxed);
    finish_transfer(&app, &channel, transfer_id, remote_root, outcome, cancelled).await;
}

/// The one place a transfer's ending becomes an event and lets go of its id.
///
/// Every runner ends the same way and used to say so in its own words, which is
/// how a cancelled folder transfer came to report differently from a cancelled
/// file. `cancelled` is read from the flag rather than inferred from the
/// outcome because a cancel landing after the last chunk arrives as `Complete`.
async fn finish_transfer(
    app: &AppHandle,
    channel: &Channel<SftpEvent>,
    transfer_id: String,
    remote_path: String,
    outcome: Result<wr_sftp::Transferred, String>,
    cancelled: bool,
) {
    let _ = match outcome {
        Err(error) => channel.send(SftpEvent::TransferFailed {
            transfer_id: transfer_id.clone(),
            remote_path,
            error,
        }),
        Ok(_) if cancelled => channel.send(SftpEvent::TransferCancelled {
            transfer_id: transfer_id.clone(),
        }),
        Ok(wr_sftp::Transferred::Cancelled) => channel.send(SftpEvent::TransferCancelled {
            transfer_id: transfer_id.clone(),
        }),
        Ok(wr_sftp::Transferred::Complete) => channel.send(SftpEvent::TransferDone {
            transfer_id: transfer_id.clone(),
            remote_path,
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

/// Sets aside the transfers a dropped connection has just killed, so the
/// reconnect can pick them up.
///
/// Called the moment the transport is reported lost, which is a race worth
/// being explicit about: the transfer's own task is at the same time failing on
/// its next SFTP call and taking its entry out of the map. That is why this
/// copies rather than moves — the running task still ends the way it always
/// did, and this only needs the description of the job, which nothing else
/// wants. Whichever of the two goes first, the record survives.
///
/// A chunk-fed upload has no [`RestartSpec`] and is passed over. Its bytes came
/// from a `File` in the webview that the backend never had a path for, so there
/// is nothing to read them from a second time; the user is told, because only
/// they can drag the file again.
pub(crate) async fn interrupt_session_transfers(app: &AppHandle, session_id: &str) {
    let state = app.state::<SftpState>();
    let live = state.transfers.lock().await;
    let mut waiting = state.interrupted.lock().await;
    for (id, entry) in live.iter() {
        if entry.session_id != session_id {
            continue;
        }
        match &entry.restart {
            Some(spec) => {
                let _ = entry.channel.send(SftpEvent::TransferInterrupted {
                    transfer_id: id.clone(),
                });
                waiting.insert(
                    id.clone(),
                    InterruptedTransfer {
                        session_id: entry.session_id.clone(),
                        spec: spec.clone(),
                        channel: entry.channel.clone(),
                    },
                );
            }
            None => {
                let _ = entry.channel.send(SftpEvent::TransferFailed {
                    transfer_id: id.clone(),
                    remote_path: String::new(),
                    error: "the connection dropped, and a dropped file cannot be sent again on its own — drop it again to retry".to_string(),
                });
            }
        }
    }
}

/// Runs the transfers that were waiting on this session, against the connection
/// that came back.
///
/// Always with `resume: true`, which is the same thing the Retry button does:
/// keep what already landed and copy the rest. The id is reused, so the row the
/// user is watching carries on rather than being replaced by a second one.
///
/// One at a time. They share a single SFTP channel, so starting five at once
/// would only interleave them on the same wire, and the failures want to be
/// reported one at a time anyway.
pub(crate) async fn resume_session_transfers(app: &AppHandle, session_id: &str) {
    let waiting: Vec<(String, InterruptedTransfer)> = {
        let state = app.state::<SftpState>();
        let mut interrupted = state.interrupted.lock().await;
        let ids: Vec<String> = interrupted
            .iter()
            .filter(|(_, t)| t.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| interrupted.remove(&id).map(|t| (id, t)))
            .collect()
    };

    for (transfer_id, t) in waiting {
        // Taken fresh inside the loop: `State` borrows the app, and holding two
        // across the awaits below would keep them alive for the whole run.
        let ssh_state = app.state::<SshState>();
        let sftp_state = app.state::<SftpState>();
        let outcome = match t.spec.clone() {
            RestartSpec::Download {
                remote_path,
                local_path,
            } => {
                begin_download(
                    app.clone(),
                    &ssh_state,
                    &sftp_state,
                    session_id.to_string(),
                    remote_path,
                    local_path,
                    true,
                    t.channel.clone(),
                    Some(transfer_id.clone()),
                )
                .await
            }
            RestartSpec::Upload {
                remote_dir,
                local_path,
                overwrite,
            } => {
                begin_upload_path(
                    app.clone(),
                    &ssh_state,
                    &sftp_state,
                    session_id.to_string(),
                    remote_dir,
                    local_path,
                    overwrite,
                    true,
                    t.channel.clone(),
                    Some(transfer_id.clone()),
                )
                .await
            }
        };

        if outcome.is_ok() {
            // After the restart has taken the row, not before: if the call had
            // failed, "resumed" followed immediately by "failed" would be two
            // claims about one moment, and the first of them wrong.
            let _ = t.channel.send(SftpEvent::TransferResumed {
                transfer_id: transfer_id.clone(),
            });
        }

        if let Err(error) = outcome {
            // The restart never got far enough to own the row, so nothing else
            // is going to report this. Says what it was rather than only that
            // it failed: after a reconnect the likely causes are a remote path
            // that has moved and a local one that is no longer writable, and
            // neither is guessable from "restart failed".
            let _ = t.channel.send(SftpEvent::TransferFailed {
                transfer_id: transfer_id.clone(),
                remote_path: String::new(),
                error: format!("could not resume after reconnecting: {error}"),
            });
        }
    }
}

/// Forgets a session's waiting transfers, for a pane that is going away.
///
/// Without this they would sit in the map for the life of the process, and a
/// later session reusing the id — ids come from one counter, so it cannot —
/// is not the risk. The leak is.
pub(crate) async fn forget_interrupted_transfers(
    sftp_state: &State<'_, SftpState>,
    session_id: &str,
) {
    sftp_state
        .interrupted
        .lock()
        .await
        .retain(|_, t| t.session_id != session_id);
}

#[cfg(test)]
mod tests {
    use super::{
        absorb_listing, is_already_there, is_inert_to_open, is_unsafe_windows_filename,
        is_usable_remote_name, local_target, parse_editor_command, part_path_for, rename_target,
        ChunkReader, SftpEvent, TreePlan,
    };
    use std::path::{Path, PathBuf};
    use tokio::sync::mpsc;

    /// The wire names of the two events a reconnect sends.
    ///
    /// Pinned because a mismatch here is silent on both sides: the enum renames
    /// its variants and fields, the frontend matches on the result as string
    /// literals, and nothing compiles against both. The same reasoning — and the
    /// same class of bug, which once made port forwarding unusable — is written
    /// up beside `ForwardSpec`'s own contract test in wr-ssh.
    #[test]
    fn the_reconnect_events_serialize_as_the_panel_reads_them() {
        let interrupted = serde_json::to_string(&SftpEvent::TransferInterrupted {
            transfer_id: "transfer-3".to_string(),
        })
        .unwrap();
        assert_eq!(
            interrupted,
            r#"{"type":"transferInterrupted","transferId":"transfer-3"}"#
        );

        let resumed = serde_json::to_string(&SftpEvent::TransferResumed {
            transfer_id: "transfer-3".to_string(),
        })
        .unwrap();
        assert_eq!(
            resumed,
            r#"{"type":"transferResumed","transferId":"transfer-3"}"#
        );
    }

    /// A resumed transfer keeps its id, and that is the point rather than a
    /// detail: the panel is already showing a row under it, so continuing it
    /// says "the same job, still going" where a fresh id would say "that one
    /// died, here is another". The two events above therefore have to name the
    /// id the row already knows.
    #[test]
    fn a_resumed_transfer_is_reported_under_the_id_the_row_already_has() {
        let id = "transfer-7".to_string();
        for json in [
            serde_json::to_string(&SftpEvent::TransferInterrupted {
                transfer_id: id.clone(),
            })
            .unwrap(),
            serde_json::to_string(&SftpEvent::TransferResumed {
                transfer_id: id.clone(),
            })
            .unwrap(),
        ] {
            assert!(json.contains(&id), "{json}");
        }
    }

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
            assert!(!is_usable_remote_name(name), "{name:?} should be refused");
        }
        for name in [
            "notes.txt",
            "archive.tar.gz",
            ".bashrc",
            "a file with spaces.log",
        ] {
            assert!(is_usable_remote_name(name), "{name:?} should be accepted");
        }
    }

    fn remote_entry(name: &str, is_dir: bool) -> wr_sftp::RemoteEntry {
        wr_sftp::RemoteEntry {
            name: name.to_string(),
            is_dir,
            is_symlink: false,
            size: 1,
            modified: None,
            mode: None,
            owner: None,
            group: None,
            uid: None,
            gid: None,
        }
    }

    /// The download walk's trust boundary. Every name in a listing was chosen
    /// by the server, and each becomes a relative path joined onto the local
    /// directory the user picked — where `join` normalises nothing and drops
    /// the base outright for an absolute path. `part_path_for` does not cover
    /// this: it validates the basename, and the escape is in the directory
    /// part.
    ///
    /// Asserted as "the plan is refused", not as "the write landed somewhere":
    /// what matters is that no plan carrying one of these is ever built.
    #[test]
    fn a_download_refuses_a_listing_that_would_escape_the_destination() {
        for name in [
            "..",
            ".",
            "../..",
            "../../etc/passwd",
            "sub/dir",
            "C:\\Users\\dev\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\evil.bat",
            "/etc/cron.d/evil",
            "nul\0.txt",
            "",
            // Drive-relative: no separator anywhere, yet `join` drops the base
            // for these and resolves them against the working directory, or
            // against another drive's root.
            "C:evil.dll",
            "D:Users",
            "c:",
            // Names Windows will not write as themselves.
            "notes.txt:payload",
            "NUL",
            "trailing.",
        ] {
            let mut plan = TreePlan::default();
            let mut pending = Vec::new();
            let refused = absorb_listing(
                &mut plan,
                "",
                "/srv/data",
                "/srv/data",
                vec![remote_entry(name, false)],
                &mut pending,
            );
            assert!(
                refused.is_err(),
                "{name:?} should refuse the whole download"
            );
            assert!(plan.files.is_empty(), "{name:?} should reach no plan");
        }
        // A directory entry takes the same route to `create_dir_all`, so it is
        // refused on the same terms rather than only when it holds a file.
        let mut plan = TreePlan::default();
        let mut pending = Vec::new();
        assert!(absorb_listing(
            &mut plan,
            "logs",
            "/srv/data/logs",
            "/srv/data",
            vec![remote_entry("..", true)],
            &mut pending
        )
        .is_err());
        assert!(plan.dirs.is_empty());
        assert!(pending.is_empty());
    }

    /// The backstop at the point of use: whatever reached a plan, a relative
    /// path that is not all plain names never becomes a local path.
    #[test]
    fn a_plan_path_that_would_leave_the_root_is_refused_where_it_is_joined() {
        let root = PathBuf::from("dest");
        for rel in [
            "",
            "..",
            "a/../..",
            "/etc/passwd",
            "C:evil.dll",
            "D:Users/x",
        ] {
            // `C:x` is only a prefix on Windows; elsewhere it is an ordinary
            // name and joining it is harmless.
            if cfg!(not(windows)) && rel.contains(':') {
                continue;
            }
            assert!(local_target(&root, rel).is_err(), "{rel:?}");
        }
        assert_eq!(
            local_target(&root, "logs/nginx.log").unwrap(),
            root.join("logs").join("nginx.log")
        );
    }

    /// The guard has to stay narrow: an ordinary listing must still walk, and
    /// the relative paths it produces are what the transfer is made of.
    #[test]
    fn an_ordinary_listing_still_plans() {
        let mut plan = TreePlan::default();
        let mut pending = Vec::new();
        absorb_listing(
            &mut plan,
            "logs",
            "/srv/data/logs",
            "/srv/data",
            vec![
                remote_entry("nginx.log", false),
                remote_entry("archive", true),
                remote_entry("a file with spaces.txt", false),
            ],
            &mut pending,
        )
        .unwrap();
        assert_eq!(plan.dirs, ["logs/archive"]);
        assert_eq!(pending, ["logs/archive"]);
        assert_eq!(
            plan.files
                .iter()
                .map(|f| f.relative.as_str())
                .collect::<Vec<_>>(),
            ["logs/nginx.log", "logs/a file with spaces.txt"]
        );
    }

    /// The part file has to be a sibling of the destination: a rename across
    /// filesystems is not atomic and degrades to a copy, which is exactly what
    /// staging the download was meant to avoid.
    #[test]
    fn a_download_stages_beside_its_destination() {
        let local = Path::new("C:/Users/dev/Downloads/report.log");
        let part = part_path_for(local).unwrap();
        assert_eq!(
            part,
            PathBuf::from("C:/Users/dev/Downloads/report.log.wrustty-part")
        );
        assert_eq!(part.parent(), local.parent());
    }

    /// The save dialog suggests the *remote* name and the user usually takes
    /// it, so a hostile or merely odd one reaches local disk here. Accepting
    /// `NUL` would write the download to the null device and report success.
    #[test]
    fn a_download_refuses_a_local_name_that_is_not_a_file() {
        for name in ["NUL", "nul.txt", "COM1", "report.txt.", "notes.txt:stream"] {
            assert!(
                part_path_for(&PathBuf::from("/tmp").join(name)).is_err(),
                "{name} should be refused before anything is created"
            );
        }
    }

    /// The guard has to stay narrow here too — a false positive is a download
    /// the user simply cannot save.
    #[test]
    fn a_download_accepts_an_ordinary_local_name() {
        for name in ["report.log", "my notes.txt", "archive.tar.gz", ".bashrc"] {
            assert!(
                part_path_for(&PathBuf::from("/tmp").join(name)).is_ok(),
                "{name} should be accepted"
            );
        }
    }

    #[test]
    fn a_rename_stays_in_the_directory_it_started_in() {
        assert_eq!(
            rename_target("/etc/nginx/nginx.conf", "nginx.conf.bak").unwrap(),
            "/etc/nginx/nginx.conf.bak"
        );
        // A file directly under the root still has a parent, and it is `/`.
        assert_eq!(rename_target("/passwd", "shadow").unwrap(), "/shadow");
    }

    /// The guarantee that "rename" cannot quietly be "move". Every one of these
    /// would otherwise put the file somewhere the user never chose — and a file
    /// that has moved is much harder to notice than one that failed to rename.
    #[test]
    fn a_rename_cannot_climb_out_of_its_directory() {
        for name in ["../passwd", "/etc/passwd", "a/b", "a\\b", "..", ".", ""] {
            assert!(
                rename_target("/home/dev/notes.txt", name).is_err(),
                "{name:?} should be refused as a new name"
            );
        }
    }

    /// Nothing in the app produces one — the panel starts from `canonicalize` —
    /// but rooting a relative path would rename into `/`, which is the single
    /// outcome worth refusing rather than guessing at.
    #[test]
    fn a_rename_refuses_a_path_with_no_directory() {
        assert!(rename_target("notes.txt", "other.txt").is_err());
    }

    /// Two things depend on this order and would both fail quietly without it:
    /// creating destination directories (a child before its parent fails) and
    /// recursive delete, which walks the same list backwards because `rmdir`
    /// only works on an empty directory.
    #[test]
    fn a_plan_orders_parents_before_children() {
        let plan = TreePlan {
            dirs: vec![
                "a/b/c".into(),
                "b".into(),
                "a".into(),
                "a/b".into(),
                "a-sibling".into(),
            ],
            ..Default::default()
        }
        .sorted();
        assert_eq!(plan.dirs, ["a", "a-sibling", "a/b", "a/b/c", "b"]);

        // Reversed, every directory comes after everything inside it — which is
        // the property the delete relies on.
        for (i, dir) in plan.dirs.iter().enumerate() {
            for child in &plan.dirs[i + 1..] {
                assert!(
                    !dir.starts_with(&format!("{child}/")),
                    "{child} must not sort before its child {dir}"
                );
            }
        }
    }

    /// The cap is a limit on how wrong a mistake can go, so it has to count
    /// both kinds of entry — a tree of 20,000 empty directories is exactly as
    /// unreasonable as one of 20,000 files.
    #[test]
    fn a_plan_counts_directories_towards_the_cap() {
        let mut plan = TreePlan::default();
        assert!(!plan.is_oversized());
        plan.dirs = vec![String::new(); super::MAX_TREE_ENTRIES];
        assert!(!plan.is_oversized());
        plan.files.push(super::PlannedFile {
            relative: "one-too-many".into(),
            size: 0,
            modified: None,
        });
        assert!(plan.is_oversized());
    }

    /// The setting people will actually type, on the platform this targets.
    #[test]
    fn an_editor_command_keeps_a_windows_path_intact() {
        let (program, args) = parse_editor_command(
            r#""C:\Program Files\Microsoft VS Code\Code.exe" --wait"#,
            Path::new(r"C:\Temp\notes.txt"),
        )
        .unwrap();
        // Backslashes survive: treating them as escapes is how a setting that
        // looks obviously correct fails mysteriously.
        assert_eq!(program, r"C:\Program Files\Microsoft VS Code\Code.exe");
        assert_eq!(args, ["--wait", r"C:\Temp\notes.txt"]);
    }

    #[test]
    fn an_editor_command_appends_the_path_when_there_is_no_placeholder() {
        let (program, args) = parse_editor_command("code --wait", Path::new("/tmp/a.txt")).unwrap();
        assert_eq!(program, "code");
        assert_eq!(args, ["--wait", "/tmp/a.txt"]);
    }

    /// The placeholder exists for editors that will not take the file last.
    #[test]
    fn an_editor_command_substitutes_the_placeholder_in_place() {
        let (program, args) =
            parse_editor_command("gvim -f {file} +1", Path::new("/tmp/a.txt")).unwrap();
        assert_eq!(program, "gvim");
        assert_eq!(args, ["-f", "/tmp/a.txt", "+1"]);

        // Anywhere in an argument, not only as the whole of one.
        let (_, args) = parse_editor_command("ed --file={file}", Path::new("/tmp/a.txt")).unwrap();
        assert_eq!(args, ["--file=/tmp/a.txt"]);
    }

    /// A path with a space in it is the case quoting exists for, and the one
    /// that would otherwise arrive as two arguments.
    #[test]
    fn an_editor_command_passes_a_spaced_path_as_one_argument() {
        let (_, args) =
            parse_editor_command("code --wait", Path::new(r"C:\My Files\a b.txt")).unwrap();
        assert_eq!(args, ["--wait", r"C:\My Files\a b.txt"]);
    }

    #[test]
    fn an_editor_command_has_to_be_something() {
        assert!(parse_editor_command("", Path::new("/tmp/a")).is_err());
        assert!(parse_editor_command("   ", Path::new("/tmp/a")).is_err());
        assert!(parse_editor_command(r#""unclosed --wait"#, Path::new("/tmp/a")).is_err());
    }

    fn facts(size: u64, modified: Option<i64>) -> super::FileFacts {
        super::FileFacts { size, modified }
    }

    /// What resume is for: the second run of a transfer that died partway.
    #[test]
    fn a_file_already_copied_is_left_alone() {
        assert!(is_already_there(
            &facts(1024, Some(100)),
            Some(&facts(1024, Some(100)))
        ));
        // A destination written *after* the source is still a copy of it —
        // downloading sets the local mtime to now, so this is the ordinary case
        // rather than the exception.
        assert!(is_already_there(
            &facts(1024, Some(100)),
            Some(&facts(1024, Some(500)))
        ));
    }

    #[test]
    fn a_file_that_is_not_there_is_copied() {
        assert!(!is_already_there(&facts(1024, Some(100)), None));
    }

    #[test]
    fn a_different_size_is_always_copied() {
        assert!(!is_already_there(
            &facts(1024, Some(100)),
            Some(&facts(1023, Some(500)))
        ));
    }

    /// The hazard resume has to not walk into. Editing one character in a
    /// config file leaves its size alone, so size-only would skip the very
    /// change the user is copying — and would look like it worked.
    #[test]
    fn a_newer_source_of_the_same_size_is_copied_again() {
        assert!(!is_already_there(
            &facts(1024, Some(900)),
            Some(&facts(1024, Some(100)))
        ));
    }

    /// Some servers report no mtime at all. Refusing to skip would make resume
    /// useless against them; skipping on size alone is the documented fallback,
    /// and the transfer says how many files it passed over either way.
    #[test]
    fn a_missing_mtime_falls_back_to_size_alone() {
        assert!(is_already_there(
            &facts(1024, None),
            Some(&facts(1024, Some(1)))
        ));
        assert!(is_already_there(
            &facts(1024, Some(1)),
            Some(&facts(1024, None))
        ));
        assert!(!is_already_there(
            &facts(1024, None),
            Some(&facts(99, None))
        ));
    }

    /// An empty file is a file: zero-length on both sides is a match, not a
    /// missing destination.
    #[test]
    fn an_empty_file_counts_as_already_there() {
        assert!(is_already_there(
            &facts(0, Some(5)),
            Some(&facts(0, Some(5)))
        ));
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

#[cfg(test)]
mod identity_tests {
    use super::parse_id_output;

    #[test]
    fn reads_the_ordinary_shape() {
        let id =
            parse_id_output("uid=1000(tim) gid=1000(tim) groups=1000(tim),27(sudo),100(users)");
        assert_eq!(id.uid, Some(1000));
        assert_eq!(id.gids, vec![1000, 27, 100]);
        assert_eq!(id.user.as_deref(), Some("tim"));
    }

    #[test]
    fn notices_root() {
        // uid 0 is not constrained by the mode bits at all, so the panel must
        // never predict a refusal for it.
        let id = parse_id_output("uid=0(root) gid=0(root) groups=0(root)");
        assert_eq!(id.uid, Some(0));
    }

    #[test]
    fn keeps_a_primary_group_that_is_not_in_the_list() {
        // Only `gid=` is guaranteed to carry it. A file owned by that group
        // would otherwise be judged against the "other" bits and predicted
        // unwritable when it is not.
        let id = parse_id_output("uid=1000(tim) gid=50(staff) groups=27(sudo)");
        assert_eq!(id.gids, vec![50, 27]);
    }

    #[test]
    fn does_not_repeat_the_primary_group() {
        let id = parse_id_output("uid=1000(tim) gid=1000(tim) groups=1000(tim),27(sudo)");
        assert_eq!(id.gids, vec![1000, 27]);
    }

    #[test]
    fn survives_an_account_with_no_passwd_entry() {
        // Numeric-only output is what a uid with no name looks like, and it is
        // still perfectly usable — the decision was never about names.
        let id = parse_id_output("uid=1000 gid=1000 groups=1000");
        assert_eq!(id.uid, Some(1000));
        assert_eq!(id.gids, vec![1000]);
        assert_eq!(id.user, None);
    }

    #[test]
    fn an_unparseable_reply_predicts_nothing() {
        // A restricted shell or an appliance CLI answering something else must
        // leave the panel unable to guess, not guessing wrongly.
        let id = parse_id_output("-rbash: id: command not found");
        assert_eq!(id.uid, None);
        assert!(id.gids.is_empty());
    }

    #[test]
    fn ignores_a_banner_above_the_answer() {
        let id = parse_id_output(
            "Welcome to example.net
uid=501(tim) gid=20(staff) groups=20(staff)",
        );
        assert_eq!(id.uid, Some(501));
        assert_eq!(id.gids, vec![20]);
    }
}
