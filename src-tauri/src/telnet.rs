//! Tauri command layer for Telnet sessions — same push-`Channel` shape as
//! `ssh.rs`, minus the host-key prompt machinery telnet has no equivalent of.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex as TokioMutex;
use wr_core::{Connection, ConnectionEvent};
use wr_telnet::{TelnetConfig, TelnetSession};

use crate::connection_status::status_label;

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TelnetEvent {
    Data { bytes_base64: String },
    Status { status: String },
}

#[derive(Default)]
pub struct TelnetState {
    sessions: TokioMutex<HashMap<String, Arc<TokioMutex<TelnetSession>>>>,
    next_id: AtomicU64,
}

impl TelnetState {
    fn next_session_id(&self) -> String {
        format!("telnet-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }
}

#[tauri::command]
pub async fn telnet_connect(
    app: AppHandle,
    config: TelnetConfig,
    channel: Channel<TelnetEvent>,
    state: State<'_, TelnetState>,
) -> Result<String, String> {
    let session_id = state.next_session_id();
    let session = Arc::new(TokioMutex::new(TelnetSession::new(config)));

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

        let forward_channel = channel.clone();
        let forward = tokio::spawn(crate::coalesce::forward_coalesced(
            rx,
            forward_channel,
            |bytes_base64| TelnetEvent::Data { bytes_base64 },
            |status| TelnetEvent::Status {
                status: status_label(status),
            },
        ));

        let connect_result = session.lock().await.connect(tx).await;
        if connect_result.is_err() {
            let telnet_state = app.state::<TelnetState>();
            telnet_state
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
pub async fn telnet_write(
    session_id: String,
    data: Vec<u8>,
    state: State<'_, TelnetState>,
) -> Result<(), String> {
    let session = lookup(&state, &session_id).await?;
    let mut session = session.lock().await;
    session.write(&data).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn telnet_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, TelnetState>,
) -> Result<(), String> {
    let session = lookup(&state, &session_id).await?;
    let mut session = session.lock().await;
    session.resize(cols, rows).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn telnet_disconnect(
    session_id: String,
    state: State<'_, TelnetState>,
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
    state: &State<'_, TelnetState>,
    session_id: &str,
) -> Result<Arc<TokioMutex<TelnetSession>>, String> {
    state
        .sessions
        .lock()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("no such session: {session_id}"))
}
