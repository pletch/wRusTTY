//! Elevated tabs anywhere but Windows: the same commands and entry point as
//! `elevation.rs`, answering that there is nothing to elevate.
//!
//! The elevated host and its connector are Windows-only (`wr_local::elevated`
//! compiles them only there), so the real module cannot build elsewhere. This
//! keeps the command list in `lib.rs` identical on every platform, which is what
//! lets the Linux CI job check the rest of the app. The frontend only offers
//! the checkbox for shells Windows detection finds, so nothing reaches these in
//! practice.

use tauri::ipc::Channel;
use tauri::State;

use crate::local::LocalEvent;

const UNSUPPORTED: &str = "running a shell as administrator is only available on Windows";

// A field rather than a unit struct, so `lib.rs` can construct it with
// `default()` the same way on every platform.
#[derive(Default)]
pub struct ElevatedState {
    _unsupported: (),
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn elevated_connect(
    shell_id: String,
    channel: Channel<LocalEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    cols: u16,
    rows: u16,
    state: State<'_, ElevatedState>,
) -> Result<String, String> {
    let _ = (shell_id, channel, data_channel, cols, rows, state);
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn elevated_write(session_id: String, data: Vec<u8>) -> Result<(), String> {
    let _ = (session_id, data);
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn elevated_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let _ = (session_id, cols, rows);
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn elevated_disconnect(session_id: String) -> Result<(), String> {
    let _ = session_id;
    Ok(())
}

/// No elevated modes exist here, so every launch is an ordinary one.
pub fn elevated_entry_point() -> Option<i32> {
    None
}
