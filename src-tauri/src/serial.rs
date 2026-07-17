//! Tauri command layer for serial sessions — same push-`Channel` shape as
//! `ssh.rs`/`telnet.rs`, plus port enumeration and DTR/RTS control (which
//! have no equivalent in the other transports).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex as TokioMutex;
use wr_core::{Connection, ConnectionEvent};
use wr_serial::{PortInfo, SerialConfig, SerialSession};

use crate::connection_status::status_label;

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

#[derive(Default)]
pub struct SerialState {
    sessions: TokioMutex<HashMap<String, Arc<TokioMutex<SerialSession>>>>,
    next_id: AtomicU64,
}

impl SerialState {
    fn next_session_id(&self) -> String {
        format!("serial-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
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
    let session_id = state.next_session_id();
    let session = Arc::new(TokioMutex::new(SerialSession::new(config)));

    state
        .sessions
        .lock()
        .await
        .insert(session_id.clone(), session.clone());

    let cleanup_session_id = session_id.clone();

    tokio::spawn(async move {
        let (tx, rx) = tokio::sync::mpsc::channel::<ConnectionEvent>(
            crate::coalesce::CONNECTION_EVENT_CHANNEL_BOUND,
        );

        let forward = tokio::spawn(crate::coalesce::forward_coalesced(
            rx,
            channel,
            data_channel,
            |status| SerialEvent::Status {
                status: status_label(status),
            },
        ));

        let connect_result = session.lock().await.connect(tx).await;
        if connect_result.is_err() {
            let serial_state = app.state::<SerialState>();
            serial_state
                .sessions
                .lock()
                .await
                .remove(&cleanup_session_id);
        }

        drop(forward);
    });

    Ok(session_id)
}

#[tauri::command]
pub async fn serial_write(
    session_id: String,
    data: Vec<u8>,
    state: State<'_, SerialState>,
) -> Result<(), String> {
    let session = lookup(&state, &session_id).await?;
    let mut session = session.lock().await;
    session.write(&data).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn serial_set_dtr(
    session_id: String,
    level: bool,
    state: State<'_, SerialState>,
) -> Result<(), String> {
    let session = lookup(&state, &session_id).await?;
    let session = session.lock().await;
    session.set_dtr(level).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn serial_set_rts(
    session_id: String,
    level: bool,
    state: State<'_, SerialState>,
) -> Result<(), String> {
    let session = lookup(&state, &session_id).await?;
    let session = session.lock().await;
    session.set_rts(level).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn serial_disconnect(
    session_id: String,
    state: State<'_, SerialState>,
) -> Result<(), String> {
    let session = state.sessions.lock().await.remove(&session_id);
    if let Some(session) = session {
        session
            .lock()
            .await
            .disconnect()
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn lookup(
    state: &State<'_, SerialState>,
    session_id: &str,
) -> Result<Arc<TokioMutex<SerialSession>>, String> {
    state
        .sessions
        .lock()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("no such session: {session_id}"))
}
