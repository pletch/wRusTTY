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
    /// A configured editor that this app launched has exited. Only sent for an
    /// `externalEditor` command; the OS opener returns immediately.
    /// `still_watching` means the command exited too fast (see
    /// `MIN_EDITOR_LIFETIME`) and the watch was kept.
    EditorExited {
        edit_id: String,
        remote_path: String,
        still_watching: bool,
    },
    /// The remote file changed under an edit and the save was **not** made.
    /// `sftp_save_edit` with `force` overwrites anyway.
    UploadConflict {
        edit_id: String,
        remote_path: String,
        /// Unix seconds; `None` if the server stopped reporting one.
        remote_modified: Option<i64>,
    },
    /// The `Transfer*` variants belong to an explicit transfer (upload or
    /// download); the `Upload*` ones above belong to saving an edit, which has no
    /// progress or cancel. Direction isn't on the wire: the caller knows it.
    ///
    /// `TransferStarted` is sent only when the backend learned the total (a
    /// download, or an upload from a local path).
    TransferStarted {
        transfer_id: String,
        remote_path: String,
        total: u64,
    },
    TransferProgress {
        transfer_id: String,
        /// Bytes moved so far; for a folder, the running total across all files.
        transferred: u64,
    },
    /// Which file a folder transfer is on (`index` is 1-based). Not sent for a
    /// single file.
    TransferFile {
        transfer_id: String,
        name: String,
        index: u64,
        count: u64,
    },
    /// A note about a transfer that still succeeded, e.g. symlinks a recursive
    /// copy skipped.
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
    /// The connection dropped and the transfer is waiting for the session to
    /// come back. Unlike `TransferFailed`, nothing is needed from the user.
    TransferInterrupted {
        transfer_id: String,
    },
    /// The session came back and the transfer resumed, under the same id.
    TransferResumed {
        transfer_id: String,
    },
    /// Sudo on the host wants a password to open a file as root. Answered by
    /// `sftp_respond_sudo_prompt`. Sent on the panel's channel, since this is a
    /// second credential distinct from SSH authentication.
    SudoPrompt {
        request_id: String,
        remote_path: String,
        /// A password was already tried and rejected.
        retry: bool,
    },
}

/// One live edit watch, as reported to the frontend by `sftp_list_edits`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveEdit {
    pub edit_id: String,
    pub remote_path: String,
    /// Whether a root helper is running for this edit; shown so the user knows.
    pub elevated: bool,
}

struct EditEntry {
    session_id: String,
    remote_path: String,
    local_path: PathBuf,
    /// The remote mtime the local copy was taken from, checked before each save
    /// and updated after it. Shared with the watcher, which has no handle on
    /// `SftpState`.
    expected_mtime: Arc<TokioMutex<Option<i64>>>,
    /// The privileged half of this edit, filled in only if it's opened or saved
    /// as root. Always present as a cell because the watcher captures it once at
    /// creation; `sftp_elevate_edit` must fill this same cell.
    elevated: SharedElevation,
    // Held for Drop: stops the watcher thread and deletes the temp directory.
    _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
    _temp_dir: tempfile::TempDir,
}

/// One edit's elevation, shared between the watcher, the panel and whatever
/// elevates it.
type SharedElevation = Arc<Elevation>;

/// Whether an edit is elevated, and its helper. The helper sits behind an async
/// mutex (one request/reply stream); the flag lets `sftp_list_edits` check
/// elevation without waiting on a save. Only `install` sets either.
#[derive(Default)]
struct Elevation {
    state: TokioMutex<Option<ElevatedEdit>>,
    installed: AtomicBool,
}

impl Elevation {
    /// Lock-free; see the type's note.
    fn is_installed(&self) -> bool {
        self.installed.load(Ordering::Relaxed)
    }

    /// Takes the helper unless one is already installed, returning the loser so
    /// it isn't dropped (spawning its cleanup) while the lock is held.
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

/// What makes one edit privileged: the root helper and the unprivileged
/// staging file on the host. Dropping it closes the helper's channel, so the
/// root `sh` exits on every teardown path. See `wr_ssh::sudo`.
struct ElevatedEdit {
    writer: SudoWriter,
    /// A `0600` file in the host's `/tmp`, owned by the connected user, rewritten
    /// by every save.
    staged_path: String,
    /// Kept so the staged file can be unlinked on drop.
    session: Arc<TokioMutex<Slot<wr_ssh::SshSession>>>,
}

impl Drop for ElevatedEdit {
    fn drop(&mut self) {
        // Best-effort and not awaited. A missed cleanup leaves an empty `0600`
        // file in `/tmp`.
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
    /// Transfers in flight, by id. Each exit path removes its own entry, so a
    /// late cancel finds nothing.
    transfers: TokioMutex<HashMap<String, TransferEntry>>,
    /// Transfers whose connection dropped, waiting to resume under the same id.
    /// Separate from `transfers` because these outlive the task that ran them.
    interrupted: TokioMutex<HashMap<String, InterruptedTransfer>>,
    /// Sudo password prompts waiting on an answer, by request id. Each waiter
    /// times out (`SUDO_PROMPT_TIMEOUT`), so disconnects need no cleanup here.
    pending_sudo: TokioMutex<HashMap<String, oneshot::Sender<Option<Zeroizing<String>>>>>,
    next_id: AtomicU64,
}

impl SftpState {
    fn next_edit_id(&self) -> String {
        format!("edit-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    /// Shares the counter with `next_edit_id`; one counter can't duplicate.
    fn next_transfer_id(&self) -> String {
        format!("transfer-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    fn next_sudo_request_id(&self) -> String {
        format!("sudo-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }
}

/// The SFTP client for browsing and editing.
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

/// The SFTP client for bulk transfers, on its own channel so a long download
/// doesn't block directory listings.
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

/// Extensions handed to the OS opener without asking. Everything else gets a
/// confirmation, because on Windows remote `.hta`, `.lnk`, `.scr`, `.js`,
/// `.wsf`, `.ps1` or `.bat` files execute when opened. `.js` and `.py` are
/// deliberately absent: both have executing default handlers on Windows.
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
    // These reach the extension branch; `Dockerfile` has no dot and is
    // already inert.
    "service",
    "repo",
    "list",
];

// `svg` is deliberately not inert: Windows opens it in a browser, and SVG
// can carry `<script>`.

/// Windows filename hazards that a `..`/separator check misses, checked on
/// every platform:
///
/// - Reserved device names (`NUL`, `NUL.txt`): the edit would silently go
///   nowhere.
/// - Alternate data streams (`notes.txt:payload`).
/// - Trailing dots and spaces, which normalization strips.
/// - Forbidden characters (`< > " | ? *`), rejected here so the error names
///   the file.
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

/// Whether `basename` can go straight to the OS opener. Only the last
/// extension counts (`notes.txt.exe` is an exe); no extension is inert.
fn is_inert_to_open(basename: &str) -> bool {
    match basename.rsplit_once('.') {
        None => true,
        Some((stem, ext)) => {
            // `.bashrc` is a stem, not an extension.
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

/// Delay between the editor exiting and the watch being torn down, so a
/// final save still inside the 300 ms debounce isn't lost.
const EDITOR_EXIT_GRACE: Duration = Duration::from_millis(1500);

/// Below this, the editor is assumed not to have waited: commands must block
/// (`code --wait`, `subl --wait`, `gvim -f`). A fast exit keeps the watch and
/// tells the frontend.
const MIN_EDITOR_LIFETIME: Duration = Duration::from_secs(3);

/// Splits a configured editor command into program and arguments, with the
/// file path substituted for `{file}` (or appended if absent). Backslash is
/// not an escape, since it's the Windows path separator; only double quotes
/// group.
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
                // `""` is still an argument.
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

/// Asks before opening something whose handler might execute it. A dismissed
/// or failed dialog means no.
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

/// Who the session is connected as, so the panel can predict a refused write
/// and go straight to sudo. Numeric because SFTP v3 attributes carry no owner
/// names (`russh_sftp` always decodes them as `None`).
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteIdentity {
    /// The numeric uid; `None` if `id` couldn't be read ("predict nothing").
    pub uid: Option<u32>,
    /// Every group, numerically, including the primary.
    pub gids: Vec<u32>,
    /// Display only; `None` for an account with no passwd entry.
    pub user: Option<String>,
}

/// Parses `id`'s output (`uid=1000(tim) gid=1000(tim) groups=...`, under
/// `LC_ALL=C`). Anything unparseable yields an empty identity, which the
/// frontend treats as "don't guess".
fn parse_id_output(out: &str) -> RemoteIdentity {
    let line = out.lines().find(|l| l.contains("uid=")).unwrap_or("");

    // The value between `key=` and the next space.
    let field = |key: &str| -> Option<&str> {
        let rest = line.split(&format!("{key}=")).nth(1)?;
        let end = rest.find(' ').unwrap_or(rest.len());
        Some(&rest[..end])
    };
    // `1000(tim)` -> 1000.
    let id_of = |spec: &str| -> Option<u32> { spec.split('(').next()?.trim().parse::<u32>().ok() };
    let name_of = |spec: &str| -> Option<String> {
        let open = spec.find('(')?;
        let close = spec.rfind(')')?;
        (close > open + 1).then(|| spec[open + 1..close].to_string())
    };

    let uid_spec = field("uid").unwrap_or("");
    // The primary gid is only guaranteed in `gid=`; take both.
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

/// Asks the host who this session is, via one `exec` of `id`. The panel
/// caches it per session. Hosts that won't run `id` just leave the panel
/// unable to predict.
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

/// How long a sudo prompt waits before counting as canceled; bounds the
/// waiting task even if the panel goes away.
const SUDO_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// Password attempts before the open is abandoned.
const SUDO_PASSWORD_ATTEMPTS: usize = 3;

/// What came back from a sudo password prompt.
enum SudoAnswer {
    Given(Zeroizing<String>),
    /// The user declined, or nothing was listening.
    Cancelled,
    /// The prompt went out and no answer came; reported differently from a
    /// cancel because the user may never have seen it.
    Unanswered,
}

/// Puts a sudo password prompt in front of the user and waits. The password
/// stays `Zeroizing` and is never logged or returned to the webview.
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
        // The panel that asked is gone. Logged: from the user's side it looks
        // like a dialog that never rendered.
        log::warn!("sudo: nothing was listening for the password prompt");
        sftp_state.pending_sudo.lock().await.remove(&request_id);
        return SudoAnswer::Cancelled;
    }

    let answered = tokio::time::timeout(SUDO_PROMPT_TIMEOUT, rx).await;
    // Including on timeout.
    sftp_state.pending_sudo.lock().await.remove(&request_id);
    match answered {
        Ok(Ok(Some(password))) => SudoAnswer::Given(password),
        // An explicit "no", or the panel answering on its way out.
        Ok(Ok(None)) | Ok(Err(_)) => SudoAnswer::Cancelled,
        Err(_) => SudoAnswer::Unanswered,
    }
}

/// The user's answer to a sudo prompt, or `None` to cancel. Never persisted.
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

/// Authenticates a privileged helper for one file and optionally reads the
/// file through it. `sink` is `None` when elevating an already-open edit,
/// whose local copy is the user's work in progress.
///
/// The password lives only in this function; the read needs it again since
/// sudo's timestamp doesn't carry between `exec` channels. The first attempt
/// sends no password, so `NOPASSWD` hosts never prompt.
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

    // Authenticate before creating or writing anything.
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
                            return Err("opening this file as root was canceled".to_string())
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

    // No probe copy: READY already proves root, and there's no harmless trial
    // destination.
    Ok(ElevatedEdit {
        writer,
        staged_path,
        session,
    })
}

/// Downloads a remote file to a local temp copy, opens it in an editor, and
/// re-uploads on every save. Returns an edit id (for `sftp_stop_watching`).
/// Reuses an existing watch on the same remote file.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_edit_file(
    app: AppHandle,
    session_id: String,
    remote_path: String,
    // The `externalEditor` setting, which must block until the user is done.
    // Empty uses the OS opener.
    editor_command: String,
    // Open as root. Only requested after an ordinary open was refused.
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
    // The browsing channel, not the transfer one, so saves never queue behind an
    // unrelated download. Large edits hold up browsing while opening.
    let sftp = browse_client(&ssh_state, &session_id).await?;

    // Under the OS temp dir with the original basename, so editors show the
    // right title and syntax highlighting.
    let basename = remote_path
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("remote-file");
    // A server could still return `..` or a name with a backslash (a Windows
    // separator), escaping the temp directory.
    if basename == ".." || basename.contains('\\') || is_unsafe_windows_filename(basename) {
        return Err(format!("unsafe remote filename: {basename}"));
    }
    // `session_id` comes from the webview and lands in a path, so filter it;
    // the prefix is only cosmetic.
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
    // Streamed to the temp file. After the filename checks, so an unopenable
    // file isn't downloaded first.
    let mut file = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| e.to_string())?;
    // Made even when not elevated; see `EditEntry::elevated`.
    let elevated: SharedElevation = Arc::new(Elevation::default());
    if elevate {
        // Read via sudo straight into the local file; no root-readable copy is
        // staged on the host.
        let opened = open_elevated(
            session.clone(),
            &sftp_state,
            &channel,
            &remote_path,
            Some(&mut file),
        )
        .await?;
        // Can't race: the edit isn't in the map yet.
        elevated.install(opened).await;
    } else {
        sftp.download(&remote_path, file, |_| true)
            .await
            .map_err(|e| e.to_string())?;
    }
    // Taken after the download, so "changed since" means since this read.
    // `None` on failure disables the check; see `save_edit`.
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
    // The debouncer calls back on its own OS thread; spawn onto tokio.
    let rt_handle = tokio::runtime::Handle::current();

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
                // Never forced: a save the watcher noticed must ask about conflicts.
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

    // Watch the directory, not the file, to catch editors that save by
    // delete-and-recreate or write-then-rename.
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

    // After the watch is registered, so the first save isn't missed.
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

/// Opens the local copy with the configured editor command or the OS opener.
/// Only a blocking editor command tells us when the user is finished; with the
/// OS opener the watch has to be dismissed by hand.
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
        // The OS opener dispatches by extension (see `INERT_EXTENSIONS`). Asked on
        // every open.
        if !is_inert_to_open(&basename) && !confirm_risky_open(app, &basename).await {
            return Ok(());
        }
        return app
            .opener()
            .open_path(local_path.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string());
    };

    // No extension confirmation here: a named editor opens the file rather
    // than running it, and needless prompts train users to dismiss them.
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

        // The launcher returned immediately (missing wait flag); keep the watch.
        if waited < MIN_EDITOR_LIFETIME {
            let _ = channel.send(SftpEvent::EditorExited {
                edit_id,
                remote_path,
                still_watching: true,
            });
            return;
        }

        // Let the debounced final save finish.
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

/// Writes an edit's local copy back to the host unless the remote mtime changed
/// since it was taken (`write` truncates, so a concurrent change would be lost
/// silently). Advisory, not a lock:
///
/// - SFTP v3 mtimes have one-second resolution.
/// - A server that reports no mtime disables the check.
/// - `force` skips it.
///
/// On success the expected mtime advances to what was just written.
#[allow(clippy::too_many_arguments)]
async fn save_edit(
    session: Arc<TokioMutex<Slot<wr_ssh::SshSession>>>,
    edit_id: String,
    remote_path: String,
    local_path: PathBuf,
    expected_mtime: Arc<TokioMutex<Option<i64>>>,
    // When elevated, the only way to write; SFTP would be refused.
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
            // Only a known mismatch conflicts; a deleted file is simply re-created.
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
            // SFTP writes the user's `0600` staging file, then the root helper copies
            // it into place. A failure between the two leaves the remote file intact.
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
        // Re-stat: the server's clock decides the next expected mtime.
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

/// Saves a watched edit on demand, e.g. answering a conflict prompt with
/// `force`, or retrying after a failure. The channel is passed in because
/// watches outlive the panel that started them.
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

/// Turns an open edit into a privileged one so its saves go through root (the
/// common `/etc` case: readable, but only root may write). The local copy is
/// untouched. Doesn't save; the panel calls `sftp_save_edit` so the conflict
/// check still applies. Idempotent.
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

    // Checked again under the lock: the password prompt leaves time for another
    // panel to elevate the same file.
    if elevated.is_installed() {
        return Ok(());
    }

    let session = crate::ssh::lookup(&ssh_state, &session_id).await?;
    let opened = open_elevated(session, &sftp_state, &channel, &remote_path, None).await?;

    // A returned helper lost the race; drop it outside the lock to end it.
    drop(elevated.install(opened).await);
    Ok(())
}

/// Every edit currently being watched for a session. Watches outlive the Files
/// panel, so this is the authoritative list.
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
            // Lock-free; see `Elevation`.
            elevated: e.elevated.is_installed(),
        })
        .collect())
}

/// Stops watching an edit and deletes its local temp copy, even if the editor
/// still has unsaved changes (the frontend should warn first).
#[tauri::command]
pub async fn sftp_stop_watching(
    edit_id: String,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    sftp_state.edits.lock().await.remove(&edit_id);
    Ok(())
}

/// Whether a remote path exists, so the frontend can ask before an upload
/// replaces it. Advisory; the upload re-checks.
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

/// Refuses to rename or delete a path an edit is watching: the watch's next
/// save would silently recreate the old name.
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

/// Where a rename lands: the source's own parent plus a validated bare name,
/// so a rename can never become a move.
fn rename_target(path: &str, new_name: &str) -> Result<String, String> {
    if !is_usable_remote_name(new_name) {
        return Err(format!("{new_name} is not a usable file name"));
    }
    // A relative path has no parent; refuse rather than rename into `/`.
    let (parent, _) = path
        .rsplit_once('/')
        .ok_or_else(|| format!("{path} has no directory to rename within"))?;
    Ok(format!("{parent}/{new_name}"))
}

/// Renames a remote entry within its own directory; see `rename_target`.
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
    // SFTP v3 rename doesn't replace, and servers often just say "failure";
    // check first for a clear message.
    if sftp.try_exists(&target).await.map_err(|e| e.to_string())? {
        return Err(format!("{new_name} already exists here."));
    }
    sftp.rename(&path, &target)
        .await
        .map_err(|e| e.to_string())?;
    Ok(target)
}

/// Deletes a remote file or directory, deciding which by `stat` rather than
/// trusting a possibly stale listing. Without `recursive`, a non-empty
/// directory is refused by the server.
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

    // Planned first, so the count the user confirmed is what gets deleted and an
    // oversized tree is refused up front. The walk skips symlinks, so a link to
    // `/etc` is unlinked rather than followed.
    let plan = plan_remote_tree(&sftp, &path).await?;
    for file in &plan.files {
        let victim = format!("{path}/{}", file.relative);
        sftp.remove_file(&victim)
            .await
            .map_err(|e| format!("could not delete {victim}: {e}"))?;
    }
    // Children before parents.
    for dir in plan.dirs.iter().rev() {
        let victim = format!("{path}/{dir}");
        remove_dir_with_links(&sftp, &victim).await?;
    }
    remove_dir_with_links(&sftp, &path).await
}

/// `rmdir`, after unlinking any symlinks the walk skipped.
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

/// How much a recursive delete would remove, for the confirmation dialog.
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

/// Sets the permission bits on a remote path. Values outside the permission
/// bits are refused rather than masked.
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
    // As with rename, check first for a clear message.
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

/// How many entries a recursive transfer accepts before refusing; a guard
/// against an accidental or unexpectedly huge folder.
const MAX_TREE_ENTRIES: usize = 20_000;

/// One file in a planned recursive transfer, named relative to the root.
struct PlannedFile {
    /// Always `/`-separated, whichever side it came from.
    relative: String,
    size: u64,
    /// Unix seconds, if reported; see `is_already_there`.
    modified: Option<i64>,
}

/// A local timestamp as Unix seconds. Pre-epoch gives `None` (unknown).
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

/// Whether the destination copy can be left alone when resuming: sizes match
/// and, where both report one, the destination's mtime is at least the
/// source's (catching same-size edits). Not proof the files are identical.
/// Without mtimes it falls back to size alone, and the caller reports the
/// skip count.
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

/// A failed file transfer, and whether retrying could help (classified by
/// `SftpError::is_transient` where the error is understood).
struct TransferFailure {
    message: String,
    transient: bool,
}

impl TransferFailure {
    /// Local failures don't clear on their own; the Retry button covers fixes.
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

/// Attempts per file. Small, since `is_transient` only claims protocol-level
/// timing errors.
const TRANSFER_ATTEMPTS: u32 = 3;

/// First backoff step; doubles each retry (200, 400 ms).
const TRANSFER_BACKOFF: Duration = Duration::from_millis(200);

/// Runs one file's transfer, retrying transient failures from scratch (the
/// part file is recreated). Doesn't cover a dropped connection: the session
/// would hand back the same dead client. Resume and the Retry button handle
/// that.
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

/// A recursive transfer planned up front, giving a progress total and a
/// chance to refuse before anything is created.
#[derive(Default)]
struct TreePlan {
    /// Relative directory paths, parents before children.
    dirs: Vec<String>,
    files: Vec<PlannedFile>,
    total_bytes: u64,
    /// Symlinks skipped, reported to the user.
    skipped_links: usize,
}

impl TreePlan {
    fn is_oversized(&self) -> bool {
        self.dirs.len() + self.files.len() > MAX_TREE_ENTRIES
    }

    /// Parents before children (lexicographic order on `/` paths does this).
    fn sorted(mut self) -> Self {
        self.dirs.sort();
        self.files.sort_by(|a, b| a.relative.cmp(&b.relative));
        self
    }
}

/// Walks a remote directory tree. Symlinks are skipped and counted, not
/// followed (cycles, `/`) or recreated (their targets only mean something on
/// the host).
async fn plan_remote_tree(sftp: &wr_sftp::SftpClient, root: &str) -> Result<TreePlan, String> {
    let mut plan = TreePlan::default();
    // Order is imposed by `sorted`.
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

/// Folds one directory listing into the plan. Split out so the name check,
/// the trust boundary for downloads, can be tested without a server.
fn absorb_listing(
    plan: &mut TreePlan,
    rel: &str,
    dir: &str,
    root: &str,
    entries: Vec<wr_sftp::RemoteEntry>,
    pending: &mut Vec<String>,
) -> Result<(), String> {
    for entry in entries {
        // Remote names are joined onto a local path, and `PathBuf::join` neither
        // normalizes nor refuses: `..` climbs, an absolute name replaces the base,
        // and on Windows `C:evil.dll` is drive-relative. Check POSIX and Windows
        // rules both, and refuse the whole job on a bad name.
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
        // Before `is_dir`, which is true for a link to a directory.
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

/// Walks a local directory tree for an upload. Symlinks (including Windows
/// junctions, detected via `symlink_metadata`) are skipped.
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
            // Catch names the POSIX side can't take before transferring anything.
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

/// A file arriving from the webview chunk by chunk, as an `AsyncRead`. The
/// bytes come over IPC because Tauri's drag-drop is off (it breaks HTML5 tab
/// dragging on WebView2), so a dropped `File` has no path. The bounded channel
/// provides backpressure.
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
        // Loop so an empty chunk can't read as end-of-file.
        while self.pos >= self.current.len() {
            match self.rx.poll_recv(cx) {
                Poll::Ready(Some(chunk)) => {
                    self.current = chunk;
                    self.pos = 0;
                }
                // Every sender dropped: finished or canceled.
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

/// `root` joined with a plan's `/`-separated relative path, refused unless every
/// component is a plain name. A backstop for the planning-time checks:
/// `PathBuf::join` replaces the base for a root or drive prefix (`C:x`) and
/// keeps `..`.
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

/// Whether a name can be joined onto a remote directory without acting
/// elsewhere: no separators, `.`, `..` or NUL. Used for upload names, rename
/// targets and new directories. Narrower than the Windows checks, which guard
/// remote names written to local disk.
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
    /// The chunk sender for a webview-fed upload; dropping it ends the file, so
    /// finishing and canceling both remove the entry (cancel also sets the flag).
    /// `None` for transfers the backend reads itself.
    tx: Option<mpsc::Sender<Vec<u8>>>,
    cancel: Arc<AtomicBool>,
    /// The session carrying it, so a reconnect finds its own transfers.
    session_id: String,
    /// How to run this transfer again, if it can be; see [`RestartSpec`].
    restart: Option<RestartSpec>,
    /// Kept so a restart reports on the same channel and row.
    channel: Channel<SftpEvent>,
}

/// A transfer waiting for its session to come back.
struct InterruptedTransfer {
    session_id: String,
    spec: RestartSpec,
    channel: Channel<SftpEvent>,
}

/// The arguments to run a transfer again, always with `resume: true`. The
/// command body re-resolves its SFTP client, whose `OnceCell` is reset on
/// disconnect, so a restart uses the new connection.
#[derive(Clone)]
enum RestartSpec {
    /// A file or a folder; the command stats the path to decide.
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

/// Chunks queued ahead of the network: enough to cover one round trip.
const CHUNK_QUEUE: usize = 4;

/// Starts an upload and returns its transfer id. Data goes to
/// `<name>.wrustty-part` and is renamed into place only on success, so a failed
/// or canceled upload leaves the destination untouched. SFTP v3 rename won't
/// overwrite, so replacing is remove-then-rename.
// Tauri command arguments are the wire format.
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
            // Can't be re-run: the bytes come from a webview `File` with no path.
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

/// Uploads a file picked in a dialog, streaming it straight off local disk (a
/// picker provides a path, unlike a drop). Same staging and cancellation as
/// `sftp_upload_begin`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sftp_upload_path(
    app: AppHandle,
    session_id: String,
    remote_dir: String,
    local_path: String,
    overwrite: bool,
    // See `sftp_download_begin`; only meaningful for a folder.
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

/// The body of [`sftp_upload_path`]; see [`begin_download`] for `existing_id`.
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

    // Walk a directory before creating anything remotely.
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

    // Open the local file before touching the remote side.
    let file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("could not open {local_path}: {e}"))?;
    let total = file.metadata().await.map(|m| m.len()).unwrap_or(0);

    let (sftp, remote_path, part_path, exists) =
        prepare_upload(ssh_state, &session_id, &remote_dir, &name, overwrite).await?;

    let transfer_id = existing_id.unwrap_or_else(|| sftp_state.next_transfer_id());
    let cancel = Arc::new(AtomicBool::new(false));
    // No chunk sender: the bytes are read here.
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

/// Registers and launches a recursive upload. A folder merges into whatever
/// exists, so there's no overwrite question or part file of its own.
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
            // Re-running walks the local tree again rather than replaying this plan.
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

/// Validates an upload before a byte moves. Returns the client, destination,
/// part path, and whether something is being replaced.
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
    // Remote paths are POSIX.
    let dir = remote_dir.trim_end_matches('/');
    let remote_path = format!("{dir}/{name}");
    let part_path = format!("{remote_path}{PART_SUFFIX}");

    let sftp = transfer_client(ssh_state, session_id).await?;

    // Re-checked rather than trusting the frontend's earlier `exists`.
    let exists = sftp
        .try_exists(&remote_path)
        .await
        .map_err(|e| e.to_string())?;
    if exists && !overwrite {
        return Err(format!("{remote_path} already exists"));
    }
    Ok((sftp, remote_path, part_path, exists))
}

/// Drives one upload to its end and reports the outcome. Generic over the
/// source: a `ChunkReader` for a drop, or a `tokio::fs::File` for a picked file.
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

    // A cancel can arrive as `Complete` (dropping the sender looks like EOF);
    // the flag tells them apart.
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
                    // Don't leave the part file behind.
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

    // Covers transfers that ended on their own, so ids aren't held forever.
    app.state::<SftpState>()
        .transfers
        .lock()
        .await
        .remove(&transfer_id);
}

/// One chunk of an upload, as the request's raw body (a JSON array of numbers
/// would be ~4x the size). The transfer id is in a header.
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

    // Release the map lock before a send that may block on a full queue.
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

/// Asks a running transfer to stop, in either direction. Sets the flag before
/// dropping the entry so the task can tell cancel from end-of-file. Takes
/// effect between chunks.
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

/// The staging path for a download, beside its destination (a cross-filesystem
/// rename degrades to a copy). Also validates the name, which likely came from
/// the remote host via the save dialog's suggestion: a download named `NUL`
/// would otherwise "succeed" into the null device.
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

/// Downloads a remote file to a local path the user chose, streaming straight
/// to disk (no IPC). Staged under `<name>.wrustty-part` and renamed into place
/// on success, so an interrupted download keeps the previous copy.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sftp_download_begin(
    app: AppHandle,
    session_id: String,
    remote_path: String,
    local_path: String,
    // Skip destination files that already look copied (the Retry button).
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

/// The body of [`sftp_download_begin`]. `existing_id` reuses a transfer id when
/// restarting after a reconnect, so the frontend's row continues.
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
    // Validate the destination name before creating anything.
    part_path_for(&local)?;

    let sftp = transfer_client(ssh_state, &session_id).await?;

    // Stat first, so a missing path fails with no local debris.
    let stat = sftp
        .stat(&remote_path)
        .await
        .map_err(|e| format!("could not read {remote_path}: {e}"))?;

    // Walk a folder first, for the total and a chance to refuse.
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

    // Sent now so the progress bar knows its total from the start.
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

/// Streams one remote file to one local path, staged and renamed. Used by both
/// single-file and folder downloads. `progress` gets this file's byte count.
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
            // Sync before the rename, or a crash could leave a truncated file in place.
            match file.sync_all().await {
                Ok(()) => {
                    // Windows won't rename a file with an open handle.
                    drop(file);
                    let (from, to) = (part.clone(), local.to_path_buf());
                    // `replace_atomic` may sleep through retries; keep it off the runtime.
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

    // Remove the part file on any failure (on success it was renamed away).
    if !matches!(placed, Ok(wr_sftp::Transferred::Complete)) {
        let _ = tokio::fs::remove_file(&part).await;
    }
    placed
}

/// Puts a finished `.wrustty-part` into place on the host (remove-then-rename,
/// since SFTP v3 rename won't overwrite).
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

/// Streams one local file to one remote path, staged and renamed; the mirror of
/// `download_one`.
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
    // Retries, but no resume: staging means there's never half a file to resume.
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

    // A cancel after the last chunk arrives as `Complete`; check the flag.
    let cancelled = cancel.load(Ordering::Relaxed);
    finish_transfer(&app, &channel, transfer_id, remote_path, outcome, cancelled).await;
}

/// Copies a whole remote directory down, file by file. Each file is staged and
/// renamed, but the tree isn't atomic: a job that stops leaves finished files,
/// which resume skips.
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
        // Every directory first, including empty ones.
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
                    // Counts toward progress: the bar measures the whole job.
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
                        // The job's running total.
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
            // The planned size, so a file that grew can't overshoot the total.
            base += file.size;
        }
        Ok(wr_sftp::Transferred::Complete)
    }
    .await;

    note_what_was_skipped(&channel, &transfer_id, plan.skipped_links, skipped);

    let cancelled = cancel.load(Ordering::Relaxed);
    finish_transfer(&app, &channel, transfer_id, remote_root, outcome, cancelled).await;
}

/// Reports what a recursive transfer skipped (links, and files resume judged
/// up to date), so a copy that looks complete doesn't hide missing entries.
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
        // Existing directories are fine; only failing to create a missing one isn't.
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

/// Turns a transfer's ending into an event and releases its id. `cancelled`
/// comes from the flag because a late cancel arrives as `Complete`.
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

    // Covers transfers that ended on their own, so ids aren't held forever.
    app.state::<SftpState>()
        .transfers
        .lock()
        .await
        .remove(&transfer_id);
}

/// Removes every edit watch tied to a disconnected session (from
/// `ssh::ssh_disconnect`).
pub(crate) async fn stop_watching_session(sftp_state: &SftpState, session_id: &str) {
    // Dropping each `EditEntry` stops its watcher and deletes its temp dir.
    sftp_state
        .edits
        .lock()
        .await
        .retain(|_, e| e.session_id != session_id);
}

/// Sets aside transfers a dropped connection killed, so the reconnect can
/// restart them. Copies rather than moves, since the transfer's own task is
/// concurrently failing and removing its entry. Chunk-fed uploads can't be
/// restarted and are reported as failed.
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

/// Restarts transfers waiting on this session against the new connection, with
/// `resume: true` and the same ids. One at a time, since they share a channel.
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
        // Fresh per iteration so the `State` borrows don't span the loop.
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
            // Only once the restart owns the row.
            let _ = t.channel.send(SftpEvent::TransferResumed {
                transfer_id: transfer_id.clone(),
            });
        }

        if let Err(error) = outcome {
            // Nothing else will report this. Likely causes after a reconnect: a moved
            // remote path or an unwritable local one.
            let _ = t.channel.send(SftpEvent::TransferFailed {
                transfer_id: transfer_id.clone(),
                remote_path: String::new(),
                error: format!("could not resume after reconnecting: {error}"),
            });
        }
    }
}

/// Forgets a session's waiting transfers when its pane goes away.
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

    /// The wire names of the reconnect events. Nothing compiles against both the
    /// enum and the frontend's string literals, so a mismatch is silent (as it
    /// once was for port forwarding; see `ForwardSpec`'s contract test in wr-ssh).
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

    /// A resumed transfer keeps its id so the panel's existing row continues.
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

    /// A remote file called `NUL` would otherwise be written to the null device.
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
            // A reserved stem stays reserved whatever follows it.
            "nul.d.ts",
            "notes.txt:payload",
            "report.txt ",
            "report.txt.",
            // Legal remotely, refused by Windows; caught for a clearer message.
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

    /// A false positive would make a file impossible to open.
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

    /// `.js` and `.py` are editable text but execute on double-click on Windows.
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
            // Edge is the Windows default handler, and SVG can carry <script>.
            "logo.svg",
        ] {
            assert!(
                !is_inert_to_open(name),
                "{name} should require confirmation"
            );
        }
    }

    /// The OS dispatches on the last extension.
    #[test]
    fn double_extension_is_judged_by_the_last_one() {
        assert!(!is_inert_to_open("invoice.txt.exe"));
        assert!(is_inert_to_open("archive.tar.md"));
    }

    /// A dropped name must not climb out of the target directory.
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

    /// The download walk's trust boundary: server-chosen names become relative
    /// paths joined onto the user's local directory. No plan carrying a bad one may
    /// be built.
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
            // Drive-relative: `join` drops the base.
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
        // Directory entries are refused on the same terms.
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

    /// The backstop at the point of use.
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
            // `C:x` is only a prefix on Windows.
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

    /// The guard must not stop an ordinary listing.
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

    /// The part file is a sibling, so the final rename is never cross-filesystem.
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

    /// The save dialog suggests the remote name, so a hostile one reaches here.
    #[test]
    fn a_download_refuses_a_local_name_that_is_not_a_file() {
        for name in ["NUL", "nul.txt", "COM1", "report.txt.", "notes.txt:stream"] {
            assert!(
                part_path_for(&PathBuf::from("/tmp").join(name)).is_err(),
                "{name} should be refused before anything is created"
            );
        }
    }

    /// A false positive would make a download impossible to save.
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
        // A file directly under the root has `/` as its parent.
        assert_eq!(rename_target("/passwd", "shadow").unwrap(), "/shadow");
    }

    /// "Rename" must never be a move.
    #[test]
    fn a_rename_cannot_climb_out_of_its_directory() {
        for name in ["../passwd", "/etc/passwd", "a/b", "a\\b", "..", ".", ""] {
            assert!(
                rename_target("/home/dev/notes.txt", name).is_err(),
                "{name:?} should be refused as a new name"
            );
        }
    }

    /// Rooting a relative path would rename into `/`.
    #[test]
    fn a_rename_refuses_a_path_with_no_directory() {
        assert!(rename_target("notes.txt", "other.txt").is_err());
    }

    /// Directory creation needs parents first, and recursive delete walks the
    /// list backwards.
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

        // Reversed, every directory follows its contents.
        for (i, dir) in plan.dirs.iter().enumerate() {
            for child in &plan.dirs[i + 1..] {
                assert!(
                    !dir.starts_with(&format!("{child}/")),
                    "{child} must not sort before its child {dir}"
                );
            }
        }
    }

    /// The cap counts directories as well as files.
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

    /// The common case on Windows.
    #[test]
    fn an_editor_command_keeps_a_windows_path_intact() {
        let (program, args) = parse_editor_command(
            r#""C:\Program Files\Microsoft VS Code\Code.exe" --wait"#,
            Path::new(r"C:\Temp\notes.txt"),
        )
        .unwrap();
        // Backslashes are not escapes.
        assert_eq!(program, r"C:\Program Files\Microsoft VS Code\Code.exe");
        assert_eq!(args, ["--wait", r"C:\Temp\notes.txt"]);
    }

    #[test]
    fn an_editor_command_appends_the_path_when_there_is_no_placeholder() {
        let (program, args) = parse_editor_command("code --wait", Path::new("/tmp/a.txt")).unwrap();
        assert_eq!(program, "code");
        assert_eq!(args, ["--wait", "/tmp/a.txt"]);
    }

    /// For editors that won't take the file last.
    #[test]
    fn an_editor_command_substitutes_the_placeholder_in_place() {
        let (program, args) =
            parse_editor_command("gvim -f {file} +1", Path::new("/tmp/a.txt")).unwrap();
        assert_eq!(program, "gvim");
        assert_eq!(args, ["-f", "/tmp/a.txt", "+1"]);

        // Anywhere in an argument.
        let (_, args) = parse_editor_command("ed --file={file}", Path::new("/tmp/a.txt")).unwrap();
        assert_eq!(args, ["--file=/tmp/a.txt"]);
    }

    /// Quoting keeps a spaced path as one argument.
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

    /// The second run of a transfer that died partway.
    #[test]
    fn a_file_already_copied_is_left_alone() {
        assert!(is_already_there(
            &facts(1024, Some(100)),
            Some(&facts(1024, Some(100)))
        ));
        // Downloading sets the local mtime to now, so a newer destination is normal.
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

    /// A one-character config edit keeps the size; the mtime catches it.
    #[test]
    fn a_newer_source_of_the_same_size_is_copied_again() {
        assert!(!is_already_there(
            &facts(1024, Some(900)),
            Some(&facts(1024, Some(100)))
        ));
    }

    /// Some servers report no mtime; fall back to size alone.
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

    /// Zero-length on both sides is a match.
    #[test]
    fn an_empty_file_counts_as_already_there() {
        assert!(is_already_there(
            &facts(0, Some(5)),
            Some(&facts(0, Some(5)))
        ));
    }

    /// An empty chunk must not read as end-of-file and truncate the upload.
    #[tokio::test]
    async fn chunk_reader_reassembles_the_stream() {
        use tokio::io::AsyncReadExt;

        let (tx, rx) = mpsc::channel::<Vec<u8>>(4);
        tokio::spawn(async move {
            tx.send(b"hello ".to_vec()).await.unwrap();
            tx.send(Vec::new()).await.unwrap();
            tx.send(b"world".to_vec()).await.unwrap();
            // Dropping the sender ends the file.
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

    /// A zero-byte upload ends cleanly.
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
        // uid 0 ignores mode bits.
        let id = parse_id_output("uid=0(root) gid=0(root) groups=0(root)");
        assert_eq!(id.uid, Some(0));
    }

    #[test]
    fn keeps_a_primary_group_that_is_not_in_the_list() {
        // Only `gid=` is guaranteed to carry the primary group.
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
        // Numeric-only output for a uid with no name.
        let id = parse_id_output("uid=1000 gid=1000 groups=1000");
        assert_eq!(id.uid, Some(1000));
        assert_eq!(id.gids, vec![1000]);
        assert_eq!(id.user, None);
    }

    #[test]
    fn an_unparseable_reply_predicts_nothing() {
        // Unparseable output means "don't guess".
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
