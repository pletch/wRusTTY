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
/// How much pre-connect input is held before the rest is refused.
///
/// The queue exists for keystrokes typed at a pane that is still handshaking,
/// which is a human typing for at most a few seconds — 64 KB is orders of
/// magnitude past any plausible amount of that. What it guards against is a
/// paste into a pane whose host-key prompt has been sitting unanswered for ten
/// minutes: without a cap that accumulates without limit and is then replayed
/// into the shell all at once.
const MAX_PENDING_INPUT: usize = 64 * 1024;

pub enum Slot<S> {
    Connecting {
        /// Keystrokes typed before the session existed, in order.
        input: Vec<u8>,
        /// Last size only — an intermediate size during a drag is not worth
        /// replaying, and the PTY only cares where it ended up.
        size: Option<(u16, u16)>,
    },
    Ready(S),
    /// Disconnected while still handshaking. The id is already out of the map;
    /// this marks the slot itself so a handshake that finishes *after* the
    /// `disconnect` learns it is unwanted without the two having to be
    /// serialised on the map lock — see [`publish_if_wanted`].
    Cancelled,
}

impl<S> Slot<S> {
    /// The connected session, or the error the frontend sees for one that is
    /// still handshaking.
    pub fn ready(&self) -> Result<&S, String> {
        match self {
            Slot::Ready(session) => Ok(session),
            Slot::Connecting { .. } => Err("session is still connecting".to_string()),
            // Only reachable through a slot handle cloned out of the map
            // before the disconnect removed it.
            Slot::Cancelled => Err("session was disconnected".to_string()),
        }
    }
}

/// Publishes a freshly connected session into its slot, unless the id has been
/// disconnected while the handshake was running — in which case the session is
/// closed cleanly and whatever was queued for it is discarded.
///
/// The map lock covers the membership check *only*. It used to be held across
/// the replay as well, on the reasoning that bytes typed during the replay
/// belong after the bytes being replayed — but that ordering is the *slot*
/// lock's doing, and `publish` takes it anyway, as does every `write`. What
/// the wider scope actually bought was serialising every other session of this
/// transport behind this one's replay: `lookup`, `write`, `resize`,
/// `disconnect`, `spawn_connect` and SFTP all take the map lock, and an SSH
/// `write` against a full channel window blocks until the remote reads. One
/// pane finishing its handshake into a wedged host could therefore stall input
/// to every other SSH pane, the file browser, and the ability to close any of
/// them — the precise property the `Connector`/`Session` split exists to
/// prevent.
///
/// Narrowing it reopens the gap the wide lock closed: a `disconnect` landing
/// between the check and the replay. Queued input reaching a host the user
/// already cancelled is not a cosmetic bug — if what was typed was a password
/// meant for the next prompt, it goes to a host they just declined to trust.
/// [`Slot::Cancelled`] closes it under the slot lock instead: `disconnect`
/// marks the slot, `publish` refuses to replay into a marked one, and each
/// waits for the other because both need that one lock.
async fn publish_if_wanted<S: Session>(
    sessions: &SlotMap<S>,
    session_id: &str,
    slot: &SharedSlot<S>,
    session: S,
) {
    let wanted = sessions.lock().await.contains_key(session_id);
    let unwanted = if wanted {
        publish(slot, session).await
    } else {
        Some(session)
    };
    // Cancelled — either before we looked, or between the look and the slot
    // lock. Close it properly rather than letting `Drop` do it: for SSH that
    // is the difference between an `SSH_MSG_DISCONNECT` and the server seeing
    // the connection evaporate.
    if let Some(mut session) = unwanted {
        let _ = session.disconnect().await;
    }
}

/// Drains whatever arrived during the handshake into the new session, then
/// publishes it. Returns the session *unpublished* if the slot was cancelled
/// while the handshake ran, leaving the caller to close it.
///
/// Its own function so the queue-and-replay behaviour can be tested without an
/// `AppHandle`, a `Channel` or a real transport — it is the part of this
/// module most worth pinning, since getting it wrong silently drops the first
/// thing a user typed.
async fn publish<S: Session>(slot: &SharedSlot<S>, mut session: S) -> Option<S> {
    // Taken across the check and the replay both, so nothing can be enqueued
    // between draining and publishing and no `disconnect` can slip in
    // mid-replay: it would have to take this same lock to mark the slot.
    let mut slot = slot.lock().await;
    let (pending_input, pending_size) = match &mut *slot {
        Slot::Cancelled => return Some(session),
        Slot::Connecting { input, size } => (std::mem::take(input), size.take()),
        // Not reachable: one handshake fills one slot, once.
        Slot::Ready(_) => (Vec::new(), None),
    };
    // Size first: a resize applied after the bytes have gone out would
    // reflow what the program already printed in response to them.
    if let Some((cols, rows)) = pending_size {
        let _ = session.resize(cols, rows).await;
    }
    if !pending_input.is_empty() {
        let _ = session.write(&pending_input).await;
    }
    *slot = Slot::Ready(session);
    None
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
                // Refused rather than truncated: replaying the first 64 KB of
                // a paste and dropping the tail would send the remote a
                // half-finished command, which is worse than sending nothing.
                if input.len() + data.len() > MAX_PENDING_INPUT {
                    return Err(
                        "too much input queued while connecting — wait for the connection \
                         to finish, then send it again"
                            .to_string(),
                    );
                }
                input.extend_from_slice(data);
                Ok(())
            }
            Slot::Ready(session) => session.write(data).await.map_err(|e| e.to_string()),
            Slot::Cancelled => Err("session was disconnected".to_string()),
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
            Slot::Cancelled => Err("session was disconnected".to_string()),
        }
    }

    /// Removes the session first, then disconnects it. A session that failed
    /// to shut down cleanly is still gone as far as the registry is concerned,
    /// which is what the three copies did and is the behaviour worth keeping:
    /// leaving a half-dead session in the map would let the frontend keep
    /// writing to it.
    ///
    /// Disconnecting one that never finished connecting removes the id *and*
    /// marks the slot [`Slot::Cancelled`]. Removing the id alone is enough
    /// only for a handshake that hasn't checked yet; the mark is what stops
    /// one that already passed the check from replaying queued input into a
    /// host the user just cancelled — see [`publish_if_wanted`]. Whichever of
    /// the two gets the slot lock first, the other sees its result.
    pub async fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let slot = self.sessions.lock().await.remove(session_id);
        if let Some(slot) = slot {
            let mut slot = slot.lock().await;
            match &mut *slot {
                Slot::Ready(session) => session.disconnect().await.map_err(|e| e.to_string())?,
                // Queued input goes with it: it was typed at a pane the user
                // has since closed.
                Slot::Connecting { .. } => *slot = Slot::Cancelled,
                Slot::Cancelled => {}
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
                Ok(session) => publish_if_wanted(&sessions, &session_id, &slot, session).await,
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
        /// Set by `disconnect`, so a test can tell a clean close from a `Drop`.
        disconnected: Arc<std::sync::atomic::AtomicBool>,
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
            self.disconnected.store(true, Ordering::Relaxed);
            Ok(())
        }
    }

    /// A slot's state, for a panic message that says what it actually found
    /// rather than only what it wanted.
    fn describe(slot: &Slot<FakeSession>) -> &'static str {
        match slot {
            Slot::Connecting { .. } => "connecting",
            Slot::Ready(_) => "ready",
            Slot::Cancelled => "cancelled",
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
            other => panic!("not connecting: {}", describe(other)),
        }
    }

    async fn enqueue_size(slot: &SharedSlot<FakeSession>, cols: u16, rows: u16) {
        match &mut *slot.lock().await {
            Slot::Connecting { size, .. } => *size = Some((cols, rows)),
            other => panic!("not connecting: {}", describe(other)),
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
            other => panic!("not published: {}", describe(&other)),
        }
    }

    /// The behaviour the old design got for free by holding a mutex across the
    /// handshake: typing at a pane that is still connecting is not lost.
    #[tokio::test]
    async fn keystrokes_typed_during_the_handshake_are_delivered() {
        let slot = connecting();
        enqueue(&slot, b"who").await;
        enqueue(&slot, b"ami\n").await;

        assert!(publish(&slot, FakeSession::default()).await.is_none());

        assert_eq!(published(&slot).await.writes, vec![b"whoami\n".to_vec()]);
    }

    /// A pane resized while its host-key prompt was on screen must not keep
    /// the size it had when the connection started.
    #[tokio::test]
    async fn a_resize_during_the_handshake_is_applied() {
        let slot = connecting();
        enqueue_size(&slot, 120, 40).await;

        assert!(publish(&slot, FakeSession::default()).await.is_none());

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

        assert!(publish(&slot, FakeSession::default()).await.is_none());

        assert_eq!(published(&slot).await.sizes, vec![(120, 40)]);
    }

    /// Resize before write: bytes sent first would be answered by the program
    /// at the old size, and the reflow would land on output already printed.
    #[tokio::test]
    async fn the_size_is_applied_before_the_queued_input() {
        let slot = connecting();
        enqueue(&slot, b"ls\n").await;
        enqueue_size(&slot, 120, 40).await;

        assert!(publish(&slot, FakeSession::default()).await.is_none());

        let session = published(&slot).await;
        assert_eq!(session.sizes, vec![(120, 40)]);
        assert_eq!(session.writes, vec![b"ls\n".to_vec()]);
    }

    /// Nothing queued means nothing sent — a fresh session must not receive a
    /// spurious empty write or a resize to whatever it already is.
    #[tokio::test]
    async fn an_idle_handshake_replays_nothing() {
        let slot = connecting();
        assert!(publish(&slot, FakeSession::default()).await.is_none());

        let session = published(&slot).await;
        assert!(session.writes.is_empty());
        assert!(session.sizes.is_empty());
    }

    /// Only exists so `SessionRegistry`'s own methods — which are generic over
    /// `Connector`, not `Session` — can be exercised without a transport.
    /// `connect` is never called: every test here registers a slot directly.
    struct FakeConnector;

    #[async_trait]
    impl Connector for FakeConnector {
        type Session = FakeSession;
        type Error = NeverFails;

        async fn connect(
            self,
            _events: tokio::sync::mpsc::Sender<ConnectionEvent>,
        ) -> Result<FakeSession, NeverFails> {
            unreachable!("tests register slots directly rather than handshaking")
        }
    }

    /// A registry holding one id that is still connecting.
    async fn registry_with_connecting_slot(session_id: &str) -> SessionRegistry<FakeConnector> {
        let registry = SessionRegistry::<FakeConnector>::new("fake");
        registry
            .sessions
            .lock()
            .await
            .insert(session_id.to_string(), connecting());
        registry
    }

    /// A paste into a pane whose host-key prompt has been sitting unanswered
    /// must not accumulate without limit.
    #[tokio::test]
    async fn the_pre_connect_queue_is_capped() {
        let registry = registry_with_connecting_slot("fake-0").await;

        // Well under the cap: held, as the whole queue-and-replay design
        // intends.
        assert!(registry.write("fake-0", &vec![b'x'; 1024]).await.is_ok());

        // Past it: refused, and refused whole — a truncated paste would send
        // the remote half a command.
        let huge = vec![b'x'; MAX_PENDING_INPUT];
        assert!(registry.write("fake-0", &huge).await.is_err());

        // The refusal doesn't discard what was legitimately queued before it.
        let slot = registry.lookup("fake-0").await.unwrap();
        let queued = match &*slot.lock().await {
            Slot::Connecting { input, .. } => input.len(),
            other => panic!("should still be connecting, was {}", describe(other)),
        };
        assert_eq!(queued, 1024);
    }

    /// The cap is on the queue, not on the session: once connected, a large
    /// paste goes straight to the transport and is none of the registry's
    /// business.
    #[tokio::test]
    async fn the_cap_does_not_apply_once_connected() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        assert!(publish(&slot, FakeSession::default()).await.is_none());

        assert!(registry
            .write("fake-0", &vec![b'x'; MAX_PENDING_INPUT * 2])
            .await
            .is_ok());
    }

    fn registered(session_id: &str, slot: &SharedSlot<FakeSession>) -> SlotMap<FakeSession> {
        let mut map = HashMap::new();
        map.insert(session_id.to_string(), slot.clone());
        Arc::new(TokioMutex::new(map))
    }

    /// The point of the whole membership check: a pane closed while its
    /// host-key prompt was up must not have what was typed into it sent to the
    /// host once the handshake finishes. If those bytes were a password meant
    /// for the *next* prompt, they would land on a host the user just declined.
    #[tokio::test]
    async fn a_cancelled_connection_never_receives_its_queued_input() {
        let slot = connecting();
        let sessions = registered("ssh-0", &slot);
        enqueue(&slot, b"hunter2\n").await;
        enqueue_size(&slot, 120, 40).await;

        // The user closes the pane while the handshake is still running.
        sessions.lock().await.remove("ssh-0");

        let disconnected = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let session = FakeSession {
            disconnected: disconnected.clone(),
            ..Default::default()
        };
        publish_if_wanted(&sessions, "ssh-0", &slot, session).await;

        // Nothing was published into the orphaned slot...
        assert!(
            slot.lock().await.ready().is_err(),
            "a cancelled slot must not receive the session"
        );
        // ...and the session was closed cleanly rather than dropped.
        assert!(
            disconnected.load(Ordering::Relaxed),
            "expected a clean disconnect, not a bare Drop"
        );
    }

    /// The ordinary path still has to work: an id that is still registered gets
    /// its session, and its queued input.
    #[tokio::test]
    async fn a_live_connection_still_publishes_and_replays() {
        let slot = connecting();
        let sessions = registered("ssh-0", &slot);
        enqueue(&slot, b"whoami\n").await;

        publish_if_wanted(&sessions, "ssh-0", &slot, FakeSession::default()).await;

        let session = published(&slot).await;
        assert_eq!(session.writes, vec![b"whoami\n".to_vec()]);
        assert!(!session.disconnected.load(Ordering::Relaxed));
    }

    /// The race the map lock used to cover by being held across the replay:
    /// `disconnect` lands *after* the membership check has already passed.
    /// The mark it leaves on the slot is what the publish then sees.
    #[tokio::test]
    async fn a_disconnect_after_the_membership_check_still_wins() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        registry.write("fake-0", b"hunter2\n").await.unwrap();

        // The check that `publish_if_wanted` does first — passing, because the
        // user has not closed the pane yet.
        assert!(registry.sessions.lock().await.contains_key("fake-0"));

        // And now they do, in the window before the handshake publishes.
        registry.disconnect("fake-0").await.unwrap();

        let disconnected = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let session = FakeSession {
            disconnected: disconnected.clone(),
            ..Default::default()
        };
        let unpublished = publish(&slot, session).await;

        let unpublished = unpublished.expect("a cancelled slot must hand the session back");
        assert!(
            unpublished.writes.is_empty(),
            "queued input must not reach a host the user cancelled"
        );
        assert!(slot.lock().await.ready().is_err());
    }

    /// The same race through the front door, so the two halves are pinned
    /// together rather than only in the piece each one touches.
    #[tokio::test]
    async fn a_session_cancelled_mid_publish_is_closed_cleanly() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        registry.disconnect("fake-0").await.unwrap();

        let disconnected = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let session = FakeSession {
            disconnected: disconnected.clone(),
            ..Default::default()
        };
        publish_if_wanted(&registry.sessions, "fake-0", &slot, session).await;

        assert!(
            disconnected.load(Ordering::Relaxed),
            "expected a clean disconnect, not a bare Drop"
        );
    }

    /// Disconnecting a still-connecting id leaves the slot marked rather than
    /// merely dropping it from the map — the mark is the whole mechanism, and
    /// a slot handle cloned out before the removal is how anything still
    /// reaches it (`Slot::ready`, which `sftp_list_dir` and friends call).
    #[tokio::test]
    async fn disconnecting_a_connecting_id_marks_its_slot() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        registry.write("fake-0", b"queued").await.unwrap();

        registry.disconnect("fake-0").await.unwrap();

        match &*slot.lock().await {
            Slot::Cancelled => {}
            other => panic!("expected a cancelled slot, was {}", describe(other)),
        }
        assert!(slot.lock().await.ready().is_err());
        // The id is gone from the map too, so the ordinary path reports it as
        // no such session rather than as a cancelled one.
        assert!(registry.write("fake-0", b"x").await.is_err());
        assert!(registry.resize("fake-0", 80, 24).await.is_err());
    }

    /// Asking a still-connecting slot for its session is an error, not a
    /// panic and not a wait — `sftp_list_dir` and friends reach one this way.
    #[tokio::test]
    async fn ready_reports_a_connecting_slot_rather_than_blocking() {
        let slot = connecting();
        assert!(slot.lock().await.ready().is_err());

        assert!(publish(&slot, FakeSession::default()).await.is_none());
        assert!(slot.lock().await.ready().is_ok());
    }
}
