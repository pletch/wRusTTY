//! Tauri command layer for serial sessions — same push-`Channel` shape as
//! `ssh.rs`/`telnet.rs`, plus port enumeration and line control (DTR, RTS,
//! break), which have no equivalent in the other transports.
//!
//! The session map, id counter and write/resize/disconnect bodies live in
//! `session_registry.rs`. The line-control commands below don't go through it:
//! they aren't part of `wr_core::Session` and nothing generic could say
//! anything useful about them, so they look the session up and call it
//! directly.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use wr_serial::{PortInfo, SerialConfig, SerialConnector};

use crate::connection_status::status_label;
use crate::session_registry::SessionRegistry;

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SerialEvent {
    // PTY output travels on its own raw-bytes Channel<InvokeResponseBody>
    // instead (see coalesce.rs).
    Status { status: String },
}

pub struct SerialState {
    sessions: SessionRegistry<SerialConnector>,
}

impl Default for SerialState {
    fn default() -> Self {
        Self {
            sessions: SessionRegistry::new("serial"),
        }
    }
}

#[tauri::command]
pub fn serial_list_ports() -> Result<Vec<PortInfo>, String> {
    wr_serial::list_ports().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn serial_connect(
    app: AppHandle,
    config: SerialConfig,
    channel: Channel<SerialEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    state: State<'_, SerialState>,
) -> Result<String, String> {
    let session_id = state.sessions.next_session_id();
    state
        .sessions
        .spawn_connect(
            app,
            session_id.clone(),
            SerialConnector::new(config),
            channel,
            data_channel,
            |status| SerialEvent::Status {
                status: status_label(status),
            },
        )
        .await;
    Ok(session_id)
}

/// Connects a saved serial profile, resolving its adapter to whatever COM
/// number it holds right now.
///
/// The resolution is the point of the whole thing: the profile stores the
/// adapter's USB identity, not a COM number, so "the switch in rack 3" keeps
/// working after the cable is moved to a different socket or the machine is
/// rebooted. See `wr_serial::resolve` for the matching rules.
#[tauri::command]
pub async fn serial_connect_profile(
    app: AppHandle,
    profile_id: String,
    channel: Channel<SerialEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    state: State<'_, SerialState>,
) -> Result<String, String> {
    let profile = crate::profiles::get_profile(&app, &profile_id)?;
    let serial = profile
        .serial
        .ok_or_else(|| format!("session profile {profile_id} is not a serial session"))?;

    let available = wr_serial::list_ports().map_err(|e| e.to_string())?;
    let port_name = match wr_serial::resolve(&serial.identity, &available) {
        wr_serial::Resolved::Port(name) => name,
        // Worded for the person holding the cable. "No such port COM4" would
        // send them looking for the wrong thing — the port number is exactly
        // what stopped being meaningful.
        wr_serial::Resolved::NotFound => {
            return Err(format!(
                "{} isn't connected — plug the adapter in, or edit the session \
                 to pick a different one",
                describe_identity(&serial.identity)
            ))
        }
        // Never guessed. Picking one of several identical adapters means a
        // console session on the wrong device, which is worse than an error.
        wr_serial::Resolved::Ambiguous(candidates) => {
            return Err(format!(
                "several identical adapters match this session ({}) — edit it to pick one",
                candidates.join(", ")
            ))
        }
    };

    let session_id = state.sessions.next_session_id();
    state
        .sessions
        .spawn_connect(
            app,
            session_id.clone(),
            SerialConnector::new(serial.to_config(port_name)),
            channel,
            data_channel,
            |status| SerialEvent::Status {
                status: status_label(status),
            },
        )
        .await;
    Ok(session_id)
}

/// Names an adapter the way its owner thinks of it, for an error message.
fn describe_identity(identity: &wr_serial::PortIdentity) -> String {
    match &identity.usb {
        Some(usb) => match &usb.serial_number {
            Some(serial) => format!("the adapter with serial {serial}"),
            None => format!(
                "the USB adapter {:04x}:{:04x} last seen on {}",
                usb.vid, usb.pid, identity.port_name
            ),
        },
        None => identity.port_name.clone(),
    }
}

#[tauri::command]
pub async fn serial_write(
    session_id: String,
    data: Vec<u8>,
    state: State<'_, SerialState>,
) -> Result<(), String> {
    state.sessions.write(&session_id, &data).await
}

#[tauri::command]
pub async fn serial_set_dtr(
    session_id: String,
    level: bool,
    state: State<'_, SerialState>,
) -> Result<(), String> {
    let slot = state.sessions.lookup(&session_id).await?;
    let slot = slot.lock().await;
    slot.ready()?
        .set_dtr(level)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn serial_set_rts(
    session_id: String,
    level: bool,
    state: State<'_, SerialState>,
) -> Result<(), String> {
    let slot = state.sessions.lookup(&session_id).await?;
    let slot = slot.lock().await;
    slot.ready()?
        .set_rts(level)
        .await
        .map_err(|e| e.to_string())
}

/// Asserts a break condition — the out-of-band attention signal a serial
/// console expects for things like Cisco password recovery or dropping to a
/// bootloader. `duration_ms` is optional; omitting it uses the default hold
/// time, which suits every case anyone routinely needs.
#[tauri::command]
pub async fn serial_send_break(
    session_id: String,
    duration_ms: Option<u64>,
    state: State<'_, SerialState>,
) -> Result<(), String> {
    let duration = duration_ms
        .map(std::time::Duration::from_millis)
        .unwrap_or(wr_serial::DEFAULT_BREAK);
    let slot = state.sessions.lookup(&session_id).await?;
    let slot = slot.lock().await;
    slot.ready()?
        .send_break(duration)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn serial_disconnect(
    session_id: String,
    state: State<'_, SerialState>,
) -> Result<(), String> {
    state.sessions.disconnect(&session_id).await
}
