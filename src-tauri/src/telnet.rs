//! Tauri command layer for Telnet sessions — same push-`Channel` shape as
//! `ssh.rs`, minus the host-key prompt machinery telnet has no equivalent of.
//!
//! Everything that isn't telnet-specific lives in `session_registry.rs`; what
//! remains here is the event enum (telnet's own `Channel<E>` type) and the
//! `#[tauri::command]` entry points, which have to be concrete functions for
//! `generate_handler!`.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use wr_telnet::{TelnetConfig, TelnetConnector};

use crate::connection_status::status_label;
use crate::session_registry::SessionRegistry;

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TelnetEvent {
    // PTY output travels on its own raw-bytes Channel<InvokeResponseBody>
    // instead (see coalesce.rs).
    Status { status: String },
}

pub struct TelnetState {
    sessions: SessionRegistry<TelnetConnector>,
}

impl Default for TelnetState {
    fn default() -> Self {
        Self {
            sessions: SessionRegistry::new("telnet"),
        }
    }
}

#[tauri::command]
pub async fn telnet_connect(
    app: AppHandle,
    config: TelnetConfig,
    channel: Channel<TelnetEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    state: State<'_, TelnetState>,
) -> Result<String, String> {
    let session_id = state.sessions.next_session_id();
    state
        .sessions
        .spawn_connect(
            app,
            session_id.clone(),
            TelnetConnector::new(config),
            channel,
            data_channel,
            |status| TelnetEvent::Status {
                status: status_label(status),
            },
        )
        .await;
    Ok(session_id)
}

#[tauri::command]
pub async fn telnet_write(
    session_id: String,
    data: Vec<u8>,
    state: State<'_, TelnetState>,
) -> Result<(), String> {
    state.sessions.write(&session_id, &data).await
}

#[tauri::command]
pub async fn telnet_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, TelnetState>,
) -> Result<(), String> {
    state.sessions.resize(&session_id, cols, rows).await
}

#[tauri::command]
pub async fn telnet_disconnect(
    session_id: String,
    state: State<'_, TelnetState>,
) -> Result<(), String> {
    state.sessions.disconnect(&session_id).await
}
