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
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
pub struct LoggingState {
    // A std (not tokio) mutex: `write` is called from the coalescer's flush
    // path, which is synchronous, and the critical section is one file
    // write — nothing awaits while holding it.
    files: Mutex<HashMap<String, LogSink>>,
}

/// One open log file plus, for plain-text logs, the streaming filter that
/// strips escape sequences from what's written to it. `None` filter = raw
/// mode (bytes written verbatim, PuTTY "all session output" style).
struct LogSink {
    file: std::fs::File,
    filter: Option<LogFilter>,
}

/// Appends `bytes` to `session_id`'s log file, if logging is active for
/// that session (silently a no-op otherwise). Called by the coalescer on
/// every flush. In raw mode the bytes are logged exactly as sent to the UI;
/// in plain-text mode they're run through the escape-stripping filter first
/// (the terminal still renders the untouched raw stream regardless).
pub(crate) fn write(state: &LoggingState, session_id: &str, bytes: &[u8]) {
    let mut files = state.files.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(sink) = files.get_mut(session_id) {
        let result = if let Some(filter) = sink.filter.as_mut() {
            let mut cleaned = Vec::with_capacity(bytes.len());
            filter.push(bytes, &mut cleaned);
            sink.file.write_all(&cleaned)
        } else {
            sink.file.write_all(bytes)
        };
        if let Err(e) = result {
            log::warn!("session log write failed for {session_id}: {e}");
        }
    }
}

/// Streaming filter that removes terminal escape sequences (CSI, OSC and the
/// other string sequences, and short ESC sequences) plus non-printable
/// control bytes, leaving human-readable text (tab/newline/carriage-return
/// are kept). Stateful on purpose: PTY output is chunked at arbitrary
/// boundaries, so a sequence can be split across two `push` calls and the
/// mid-sequence position has to survive between them.
#[derive(Default)]
struct LogFilter {
    state: FilterState,
}

#[derive(Default, Clone, Copy)]
enum FilterState {
    #[default]
    Ground,
    Escape,    // just saw ESC (0x1B)
    Csi,       // inside ESC [ … , until a final byte 0x40–0x7E
    EscInter,  // ESC + intermediate (e.g. charset select ESC ( … ), until final
    StringSeq, // OSC/DCS/PM/APC/SOS body, until BEL or ST
    StringEsc, // saw ESC inside a string sequence (expecting \ to form ST)
}

impl LogFilter {
    fn push(&mut self, input: &[u8], out: &mut Vec<u8>) {
        for &b in input {
            self.state = match self.state {
                FilterState::Ground => match b {
                    0x1B => FilterState::Escape,
                    b'\n' | b'\r' | b'\t' => {
                        out.push(b);
                        FilterState::Ground
                    }
                    // Drop other C0 controls and DEL; keep everything else,
                    // including UTF-8 bytes (>= 0x80), verbatim.
                    0x00..=0x1F | 0x7F => FilterState::Ground,
                    _ => {
                        out.push(b);
                        FilterState::Ground
                    }
                },
                FilterState::Escape => match b {
                    b'[' => FilterState::Csi,
                    b']' | b'P' | b'X' | b'^' | b'_' => FilterState::StringSeq,
                    0x20..=0x2F => FilterState::EscInter,
                    _ => FilterState::Ground, // 2-byte escape, consumed
                },
                FilterState::Csi => match b {
                    0x40..=0x7E => FilterState::Ground, // final byte ends the CSI
                    _ => FilterState::Csi,
                },
                FilterState::EscInter => match b {
                    0x30..=0x7E => FilterState::Ground,
                    _ => FilterState::EscInter,
                },
                FilterState::StringSeq => match b {
                    0x07 => FilterState::Ground, // BEL terminates
                    0x1B => FilterState::StringEsc,
                    _ => FilterState::StringSeq,
                },
                // The \ of an ST (ESC \) — or a malformed lone ESC; either way
                // the string sequence is over.
                FilterState::StringEsc => FilterState::Ground,
            };
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

/// Opens a file only its owner can read.
///
/// The mode goes on the open rather than on the created file: `create` then
/// `set_permissions` leaves a window, however brief, in which the file exists
/// at the default umask and another local user can open it. Once they hold the
/// descriptor, tightening the mode afterwards doesn't take it back. No-op on
/// Windows, where the per-user %APPDATA% ACL already covers this.
fn create_private(path: &std::path::Path) -> Result<std::fs::File, String> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path).map_err(|e| e.to_string())
}

/// Records a resize in the session log, if one is running.
///
/// A raw log is replayed to rebuild the grid it produced, and a replay needs
/// the width: the same bytes wrapped at 80 columns and at 66 are different
/// screens, so a log that never says which is not replayable at all. A resize
/// is also a suspect in its own right -- it reflows every wrapped line in the
/// buffer -- which makes when one landed worth as much as what it changed to.
///
/// Written as an APC string (ESC _ ... ESC \), the envelope terminals are
/// required to ignore. That is what keeps the log replayable: feeding it back
/// renders exactly what the session rendered, marker included, because the
/// marker draws nothing. `LogFilter` treats APC as a string sequence, so
/// plain-text logs drop it without knowing it exists.
///
/// Deliberately not `ESC _ G`: that prefix is the Kitty graphics protocol, and
/// a terminal implementing it would try to decode this.
pub(crate) fn note_resize(state: &LoggingState, session_id: &str, cols: u16, rows: u16) {
    let marker = format!("\x1b_wrustty;resize;{cols}x{rows};{}\x1b\\", timestamp());
    write(state, session_id, marker.as_bytes());
}

/// Starts logging for `session_id`, returning the path of the created file.
#[tauri::command]
pub async fn session_log_start(
    app: AppHandle,
    session_id: String,
    label: String,
    plain_text: bool,
    state: State<'_, LoggingState>,
) -> Result<String, String> {
    let dir = logs_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}-{}.log", sanitize(&label), timestamp()));
    // Session logs can contain anything typed or displayed in the terminal —
    // restrict to the owner, same as the vault and known_hosts files. No-op
    // on Windows, where the per-user %APPDATA% ACL already covers this.
    //
    // The mode goes on the open rather than on the created file: `create`
    // then `set_permissions` leaves a window, however brief, in which the
    // transcript exists at the default umask and another local user can open
    // it. Once they hold the descriptor, tightening the mode afterwards
    // doesn't take it back.
    let file = create_private(&path)?;
    let sink = LogSink {
        file,
        filter: plain_text.then(LogFilter::default),
    };
    state
        .files
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(session_id, sink);
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

/// Opens the session-logs folder in the OS file manager. Creates it first so
/// the action still works before anything has been logged this run (the dir
/// is only otherwise created lazily on the first `session_log_start`).
/// Writes a pane dump beside the session logs, returning its path.
///
/// The contents are built in the webview (`GhosttyEngine.dumpState`) because
/// that is where the grid lives; this end owns only where such a file may go
/// and who may read it, and that answer is the same as for a transcript --
/// the logs directory, owner-only. A dump holds whatever was on screen, so it
/// is exactly as sensitive as the log it sits beside.
///
/// Timestamped rather than overwritten. The fault this exists for is
/// intermittent, so a second dump is a second sample and not a correction of
/// the first; a fixed filename would quietly destroy the only copy of a state
/// nobody can reproduce.
#[tauri::command]
pub async fn write_pane_dump(
    app: AppHandle,
    label: String,
    contents: String,
) -> Result<String, String> {
    let dir = logs_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}-pane-{}.txt", sanitize(&label), timestamp()));
    let mut file = create_private(&path)?;
    file.write_all(contents.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn reveal_session_logs(app: AppHandle) -> Result<(), String> {
    let dir = logs_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filtered(chunks: &[&[u8]]) -> String {
        let mut filter = LogFilter::default();
        let mut out = Vec::new();
        for chunk in chunks {
            filter.push(chunk, &mut out);
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn strips_csi_color_and_keeps_text() {
        // A colored prompt then some output: "\x1b[31mERR\x1b[0m ok\r\n"
        assert_eq!(filtered(&[b"\x1b[31mERR\x1b[0m ok\r\n"]), "ERR ok\r\n");
    }

    #[test]
    fn strips_osc_title_sequence() {
        // OSC 0 ; title BEL — a window-title set, common in shell prompts.
        assert_eq!(filtered(&[b"\x1b]0;my-host\x07$ "]), "$ ");
    }

    #[test]
    fn strips_osc_terminated_by_st() {
        // Same, but terminated by ST (ESC \) instead of BEL.
        assert_eq!(filtered(&[b"\x1b]0;t\x1b\\done"]), "done");
    }

    #[test]
    fn handles_sequence_split_across_writes() {
        // The whole point of the state machine: a CSI split mid-sequence
        // across two pushes must still be fully stripped.
        assert_eq!(filtered(&[b"a\x1b[3", b"1mb"]), "ab");
        // ESC alone at a boundary, its bracket and body in the next chunk.
        assert_eq!(filtered(&[b"x\x1b", b"[0mY"]), "xY");
    }

    #[test]
    fn drops_control_bytes_but_keeps_tab_newline() {
        assert_eq!(filtered(&[b"a\x07\x08b\tc\n"]), "ab\tc\n");
    }

    #[test]
    fn strips_charset_designation_escape() {
        // ESC ( B — select US-ASCII charset (intermediate + final).
        assert_eq!(filtered(&[b"\x1b(Bhi"]), "hi");
    }
}
