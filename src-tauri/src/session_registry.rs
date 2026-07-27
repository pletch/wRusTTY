//! The part of a transport's command layer that isn't about the transport.
//!
//! `ssh.rs`, `telnet.rs` and `serial.rs` each independently defined the same
//! session map, the same id counter, the same `lookup`, the same
//! write/resize/disconnect bodies, and the same ~35-line spawn-connect block —
//! roughly 150 of the ~790 lines across the three, differing only in which
//! concrete session type and which `XxxEvent` constructor they named.
//!
//! `wr_core`'s `Connector`/`Session` pair already abstracts exactly that
//! difference, so this is generic over it. The `#[tauri::command]` functions
//! have to stay where they are — `generate_handler!` needs them by name and
//! can't take a generic — but each shrinks to one delegating line.
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
use wr_core::{ConnectionEvent, ConnectionStatus, Connector, Session};

/// A session id's occupant.
///
/// The handshake used to run with the session's own mutex held, because
/// `connect` took `&mut self` on the same type `write` and `resize` did. For
/// SSH that mutex was held across TCP connect, KEX, auth *and* the host-key
/// prompt — which blocks on a human reading a fingerprint — so any input or
/// resize arriving in that window queued behind it, and anything else that
/// later wanted the same lock would have deadlocked against it.
///
/// Splitting `Connector` from `Session` moved the handshake off the shared
/// value entirely. This enum is what fills the gap it left: the id exists from
/// the moment the frontend gets it, and until the session does, whatever
/// arrives is held here.
///
/// Holding rather than rejecting is deliberate — it is what the mutex used to
/// do by accident. Keystrokes typed at a connecting pane were delivered once
/// the handshake finished, and a resize during the handshake was applied to
/// the new PTY. Failing those fast would have been a visible regression: the
/// resize one especially, since a pane resized while its host-key prompt was
/// on screen would have kept the size it had when the connection started.
pub enum Slot<S> {
    Connecting {
        /// Keystrokes typed before the session existed, in order.
        input: Vec<u8>,
        /// Last size only — an intermediate size during a drag is not worth
        /// replaying, and the PTY only cares where it ended up.
        size: Option<(u16, u16)>,
    },
    Ready(S),
}

impl<S> Slot<S> {
    /// The connected session, or the error the frontend sees for one that is
    /// still handshaking.
    pub fn ready(&self) -> Result<&S, String> {
        match self {
            Slot::Ready(session) => Ok(session),
            Slot::Connecting { .. } => Err("session is still connecting".to_string()),
        }
    }
}

/// Drains whatever arrived during the handshake into the new session, then
/// publishes it.
///
/// Its own function so the queue-and-replay behaviour can be tested without an
/// `AppHandle`, a `Channel` or a real transport — it is the part of this
/// module most worth pinning, since getting it wrong silently drops the first
/// thing a user typed.
async fn publish<S: Session>(slot: &SharedSlot<S>, mut session: S) {
    // Taken under the slot lock so nothing can be enqueued between draining
    // and publishing.
    let mut slot = slot.lock().await;
    if let Slot::Connecting { input, size } = &mut *slot {
        let pending_input = std::mem::take(input);
        let pending_size = size.take();
        // Size first: a resize applied after the bytes have gone out would
        // reflow what the program already printed in response to them.
        if let Some((cols, rows)) = pending_size {
            let _ = session.resize(cols, rows).await;
        }
        if !pending_input.is_empty() {
            let _ = session.write(&pending_input).await;
        }
    }
    *slot = Slot::Ready(session);
}

/// One session id's slot, shared between the command layer and the connect
/// task that fills it in.
type SharedSlot<S> = Arc<TokioMutex<Slot<S>>>;

/// Every live slot of one transport, by id.
type SlotMap<S> = Arc<TokioMutex<HashMap<String, SharedSlot<S>>>>;

/// Live sessions of one transport, keyed by the id handed back to the
/// frontend.
///
/// The map is behind an `Arc` rather than owned outright so the connect task
/// can hold onto it directly. The three copies this replaces each reached back
/// through `app.state::<XxxState>()` to clean up after a failed handshake,
/// which worked but meant the cleanup path depended on the registry having
/// been `.manage()`d under exactly the type it expected — a coupling that
/// doesn't survive being made generic, and wasn't worth keeping anyway.
pub struct SessionRegistry<C: Connector> {
    sessions: SlotMap<C::Session>,
    next_id: AtomicU64,
    /// `"ssh"`, `"telnet"`, `"serial"` — the id prefix, which is also what
    /// keeps ids from colliding across transports.
    prefix: &'static str,
}

impl<C: Connector> SessionRegistry<C> {
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

    /// The slot for `session_id`, or the error the frontend sees when it asks
    /// about one that has already gone away.
    ///
    /// Returns the slot rather than the session because a caller may
    /// legitimately arrive mid-handshake; `Slot::ready` is where that becomes
    /// an error, at the point where a session is actually required.
    pub async fn lookup(&self, session_id: &str) -> Result<SharedSlot<C::Session>, String> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("no such session: {session_id}"))
    }

    /// Queues bytes if the handshake is still running, sends them if not.
    pub async fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let slot = self.lookup(session_id).await?;
        let mut slot = slot.lock().await;
        match &mut *slot {
            Slot::Connecting { input, .. } => {
                input.extend_from_slice(data);
                Ok(())
            }
            Slot::Ready(session) => session.write(data).await.map_err(|e| e.to_string()),
        }
    }

    /// As `write`: a resize during the handshake is remembered and applied to
    /// the session the moment it exists.
    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let slot = self.lookup(session_id).await?;
        let mut slot = slot.lock().await;
        match &mut *slot {
            Slot::Connecting { size, .. } => {
                *size = Some((cols, rows));
                Ok(())
            }
            Slot::Ready(session) => session.resize(cols, rows).await.map_err(|e| e.to_string()),
        }
    }

    /// Removes the session first, then disconnects it. A session that failed
    /// to shut down cleanly is still gone as far as the registry is concerned,
    /// which is what the three copies did and is the behaviour worth keeping:
    /// leaving a half-dead session in the map would let the frontend keep
    /// writing to it.
    ///
    /// Disconnecting one that never finished connecting is a no-op here — the
    /// connect task sees the id has gone and drops the session it built.
    pub async fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let slot = self.sessions.lock().await.remove(session_id);
        if let Some(slot) = slot {
            if let Slot::Ready(session) = &mut *slot.lock().await {
                session.disconnect().await.map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    /// Registers `session_id` as connecting, then drives the handshake on a
    /// spawned task while forwarding events to the frontend. Returns
    /// immediately — the connection is still being established.
    ///
    /// `make_status` is the only thing that differed between the three copies
    /// of this: each transport has its own `XxxEvent` enum, because each is
    /// its own `Channel<E>` on the frontend side.
    pub async fn spawn_connect<E, F>(
        &self,
        app: AppHandle,
        session_id: String,
        connector: C,
        channel: Channel<E>,
        data_channel: Channel<InvokeResponseBody>,
        make_status: F,
    ) where
        E: Serialize + Clone + Send + 'static,
        F: Fn(&ConnectionStatus) -> E + Send + 'static,
    {
        let slot = Arc::new(TokioMutex::new(Slot::Connecting {
            input: Vec::new(),
            size: None,
        }));
        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), slot.clone());

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

            // No lock held here. This is the whole point of the split: the
            // handshake can take as long as a human takes to read a
            // fingerprint without blocking a keystroke or a resize.
            match connector.connect(tx).await {
                Ok(session) => publish(&slot, session).await,
                Err(_) => {
                    // The status event carrying the reason has already gone to
                    // the frontend from inside `connect`.
                    sessions.lock().await.remove(&session_id);
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    /// Records what reached the transport, in order, so a test can assert the
    /// handshake window replayed correctly rather than merely not panicking.
    #[derive(Default)]
    struct FakeSession {
        writes: Vec<Vec<u8>>,
        sizes: Vec<(u16, u16)>,
    }

    #[derive(Debug)]
    struct NeverFails;

    impl std::fmt::Display for NeverFails {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "never fails")
        }
    }

    impl std::error::Error for NeverFails {}

    #[async_trait]
    impl Session for FakeSession {
        type Error = NeverFails;

        async fn write(&mut self, data: &[u8]) -> Result<(), NeverFails> {
            self.writes.push(data.to_vec());
            Ok(())
        }

        async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), NeverFails> {
            self.sizes.push((cols, rows));
            Ok(())
        }

        async fn disconnect(&mut self) -> Result<(), NeverFails> {
            Ok(())
        }
    }

    fn connecting() -> SharedSlot<FakeSession> {
        Arc::new(TokioMutex::new(Slot::Connecting {
            input: Vec::new(),
            size: None,
        }))
    }

    async fn enqueue(slot: &SharedSlot<FakeSession>, data: &[u8]) {
        match &mut *slot.lock().await {
            Slot::Connecting { input, .. } => input.extend_from_slice(data),
            Slot::Ready(_) => panic!("already connected"),
        }
    }

    async fn enqueue_size(slot: &SharedSlot<FakeSession>, cols: u16, rows: u16) {
        match &mut *slot.lock().await {
            Slot::Connecting { size, .. } => *size = Some((cols, rows)),
            Slot::Ready(_) => panic!("already connected"),
        }
    }

    async fn published(slot: &SharedSlot<FakeSession>) -> FakeSession {
        match std::mem::replace(
            &mut *slot.lock().await,
            Slot::Connecting {
                input: Vec::new(),
                size: None,
            },
        ) {
            Slot::Ready(s) => s,
            Slot::Connecting { .. } => panic!("still connecting"),
        }
    }

    /// The behaviour the old design got for free by holding a mutex across the
    /// handshake: typing at a pane that is still connecting is not lost.
    #[tokio::test]
    async fn keystrokes_typed_during_the_handshake_are_delivered() {
        let slot = connecting();
        enqueue(&slot, b"who").await;
        enqueue(&slot, b"ami\n").await;

        publish(&slot, FakeSession::default()).await;

        assert_eq!(published(&slot).await.writes, vec![b"whoami\n".to_vec()]);
    }

    /// A pane resized while its host-key prompt was on screen must not keep
    /// the size it had when the connection started.
    #[tokio::test]
    async fn a_resize_during_the_handshake_is_applied() {
        let slot = connecting();
        enqueue_size(&slot, 120, 40).await;

        publish(&slot, FakeSession::default()).await;

        assert_eq!(published(&slot).await.sizes, vec![(120, 40)]);
    }

    /// Only the last size is replayed — an intermediate size from a drag has
    /// nothing to say once the drag has ended.
    #[tokio::test]
    async fn only_the_final_size_is_replayed() {
        let slot = connecting();
        enqueue_size(&slot, 80, 24).await;
        enqueue_size(&slot, 100, 30).await;
        enqueue_size(&slot, 120, 40).await;

        publish(&slot, FakeSession::default()).await;

        assert_eq!(published(&slot).await.sizes, vec![(120, 40)]);
    }

    /// Resize before write: bytes sent first would be answered by the program
    /// at the old size, and the reflow would land on output already printed.
    #[tokio::test]
    async fn the_size_is_applied_before_the_queued_input() {
        let slot = connecting();
        enqueue(&slot, b"ls\n").await;
        enqueue_size(&slot, 120, 40).await;

        publish(&slot, FakeSession::default()).await;

        let session = published(&slot).await;
        assert_eq!(session.sizes, vec![(120, 40)]);
        assert_eq!(session.writes, vec![b"ls\n".to_vec()]);
    }

    /// Nothing queued means nothing sent — a fresh session must not receive a
    /// spurious empty write or a resize to whatever it already is.
    #[tokio::test]
    async fn an_idle_handshake_replays_nothing() {
        let slot = connecting();
        publish(&slot, FakeSession::default()).await;

        let session = published(&slot).await;
        assert!(session.writes.is_empty());
        assert!(session.sizes.is_empty());
    }

    /// Asking a still-connecting slot for its session is an error, not a
    /// panic and not a wait — `sftp_list_dir` and friends reach one this way.
    #[tokio::test]
    async fn ready_reports_a_connecting_slot_rather_than_blocking() {
        let slot = connecting();
        assert!(slot.lock().await.ready().is_err());

        publish(&slot, FakeSession::default()).await;
        assert!(slot.lock().await.ready().is_ok());
    }
}
