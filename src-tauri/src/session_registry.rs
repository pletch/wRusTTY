//! The part of a transport's command layer that isn't about the transport.
//!
//! `ssh.rs`, `telnet.rs` and `serial.rs` each independently defined the same
//! session map, the same id counter, the same `lookup`, the same
//! write/resize/disconnect bodies, and the same ~35-line spawn-connect block —
//! roughly 150 of the ~790 lines across the three, differing only in which
//! concrete session type and which `XxxEvent` constructor they named.
//!
//! `wr_core::Connection` already abstracts exactly that difference, so this is
//! generic over it. The `#[tauri::command]` functions have to stay where they
//! are — `generate_handler!` needs them by name and can't take a generic — but
//! each shrinks to one delegating line.
//!
//! What deliberately stays outside: SSH's `pending_host_key` and `forwards`
//! maps live alongside a registry rather than inside one (they're SSH's, not
//! every transport's), and serial's `set_dtr`/`set_rts`/`send_break` go
//! straight to the session, since nothing generic could say anything about
//! them.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex as TokioMutex;
use wr_core::{Connection, ConnectionEvent, ConnectionStatus};

/// Live sessions of one transport, keyed by the id handed back to the
/// frontend.
///
/// The map is behind an `Arc` rather than owned outright so the connect task
/// can hold onto it directly. The three copies this replaces each reached back
/// through `app.state::<XxxState>()` to clean up after a failed handshake,
/// which worked but meant the cleanup path depended on the registry having
/// been `.manage()`d under exactly the type it expected — a coupling that
/// doesn't survive being made generic, and wasn't worth keeping anyway.
pub struct SessionRegistry<C> {
    sessions: Arc<TokioMutex<HashMap<String, Arc<TokioMutex<C>>>>>,
    next_id: AtomicU64,
    /// `"ssh"`, `"telnet"`, `"serial"` — the id prefix, which is also what
    /// keeps ids from colliding across transports.
    prefix: &'static str,
}

impl<C> SessionRegistry<C> {
    pub fn new(prefix: &'static str) -> Self {
        Self {
            sessions: Arc::new(TokioMutex::new(HashMap::new())),
            next_id: AtomicU64::new(0),
            prefix,
        }
    }

    pub fn next_session_id(&self) -> String {
        format!(
            "{}-{}",
            self.prefix,
            self.next_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    /// The session for `session_id`, or the error the frontend sees when it
    /// asks about one that has already gone away.
    pub async fn lookup(&self, session_id: &str) -> Result<Arc<TokioMutex<C>>, String> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("no such session: {session_id}"))
    }

    pub async fn insert(&self, session_id: String, session: Arc<TokioMutex<C>>) {
        self.sessions.lock().await.insert(session_id, session);
    }

    pub async fn remove(&self, session_id: &str) -> Option<Arc<TokioMutex<C>>> {
        self.sessions.lock().await.remove(session_id)
    }
}

impl<C: Connection + Send + 'static> SessionRegistry<C> {
    pub async fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let session = self.lookup(session_id).await?;
        let mut session = session.lock().await;
        session.write(data).await.map_err(|e| e.to_string())
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.lookup(session_id).await?;
        let mut session = session.lock().await;
        session.resize(cols, rows).await.map_err(|e| e.to_string())
    }

    /// Removes the session first, then disconnects it. A session that failed
    /// to shut down cleanly is still gone as far as the registry is concerned,
    /// which is what the three copies did and is the behaviour worth keeping:
    /// leaving a half-dead session in the map would let the frontend keep
    /// writing to it.
    pub async fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let session = self.remove(session_id).await;
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

    /// Registers `session` under a fresh id, then drives its handshake on a
    /// spawned task while forwarding its events to the frontend. Returns the
    /// id immediately — the connection is still being established.
    ///
    /// `make_status` is the only thing that differed between the three copies
    /// of this: each transport has its own `XxxEvent` enum, because each is
    /// its own `Channel<E>` on the frontend side.
    pub async fn spawn_connect<E, F>(
        &self,
        app: AppHandle,
        session_id: String,
        session: Arc<TokioMutex<C>>,
        channel: Channel<E>,
        data_channel: Channel<InvokeResponseBody>,
        make_status: F,
    ) where
        E: Serialize + Clone + Send + 'static,
        F: Fn(&ConnectionStatus) -> E + Send + 'static,
    {
        self.insert(session_id.clone(), session.clone()).await;

        let sessions = self.sessions.clone();

        tokio::spawn(async move {
            let (tx, rx) = tokio::sync::mpsc::channel::<ConnectionEvent>(
                crate::coalesce::CONNECTION_EVENT_CHANNEL_BOUND,
            );

            let log_app = app.clone();
            let log_session_id = session_id.clone();
            let forward = tokio::spawn(crate::coalesce::forward_coalesced(
                session_id.clone(),
                rx,
                channel,
                data_channel,
                make_status,
                move |bytes| {
                    crate::logging::write(
                        &log_app.state::<crate::logging::LoggingState>(),
                        &log_session_id,
                        bytes,
                    )
                },
            ));

            let connect_result = session.lock().await.connect(tx).await;
            if connect_result.is_err() {
                sessions.lock().await.remove(&session_id);
            }

            // Once connect() returns, the session's own output-pump task keeps
            // running independently (spawned inside the transport crate); this
            // task's only job was driving the handshake and forwarding events,
            // so let the forwarder finish draining whatever's left in the
            // channel.
            drop(forward);
        });
    }
}
