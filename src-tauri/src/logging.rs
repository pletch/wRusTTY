//! Per-session transcript logging: raw PTY/serial/telnet bytes written to a
//! timestamped file, like PuTTY's "log all session output". Written on the
//! Rust side of the coalescer (`coalesce.rs`), so the log stays complete even
//! if the webview stalls; the frontend only toggles it.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
pub struct LoggingState {
    // A std mutex: the coalescer's flush path is synchronous and nothing awaits
    // while holding it.
    files: Mutex<HashMap<String, LogSink>>,
}

/// One open log file plus, for plain-text logs, the escape-stripping filter.
/// No filter is raw mode (bytes verbatim).
struct LogSink {
    file: std::fs::File,
    filter: Option<LogFilter>,
}

/// Appends `bytes` to `session_id`'s log, if one is active. Called by the
/// coalescer on every flush; plain-text mode filters first.
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

/// Streaming filter that removes escape sequences (CSI, OSC and other string
/// sequences, short ESC sequences) and non-printable controls, keeping tab,
/// newline and carriage return. Stateful, since a sequence can span chunks.
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
                    // Drop other C0 controls and DEL; keep everything else (UTF-8 included).
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
                // The \ of an ST, or a malformed lone ESC: the string is over either way.
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

/// The folder chosen in Settings, or `None` for the default. Absolute paths
/// only: a relative one would resolve against the process's cwd (often
/// `System32`).
fn chosen_dir(directory: Option<&str>) -> Result<Option<PathBuf>, String> {
    match directory.map(str::trim) {
        None | Some("") => Ok(None),
        Some(dir) => {
            let path = PathBuf::from(dir);
            if path.is_absolute() {
                Ok(Some(path))
            } else {
                Err(format!(
                    "the log folder \"{dir}\" is not a full path — choose it again in Settings → Logging"
                ))
            }
        }
    }
}

/// Where transcripts go: the chosen folder, else the default under the app's
/// log directory. Created if missing.
fn transcript_dir(app: &AppHandle, directory: Option<&str>) -> Result<PathBuf, String> {
    let dir = match chosen_dir(directory)? {
        Some(dir) => dir,
        None => logs_dir(app)?,
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
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

/// Opens a file only its owner can read. The mode is set on open, since
/// `create` then `set_permissions` leaves a window in which another user can
/// grab a descriptor. No-op on Windows, where the %APPDATA% ACL covers it.
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
/// Replaying a raw log needs the width (the same bytes at 80 and 66 columns
/// are different screens), and a resize reflows the buffer, so when it landed
/// matters too. Written as an APC string (ESC _ ... ESC \), which terminals
/// ignore, so replay renders exactly what the session did and `LogFilter`
/// drops it from plain-text logs. Not `ESC _ G`, the Kitty graphics prefix.
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
    // Settings > Logging's folder; `None` or empty for the default.
    directory: Option<String>,
    state: State<'_, LoggingState>,
) -> Result<String, String> {
    let dir = transcript_dir(&app, directory.as_deref())?;
    let path = dir.join(format!("{}-{}.log", sanitize(&label), timestamp()));
    // Logs can contain anything typed or displayed: owner-only, like the vault
    // and known_hosts (see `create_private`).
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

/// Writes a pane dump beside the session logs, returning its path.
///
/// Built in the webview (`GhosttyEngine.dumpState`), where the grid lives;
/// this end decides where it goes and who may read it (owner-only, like a
/// transcript). Timestamped, since each dump of an intermittent fault is a
/// separate sample.
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

/// Opens the session-logs folder in the OS file manager, creating it first.
#[tauri::command]
pub async fn reveal_session_logs(app: AppHandle, directory: Option<String>) -> Result<(), String> {
    let dir = transcript_dir(&app, directory.as_deref())?;
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
        // A colored prompt, then output.
        assert_eq!(filtered(&[b"\x1b[31mERR\x1b[0m ok\r\n"]), "ERR ok\r\n");
    }

    #[test]
    fn strips_osc_title_sequence() {
        // OSC 0 ; title BEL: a window-title set.
        assert_eq!(filtered(&[b"\x1b]0;my-host\x07$ "]), "$ ");
    }

    #[test]
    fn strips_osc_terminated_by_st() {
        // Terminated by ST (ESC \) instead of BEL.
        assert_eq!(filtered(&[b"\x1b]0;t\x1b\\done"]), "done");
    }

    #[test]
    fn handles_sequence_split_across_writes() {
        // A CSI split mid-sequence across two pushes is still stripped.
        assert_eq!(filtered(&[b"a\x1b[3", b"1mb"]), "ab");
        // ESC alone at a boundary, its bracket and body in the next chunk.
        assert_eq!(filtered(&[b"x\x1b", b"[0mY"]), "xY");
    }

    #[test]
    fn drops_control_bytes_but_keeps_tab_newline() {
        assert_eq!(filtered(&[b"a\x07\x08b\tc\n"]), "ab\tc\n");
    }

    #[test]
    fn an_unset_or_blank_folder_means_the_default() {
        assert_eq!(chosen_dir(None).unwrap(), None);
        assert_eq!(chosen_dir(Some("")).unwrap(), None);
        assert_eq!(chosen_dir(Some("   ")).unwrap(), None);
    }

    #[test]
    fn a_chosen_folder_must_be_a_full_path() {
        assert!(chosen_dir(Some("logs")).is_err());
        assert!(chosen_dir(Some(r"..\elsewhere")).is_err());
        #[cfg(windows)]
        assert_eq!(
            chosen_dir(Some(r" D:\Transcripts ")).unwrap(),
            Some(PathBuf::from(r"D:\Transcripts"))
        );
        #[cfg(unix)]
        assert_eq!(
            chosen_dir(Some("/var/log/wrustty")).unwrap(),
            Some(PathBuf::from("/var/log/wrustty"))
        );
    }

    #[test]
    fn strips_charset_designation_escape() {
        // ESC ( B: select US-ASCII charset (intermediate + final).
        assert_eq!(filtered(&[b"\x1b(Bhi"]), "hi");
    }
}
