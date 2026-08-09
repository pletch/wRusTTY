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
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, Mutex as TokioMutex};
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
    Ready {
        session: S,
        /// The size this session was last told about.
        ///
        /// Carried on a *live* slot only for the sake of reconnects. A
        /// transport opens its PTY at the size the connector was built with,
        /// which on a reconnect is the size the pane had when it first opened
        /// — so without this, a pane resized at any point in its life comes
        /// back at the wrong size and every full-screen program on it is drawn
        /// into the wrong box. [`begin_reconnect`] seeds the new
        /// `Connecting` window with it, and the existing replay does the rest.
        size: Option<(u16, u16)>,
    },
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
            Slot::Ready { session, .. } => Ok(session),
            // Also what a caller sees mid-reconnect, and the right answer
            // there too: there is no session to serve an SFTP listing from
            // until the new one lands.
            Slot::Connecting { .. } => Err("session is still connecting".to_string()),
            // Only reachable through a slot handle cloned out of the map
            // before the disconnect removed it.
            Slot::Cancelled => Err("session was disconnected".to_string()),
        }
    }

    /// The last size this slot knows about, in whichever state it is in.
    fn size(&self) -> Option<(u16, u16)> {
        match self {
            Slot::Connecting { size, .. } | Slot::Ready { size, .. } => *size,
            Slot::Cancelled => None,
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
///
/// Returns whether the session was published, which is also the supervisor's
/// signal to keep watching this id: `false` means the pane is gone and there is
/// nothing left to reconnect.
async fn publish_if_wanted<S: Session>(
    sessions: &SlotMap<S>,
    session_id: &str,
    slot: &SharedSlot<S>,
    session: S,
) -> bool {
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
        return false;
    }
    true
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
        // Not reachable: one handshake fills one slot, once — and a reconnect
        // takes the slot back to `Connecting` before its handshake starts.
        Slot::Ready { .. } => (Vec::new(), None),
    };
    // Size first: a resize applied after the bytes have gone out would
    // reflow what the program already printed in response to them.
    if let Some((cols, rows)) = pending_size {
        let _ = session.resize(cols, rows).await;
    }
    if !pending_input.is_empty() {
        let _ = session.write(&pending_input).await;
    }
    *slot = Slot::Ready {
        session,
        size: pending_size,
    };
    None
}

/// Takes a live slot back to `Connecting` so a reconnect's handshake window
/// queues input exactly the way the first one did.
///
/// This is the whole mechanism, and the reason the session id stays the same:
/// everything keyed off that id — the frontend's engine and scrollback, the
/// logging sink, the SFTP edit watchers, the coalescer's credit window —
/// survives without knowing a reconnect happened, and keystrokes typed at the
/// pane mid-reconnect are held and replayed for free.
///
/// Returns the dead session for the caller to close outside this lock.
async fn begin_reconnect<S>(slot: &SharedSlot<S>) -> Reclaimed<S> {
    let mut guard = slot.lock().await;
    // The pane closed between the transport dying and us noticing. The mark is
    // what stops queued input from reaching the session a reconnect would
    // otherwise go on to produce, so leave it exactly where it is.
    if matches!(&*guard, Slot::Cancelled) {
        return Reclaimed::Cancelled;
    }
    let size = guard.size();
    let previous = std::mem::replace(
        &mut *guard,
        Slot::Connecting {
            input: Vec::new(),
            size,
        },
    );
    match previous {
        Slot::Ready { session, .. } => Reclaimed::Displaced(session),
        // Only reachable if the transport reported a drop before its session
        // was ever published, which no transport does.
        _ => Reclaimed::Nothing,
    }
}

/// What [`begin_reconnect`] found in the slot.
enum Reclaimed<S> {
    /// The dead session, displaced by a fresh `Connecting` window.
    Displaced(S),
    /// The pane closed first. The slot stays marked and the reconnect stops.
    Cancelled,
    /// A `Connecting` slot, left as it was.
    Nothing,
}

/// Marks a slot that will never receive a session, so anything still holding a
/// handle to it is told the session is gone rather than that it is "still
/// connecting" — which, for a slot nothing is connecting into, would be a lie
/// that never resolves and would let `write` queue bytes into a void.
///
/// Only ever replaces a `Connecting` slot: a `Ready` one has a live session in
/// it that would be dropped without a clean close.
async fn abandon<S>(slot: &SharedSlot<S>) {
    let mut guard = slot.lock().await;
    if matches!(&*guard, Slot::Connecting { .. }) {
        *guard = Slot::Cancelled;
    }
}

/// How often the pre-connect step is checked for having been cancelled.
///
/// Polled rather than signalled because a per-slot notifier would be a channel
/// on every session for the benefit of the one step slow enough to need it,
/// and half a second of latency on an abort whose pane is already closed is
/// not something anyone is waiting on.
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Resolves once `session_id` is gone from the map — which is what closing a
/// pane during the pre-connect step looks like from in here.
async fn removed<S>(sessions: &SlotMap<S>, session_id: &str) {
    loop {
        tokio::time::sleep(CANCEL_POLL_INTERVAL).await;
        if !sessions.lock().await.contains_key(session_id) {
            return;
        }
    }
}

/// The type `None` needs when there is no pre-connect step. Written out
/// because `spawn_connect` has to name one, and the closure type a real caller
/// passes can't be named at all.
pub type NoPrepare = fn(mpsc::Sender<ConnectionEvent>) -> std::future::Ready<Result<(), String>>;

/// The pause before the first retry, doubling from there.
///
/// A second, because the overwhelming majority of real drops are a few seconds
/// of wifi and the host is still sitting there — waiting longer than the outage
/// is the failure mode worth avoiding. It is not zero because an immediate
/// retry lands while the interface is still down and only burns an attempt.
const RECONNECT_BASE_DELAY: Duration = Duration::from_secs(1);

/// The ceiling the doubling stops at. Past half a minute the retry stops being
/// something a person is waiting through and the pane may as well be idle.
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(30);

/// How many consecutive attempts a run gets. With the schedule above, twelve
/// spans roughly four minutes.
const RECONNECT_MAX_ATTEMPTS: u32 = 12;

/// ...and the wall-clock bound on the same run, which is the one that actually
/// binds once the delay saturates. Both are needed: the attempt count alone
/// would let a saturated schedule run for six minutes, and the clock alone
/// would allow an unbounded number of fast early attempts.
const RECONNECT_MAX_ELAPSED: Duration = Duration::from_secs(300);

/// How far either side of the nominal delay a retry may land, as a fraction.
///
/// Jitter matters here more than in a typical client because the failure is
/// usually shared: a switch reboots and every pane pointed at it drops in the
/// same second. Without this they would knock in lockstep for the whole run,
/// which is the load a host coming back up least wants.
const RECONNECT_JITTER: f64 = 0.2;

/// The nominal pause before `attempt` (counting from 1), before jitter.
///
/// Pure, and separate from the jitter, so the schedule can be asserted exactly
/// rather than within a tolerance.
fn backoff_delay(attempt: u32) -> Duration {
    // Saturating rather than wrapping: the shift overflows at attempt 33 and
    // the cap makes anything past attempt 6 identical anyway.
    let factor = 1u32
        .checked_shl(attempt.saturating_sub(1))
        .unwrap_or(u32::MAX);
    RECONNECT_BASE_DELAY
        .saturating_mul(factor)
        .min(RECONNECT_MAX_DELAY)
}

/// `delay` moved by up to [`RECONNECT_JITTER`] of itself. `spread` is in
/// `[-1.0, 1.0]`; a caller passing anything else gets it clamped rather than a
/// negative duration.
fn jittered(delay: Duration, spread: f64) -> Duration {
    let scale = 1.0 + RECONNECT_JITTER * spread.clamp(-1.0, 1.0);
    delay.mul_f64(scale)
}

/// A spread in `[-1.0, 1.0]` from the clock.
///
/// Deliberately not a `rand` dependency. What this needs is that two panes
/// dropping in the same second do not retry in the same millisecond, and the
/// nanosecond field of the wall clock at the moment each one is scheduled
/// already gives that. Nothing here is a security decision.
fn clock_spread() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos % 2001) as f64 / 1000.0 - 1.0
}

/// How long to wait before `attempt`, or `None` once the run has spent either
/// bound.
fn next_delay(attempt: u32, elapsed: Duration) -> Option<Duration> {
    if attempt > RECONNECT_MAX_ATTEMPTS || elapsed >= RECONNECT_MAX_ELAPSED {
        return None;
    }
    Some(jittered(backoff_delay(attempt), clock_spread()))
}

/// The delay as the status line should say it: whole seconds, never zero,
/// since "reconnecting in 0s" reads as a bug rather than as "imminently".
fn countdown_seconds(delay: Duration) -> u64 {
    (delay.as_secs_f64().round() as u64).max(1)
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
            Slot::Ready { session, .. } => session.write(data).await.map_err(|e| e.to_string()),
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
            // Recorded as well as applied: a reconnect opens its PTY at
            // whatever size the connector was built with, so this is the only
            // record of what the pane has actually become since.
            Slot::Ready { session, size } => {
                *size = Some((cols, rows));
                session.resize(cols, rows).await.map_err(|e| e.to_string())
            }
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
                Slot::Ready { session, .. } => {
                    session.disconnect().await.map_err(|e| e.to_string())?
                }
                // Queued input goes with it: it was typed at a pane the user
                // has since closed.
                Slot::Connecting { .. } => *slot = Slot::Cancelled,
                Slot::Cancelled => {}
            }
        }
        Ok(())
    }

    /// Registers `session_id` as connecting, then drives the handshake — and,
    /// for as long as the pane is there, every reconnect after it — on a
    /// spawned task while forwarding events to the frontend. Returns
    /// immediately; the connection is still being established.
    ///
    /// `make_status` is the only thing that differed between the three copies
    /// of this: each transport has its own `XxxEvent` enum, because each is
    /// its own `Channel<E>` on the frontend side.
    ///
    /// `prepare` is a step that runs before the handshake and can refuse it.
    /// It exists for Wake-on-LAN, and the reason it sits *here* rather than in
    /// the caller is the event channel: waking takes up to a minute, and doing
    /// it in the `#[tauri::command]` before this is called would block the IPC
    /// reply for that whole time with the pane showing nothing. By this point
    /// the forwarder is already running, so the step gets the same `Sender` the
    /// handshake uses and its progress reaches the UI the same way. It also
    /// gets cancellation for free, which is the other half of why it belongs
    /// here: only the registry knows the pane was closed. It runs once, for the
    /// first connect — a reconnect means the host was up a moment ago.
    ///
    /// `reconnect` builds a connector for each retry, and `None` opts a session
    /// out of auto-reconnect entirely — which is the right answer for a session
    /// whose credential cannot be re-resolved without asking a human (see
    /// `ssh.rs`). It is a factory rather than a clone of `connector` for two
    /// reasons. `Connector::connect` consumes `self`, so a retry needs
    /// *something* that produces a fresh one; and rebuilding re-resolves from
    /// the profile, so editing a host, a port or a serial adapter's identity
    /// takes effect on the next attempt rather than replaying whatever was
    /// baked in when the pane first opened. It is also where a credential is
    /// fetched and dropped again per attempt, rather than being held live for
    /// the session's whole lifetime.
    // Nine arguments, two past clippy's threshold, and the last two are the
    // ones that earn it: both are optional capabilities of the connection
    // rather than parts of it. Grouping them would mean a struct built once at
    // each of four call sites and destructured immediately here.
    #[allow(clippy::too_many_arguments)]
    pub async fn spawn_connect<E, F, P, Fut, MakeC, MakeFut>(
        &self,
        app: AppHandle,
        session_id: String,
        connector: C,
        channel: Channel<E>,
        data_channel: Channel<InvokeResponseBody>,
        make_status: F,
        prepare: Option<P>,
        reconnect: Option<MakeC>,
    ) where
        E: Serialize + Clone + Send + 'static,
        F: Fn(&ConnectionStatus) -> E + Send + 'static,
        P: FnOnce(mpsc::Sender<ConnectionEvent>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<(), String>> + Send,
        // `Sync` because the supervisor holds a reference to the factory
        // across its awaits, and the whole task is what `tokio::spawn` needs
        // to be `Send`.
        MakeC: Fn() -> MakeFut + Send + Sync + 'static,
        MakeFut: std::future::Future<Output = Result<C, String>> + Send,
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

            // How the supervisor below learns that the transport died.
            //
            // The event says so, but it says so on its way to the webview, and
            // the forwarder is the only thing in the process that sees it.
            // Unbounded because the observer it is sent from is synchronous and
            // sits on the path every byte of output takes — it must never
            // block, and in practice a session reports its own death once.
            let (down_tx, down_rx) = tokio::sync::mpsc::unbounded_channel::<()>();

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
                move |status| {
                    // Only `Lost`. A shell that exited is finished, and
                    // reconnecting it would fight the user — see
                    // `DisconnectKind`.
                    if matches!(
                        status,
                        ConnectionStatus::Disconnected(wr_core::DisconnectKind::Lost)
                    ) {
                        let _ = down_tx.send(());
                    }
                },
            ));

            if let Some(prepare) = prepare {
                let outcome = tokio::select! {
                    outcome = prepare(tx.clone()) => outcome,
                    // Closing the pane drops the step wherever it had got to.
                    // The id is already out of the map by then — `disconnect`
                    // removed it — so there is nothing here left to clean up.
                    _ = removed(&sessions, &session_id) => {
                        drop(forward);
                        return;
                    }
                };
                if let Err(message) = outcome {
                    // Unlike a failed handshake, nothing has reported this
                    // yet: the step never reached the transport, so the
                    // transport never had a chance to say why.
                    let _ = tx
                        .send(ConnectionEvent::Status(ConnectionStatus::Failed(message)))
                        .await;
                    sessions.lock().await.remove(&session_id);
                    abandon(&slot).await;
                    drop(forward);
                    return;
                }
            }

            supervise(
                sessions, session_id, slot, tx, down_rx, connector, reconnect,
            )
            .await;

            // Each connect() leaves the session's own output-pump task running
            // independently (spawned inside the transport crate); this task's
            // job was driving the handshakes and forwarding events, so let the
            // forwarder finish draining whatever's left in the channel.
            drop(forward);
        });
    }
}

/// One session id's whole life: the first handshake, and — while the pane is
/// still open and the drop was one nobody asked for — every reconnect after it.
///
/// # What must not regress
///
/// Auto-reconnect adds a *second* way a slot can leave `Ready`, and the
/// invariants [`publish_if_wanted`] documents all have to hold against it too.
/// The one that matters is the same one layer along: a pane closed while a
/// reconnect is in flight must not have queued input replayed into the session
/// that arrives afterwards. It cannot, and for exactly the original reason —
/// [`SessionRegistry::disconnect`] marks the slot `Cancelled` under the slot
/// lock, [`begin_reconnect`] refuses to leave a marked slot, and `publish`
/// refuses to fill one. Every loss of the map entry is also re-checked here
/// rather than assumed, because the pane can close during any of the three
/// waits below: the handshake, the live session, and the backoff.
// Owned rather than borrowed so it can be driven as a task of its own — which
// is how its tests reach it, since a reconnect run is only observable by
// watching one from the outside while the map and the slot are poked.
async fn supervise<C, MakeC, MakeFut>(
    sessions: SlotMap<C::Session>,
    session_id: String,
    slot: SharedSlot<C::Session>,
    tx: mpsc::Sender<ConnectionEvent>,
    mut down_rx: mpsc::UnboundedReceiver<()>,
    connector: C,
    reconnect: Option<MakeC>,
) where
    C: Connector,
    MakeC: Fn() -> MakeFut,
    MakeFut: std::future::Future<Output = Result<C, String>>,
{
    let sessions = &sessions;
    let session_id = session_id.as_str();
    let slot = &slot;
    let tx = &tx;
    let reconnect = reconnect.as_ref();
    // Attempt zero is the connector the caller already built; every one after
    // it comes from the factory.
    let mut pending = Some(connector);
    // Whether this id has ever had a live session. Auto-reconnect restores a
    // session that *was* up; a first handshake that fails has failed, and
    // silently retrying it for four minutes behind a "failed" message is not
    // what the user asked for when they pressed connect.
    let mut ever_connected = false;
    // Consecutive failures since the session was last up, and when that run
    // began. Both reset on every success, so a link that flaps once an hour all
    // day never works its way through the budget.
    let mut attempt: u32 = 0;
    let mut run_started = std::time::Instant::now();
    // Why the most recent attempt failed to get as far as a connector, kept for
    // the message the run ends on. Not reported per attempt: the frontend
    // raises a toast for every `Failed`, and a run of twelve would bury the
    // reconnecting state under its own progress reports.
    let mut build_error: Option<String> = None;

    loop {
        let connector = match pending.take() {
            Some(connector) => connector,
            None => match reconnect {
                Some(make) => match make().await {
                    Ok(connector) => {
                        build_error = None;
                        connector
                    }
                    // Not fatal, and deliberately so. The obvious reading —
                    // that a profile which will not resolve is a configuration
                    // fault no amount of waiting fixes — is wrong for the case
                    // this feature serves best: a serial profile resolves its
                    // COM port from the adapter's USB identity per attempt, so
                    // "does not resolve" is precisely what an adapter that has
                    // not been plugged back in yet looks like. A locked vault
                    // reads the same way, and retrying it means a user who
                    // unlocks within the window gets their session back rather
                    // than a pane that gave up while they were typing.
                    Err(message) => {
                        build_error = Some(message);
                        // Straight to the backoff: there is nothing to hand a
                        // handshake, but this still spends an attempt.
                        if let Some(delay) =
                            schedule_retry(tx, &mut attempt, run_started.elapsed()).await
                        {
                            tokio::select! {
                                _ = tokio::time::sleep(delay) => continue,
                                _ = removed(sessions, session_id) => return,
                            }
                        }
                        give_up(sessions, session_id, slot, tx, attempt, build_error).await;
                        return;
                    }
                },
                None => return,
            },
        };

        // No lock held here. This is the whole point of the Connector/Session
        // split: the handshake can take as long as a human takes to read a
        // fingerprint without blocking a keystroke or a resize.
        match connector.connect(tx.clone()).await {
            Ok(session) => {
                if !publish_if_wanted(sessions, session_id, slot, session).await {
                    // The pane went away mid-handshake. Nothing to supervise.
                    return;
                }
                ever_connected = true;
                attempt = 0;
                run_started = std::time::Instant::now();

                // Wait for this session to end, or for the pane to close.
                tokio::select! {
                    // `None` means the forwarder is gone, which means the
                    // webview is: nothing would see a reconnect.
                    down = down_rx.recv() => if down.is_none() { return },
                    _ = removed(sessions, session_id) => return,
                }

                // Only a `Lost` disconnect reaches `down_rx`, so the transport
                // went away without being asked to.
                if reconnect.is_none() {
                    return;
                }
                match begin_reconnect(slot).await {
                    Reclaimed::Displaced(mut dead) => {
                        // Closed rather than dropped, for the same reason
                        // `publish_if_wanted` closes an unwanted session — and
                        // here it also resets the SFTP cells, without which the
                        // reconnected session would hand out channels belonging
                        // to the connection that just died.
                        let _ = dead.disconnect().await;
                    }
                    Reclaimed::Cancelled => return,
                    Reclaimed::Nothing => {}
                }
            }
            Err(error) => {
                // The status event carrying the reason has already gone to the
                // frontend from inside `connect`.
                if !ever_connected || reconnect.is_none() || !C::retryable(&error) {
                    sessions.lock().await.remove(session_id);
                    abandon(slot).await;
                    return;
                }
                // The slot is still `Connecting` — a failed attempt never
                // published — so the queue-and-replay window simply stays open
                // across the retry, which is what should happen to anything
                // typed at the pane meanwhile.
            }
        }

        let Some(delay) = schedule_retry(tx, &mut attempt, run_started.elapsed()).await else {
            give_up(sessions, session_id, slot, tx, attempt, build_error).await;
            return;
        };

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = removed(sessions, session_id) => return,
        }
    }
}

/// Counts one more attempt, announces the wait, and reports how long it is —
/// or `None` when the run has spent its budget.
async fn schedule_retry(
    tx: &mpsc::Sender<ConnectionEvent>,
    attempt: &mut u32,
    elapsed: Duration,
) -> Option<Duration> {
    *attempt += 1;
    let delay = next_delay(*attempt, elapsed)?;
    let _ = tx
        .send(ConnectionEvent::Status(ConnectionStatus::Reconnecting {
            attempt: *attempt,
            in_seconds: countdown_seconds(delay),
        }))
        .await;
    Some(delay)
}

/// Ends a reconnect run for good: says so, drops the id, and marks the slot so
/// nothing keeps queueing input for a session that is never coming.
async fn give_up<S: Session>(
    sessions: &SlotMap<S>,
    session_id: &str,
    slot: &SharedSlot<S>,
    tx: &mpsc::Sender<ConnectionEvent>,
    attempts: u32,
    last_error: Option<String>,
) {
    // The last error is carried here rather than reported when it happened, so
    // the run produces one message instead of one per attempt — and this is the
    // most useful one to show, since it describes why it is still failing now.
    let reason = match last_error {
        Some(error) => format!("could not reconnect after {attempts} attempts: {error}"),
        None => format!("could not reconnect after {attempts} attempts"),
    };
    let _ = tx
        .send(ConnectionEvent::Status(ConnectionStatus::Failed(reason)))
        .await;
    sessions.lock().await.remove(session_id);
    abandon(slot).await;
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

    /// Carries its own retryability, because [`Connector::retryable`] is an
    /// associated function — the distinction it draws belongs to the error, and
    /// putting it there is what lets one fake connector cover both a drop worth
    /// retrying and an auth failure that must stop the loop.
    #[derive(Debug)]
    struct FakeError {
        retryable: bool,
    }

    impl FakeError {
        fn transient() -> Self {
            Self { retryable: true }
        }

        /// Stands in for a rejected credential: retrying spends one of the
        /// server's `MaxAuthTries`, so the loop must not.
        fn fatal() -> Self {
            Self { retryable: false }
        }
    }

    impl std::fmt::Display for FakeError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "fake failure (retryable: {})", self.retryable)
        }
    }

    impl std::error::Error for FakeError {}

    #[async_trait]
    impl Session for FakeSession {
        type Error = FakeError;

        async fn write(&mut self, data: &[u8]) -> Result<(), FakeError> {
            self.writes.push(data.to_vec());
            Ok(())
        }

        async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), FakeError> {
            self.sizes.push((cols, rows));
            Ok(())
        }

        async fn disconnect(&mut self) -> Result<(), FakeError> {
            self.disconnected.store(true, Ordering::Relaxed);
            Ok(())
        }
    }

    /// A slot's state, for a panic message that says what it actually found
    /// rather than only what it wanted.
    fn describe(slot: &Slot<FakeSession>) -> &'static str {
        match slot {
            Slot::Connecting { .. } => "connecting",
            Slot::Ready { .. } => "ready",
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
            Slot::Ready { session, .. } => session,
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

    /// A connector that fails a set number of times before succeeding.
    ///
    /// Two jobs. The registry's own methods are generic over `Connector` rather
    /// than `Session`, so something has to name one — most tests here register
    /// slots directly and never call `connect`. And the reconnect loop is only
    /// observable against a handshake that fails on demand, which is what
    /// `script` drives: backoff, attempt bounds, cancellation mid-retry and the
    /// replay ordering can all be pinned without a transport.
    struct FakeConnector {
        script: Arc<Script>,
    }

    /// Shared between every connector one factory builds, so the run's attempts
    /// are counted across them rather than per instance.
    #[derive(Default)]
    struct Script {
        /// How many attempts to fail before the next one succeeds.
        fail_first: AtomicU64,
        /// Whether those failures are worth retrying.
        fatal: std::sync::atomic::AtomicBool,
        /// Every `connect` call, successful or not.
        attempts: AtomicU64,
        /// Set by the session's `disconnect`, so a test can tell a clean close
        /// from a bare `Drop`.
        disconnected: Arc<std::sync::atomic::AtomicBool>,
    }

    impl Script {
        fn shared() -> Arc<Self> {
            Arc::new(Self::default())
        }

        fn failing(times: u64) -> Arc<Self> {
            let script = Self::shared();
            script.fail_first.store(times, Ordering::Relaxed);
            script
        }

        fn attempts(&self) -> u64 {
            self.attempts.load(Ordering::Relaxed)
        }

        /// A factory of the shape `spawn_connect` takes, closing over this
        /// script so each rebuild draws from the same plan.
        fn factory(
            self: &Arc<Self>,
        ) -> impl Fn() -> std::future::Ready<Result<FakeConnector, String>> {
            let script = self.clone();
            move || {
                std::future::ready(Ok(FakeConnector {
                    script: script.clone(),
                }))
            }
        }
    }

    #[async_trait]
    impl Connector for FakeConnector {
        type Session = FakeSession;
        type Error = FakeError;

        async fn connect(
            self,
            events: tokio::sync::mpsc::Sender<ConnectionEvent>,
        ) -> Result<FakeSession, FakeError> {
            self.script.attempts.fetch_add(1, Ordering::Relaxed);
            if self
                .script
                .fail_first
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1))
                .is_ok()
            {
                // Real connectors report their own failure from inside
                // `connect`; the supervisor relies on that having happened.
                let _ = events
                    .send(ConnectionEvent::Status(ConnectionStatus::Failed(
                        "scripted".to_string(),
                    )))
                    .await;
                return Err(if self.script.fatal.load(Ordering::Relaxed) {
                    FakeError::fatal()
                } else {
                    FakeError::transient()
                });
            }
            let _ = events
                .send(ConnectionEvent::Status(ConnectionStatus::Connected))
                .await;
            Ok(FakeSession {
                disconnected: self.script.disconnected.clone(),
                ..Default::default()
            })
        }

        fn retryable(error: &FakeError) -> bool {
            error.retryable
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

    // ---- auto-reconnect ----------------------------------------------------

    /// The schedule, exactly, since it is the thing a user actually experiences
    /// and the thing most likely to be "improved" into uselessness. Doubling
    /// from one second, capped at thirty.
    #[test]
    fn the_backoff_doubles_and_then_stops_doubling() {
        let seconds: Vec<u64> = (1..=8).map(|n| backoff_delay(n).as_secs()).collect();
        assert_eq!(seconds, vec![1, 2, 4, 8, 16, 30, 30, 30]);
    }

    /// The shift overflows at attempt 33. The cap makes everything past attempt
    /// six identical anyway, so the only requirement is that it not panic.
    #[test]
    fn an_absurd_attempt_number_still_yields_the_cap() {
        assert_eq!(backoff_delay(u32::MAX), RECONNECT_MAX_DELAY);
    }

    /// Jitter has to stay inside its stated band in both directions — a bug
    /// here is invisible until it produces a negative or a wildly long wait.
    #[test]
    fn jitter_stays_within_its_band() {
        let base = Duration::from_secs(10);
        assert_eq!(jittered(base, 0.0), base);
        assert_eq!(jittered(base, 1.0), Duration::from_secs(12));
        assert_eq!(jittered(base, -1.0), Duration::from_secs(8));
        // A caller out of range is clamped rather than producing a wait that
        // is negative (which would panic) or minutes long.
        assert_eq!(jittered(base, 40.0), Duration::from_secs(12));
        assert_eq!(jittered(base, -40.0), Duration::from_secs(8));
    }

    #[test]
    fn the_clock_spread_stays_in_range() {
        for _ in 0..1000 {
            let spread = clock_spread();
            assert!((-1.0..=1.0).contains(&spread), "out of range: {spread}");
        }
    }

    /// Both bounds are load-bearing: the attempt count alone would let a
    /// saturated schedule run for six minutes, and the clock alone would allow
    /// an unbounded number of fast early attempts.
    #[test]
    fn a_run_is_bounded_by_attempts_and_by_the_clock_separately() {
        assert!(next_delay(RECONNECT_MAX_ATTEMPTS, Duration::ZERO).is_some());
        assert!(next_delay(RECONNECT_MAX_ATTEMPTS + 1, Duration::ZERO).is_none());
        assert!(next_delay(1, RECONNECT_MAX_ELAPSED).is_none());
    }

    /// "reconnecting in 0s" reads as a bug rather than as "imminently", and
    /// jitter on the one-second step lands under half a second often enough to
    /// matter.
    #[test]
    fn the_countdown_never_reads_zero() {
        assert_eq!(countdown_seconds(Duration::from_millis(1)), 1);
        assert_eq!(countdown_seconds(Duration::from_millis(400)), 1);
        assert_eq!(countdown_seconds(Duration::from_millis(1600)), 2);
    }

    /// The size a pane has *now*, not the size it had when it first opened,
    /// which is what the connector would otherwise reopen the PTY at.
    #[tokio::test]
    async fn a_reconnect_carries_the_panes_current_size_forward() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        assert!(publish(&slot, FakeSession::default()).await.is_none());

        // The pane is resized at some point during its life.
        registry.resize("fake-0", 200, 60).await.unwrap();

        let Reclaimed::Displaced(_) = begin_reconnect(&slot).await else {
            panic!("expected the live session to be displaced");
        };

        // The new handshake window opens already knowing the size, so `publish`
        // applies it to the session that arrives.
        assert!(publish(&slot, FakeSession::default()).await.is_none());
        assert_eq!(published(&slot).await.sizes, vec![(200, 60)]);
    }

    /// The hazard the plan calls out one layer along from `publish_if_wanted`:
    /// a pane closed while a reconnect is in flight must not have queued input
    /// replayed into the session that arrives afterwards.
    #[tokio::test]
    async fn a_pane_closed_mid_reconnect_never_receives_its_queued_input() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        assert!(publish(&slot, FakeSession::default()).await.is_none());

        // The transport dies and the reconnect opens its queueing window.
        let Reclaimed::Displaced(_) = begin_reconnect(&slot).await else {
            panic!("expected the live session to be displaced");
        };
        // The user types into the reconnecting pane — a password meant for the
        // prompt they expect to come back to.
        registry.write("fake-0", b"hunter2\n").await.unwrap();
        // ...and then closes it before the handshake lands.
        registry.disconnect("fake-0").await.unwrap();

        let disconnected = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let unpublished = publish(
            &slot,
            FakeSession {
                disconnected: disconnected.clone(),
                ..Default::default()
            },
        )
        .await;

        let unpublished = unpublished.expect("a cancelled slot must hand the session back");
        assert!(
            unpublished.writes.is_empty(),
            "queued input must not reach a session the user closed the pane on"
        );
    }

    /// ...and the mark survives the reconnect trying to reopen the window,
    /// which is the ordering the two have to agree on.
    #[tokio::test]
    async fn a_cancelled_slot_refuses_to_start_another_reconnect() {
        let slot = connecting();
        *slot.lock().await = Slot::Cancelled;

        assert!(matches!(begin_reconnect(&slot).await, Reclaimed::Cancelled));
        assert!(
            matches!(&*slot.lock().await, Slot::Cancelled),
            "the mark is what closes the race; it must not be overwritten"
        );
    }

    /// `abandon` must never drop a live session on the floor — it exists for
    /// slots nothing will ever publish into.
    #[tokio::test]
    async fn abandoning_leaves_a_live_slot_alone() {
        let slot = connecting();
        assert!(publish(&slot, FakeSession::default()).await.is_none());
        abandon(&slot).await;
        assert!(
            slot.lock().await.ready().is_ok(),
            "a Ready slot holds a session that would be dropped without a clean close"
        );
    }

    /// Everything the supervisor emitted, in order, so a test can assert what
    /// the pane was actually told rather than only where it ended up.
    async fn drain(rx: &mut mpsc::Receiver<ConnectionEvent>) -> Vec<ConnectionStatus> {
        let mut seen = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let ConnectionEvent::Status(status) = event {
                seen.push(status);
            }
        }
        seen
    }

    /// The whole point of the feature: a transport that dies comes back under
    /// the *same session id*, into the same slot, without the pane knowing.
    #[tokio::test(start_paused = true)]
    async fn a_lost_transport_reconnects_into_the_same_slot() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        let script = Script::shared();
        let (tx, mut rx) = mpsc::channel(64);
        let (down_tx, down_rx) = mpsc::unbounded_channel();

        let run = tokio::spawn(supervise(
            registry.sessions.clone(),
            "fake-0".to_string(),
            slot.clone(),
            tx,
            down_rx,
            FakeConnector {
                script: script.clone(),
            },
            Some(script.factory()),
        ));

        // The first handshake lands.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(slot.lock().await.ready().is_ok());

        // The transport goes away without being asked to.
        down_tx.send(()).unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;

        assert_eq!(script.attempts(), 2, "it should have reconnected once");
        assert!(
            slot.lock().await.ready().is_ok(),
            "the same slot should now hold the new session"
        );
        // The id never moved, which is what keeps the frontend's engine,
        // scrollback, logging sink and SFTP watchers attached across the drop.
        assert!(registry.lookup("fake-0").await.is_ok());

        let statuses = drain(&mut rx).await;
        assert!(
            statuses
                .iter()
                .any(|s| matches!(s, ConnectionStatus::Reconnecting { attempt: 1, .. })),
            "the pane must be told it is coming back, not just left on 'lost': {statuses:?}"
        );

        registry.disconnect("fake-0").await.unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(5), run).await;
    }

    /// Keystrokes typed at a pane mid-reconnect are the same case as
    /// keystrokes typed at one mid-handshake, and get the same treatment for
    /// free — which is the reason `Connecting` was the right state to reuse.
    #[tokio::test(start_paused = true)]
    async fn keystrokes_typed_mid_reconnect_reach_the_new_session() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        // One failure, so there is a window to type into.
        let script = Script::failing(0);
        let (tx, _rx) = mpsc::channel(64);
        let (down_tx, down_rx) = mpsc::unbounded_channel();

        let run = tokio::spawn(supervise(
            registry.sessions.clone(),
            "fake-0".to_string(),
            slot.clone(),
            tx,
            down_rx,
            FakeConnector {
                script: script.clone(),
            },
            Some(script.factory()),
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        down_tx.send(()).unwrap();
        // Mid-backoff: the slot is Connecting again and the queue is open.
        tokio::time::sleep(Duration::from_millis(200)).await;
        registry.write("fake-0", b"whoami\n").await.unwrap();

        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(
            published(&slot).await.writes,
            vec![b"whoami\n".to_vec()],
            "what was typed while the pane was reconnecting must be delivered"
        );

        registry.disconnect("fake-0").await.unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(5), run).await;
    }

    /// An authentication failure is never retried. Each attempt spends one of
    /// the server's `MaxAuthTries`, so a background loop would lock the account
    /// out on the user's behalf.
    #[tokio::test(start_paused = true)]
    async fn a_fatal_failure_stops_the_run_rather_than_burning_attempts() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        let script = Script::shared();
        let (tx, _rx) = mpsc::channel(64);
        let (down_tx, down_rx) = mpsc::unbounded_channel();

        let run = tokio::spawn(supervise(
            registry.sessions.clone(),
            "fake-0".to_string(),
            slot.clone(),
            tx,
            down_rx,
            FakeConnector {
                script: script.clone(),
            },
            Some(script.factory()),
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        // Every attempt from here on is refused, as a credential would be.
        script.fail_first.store(u64::MAX, Ordering::Relaxed);
        script.fatal.store(true, Ordering::Relaxed);
        down_tx.send(()).unwrap();

        let _ = tokio::time::timeout(Duration::from_secs(120), run).await;
        assert_eq!(
            script.attempts(),
            2,
            "one reconnect attempt, then it must stop — not work through the budget"
        );
        assert!(registry.lookup("fake-0").await.is_err());
    }

    /// A first handshake that fails has failed. Auto-reconnect restores a
    /// session that *was* up; silently retrying a connect the user just pressed
    /// for four minutes behind a "failed" message is not what they asked for.
    #[tokio::test(start_paused = true)]
    async fn a_session_that_never_connected_is_not_retried() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        let script = Script::failing(u64::MAX);
        let (tx, _rx) = mpsc::channel(64);
        let (_down_tx, down_rx) = mpsc::unbounded_channel();

        supervise(
            registry.sessions.clone(),
            "fake-0".to_string(),
            slot.clone(),
            tx,
            down_rx,
            FakeConnector {
                script: script.clone(),
            },
            Some(script.factory()),
        )
        .await;

        assert_eq!(script.attempts(), 1);
        assert!(registry.lookup("fake-0").await.is_err());
        assert!(
            matches!(&*slot.lock().await, Slot::Cancelled),
            "a slot nothing will publish into must say so rather than queue forever"
        );
    }

    /// The run is bounded. A host that never comes back must leave the pane
    /// with a verdict rather than retrying until the process exits.
    #[tokio::test(start_paused = true)]
    async fn a_run_that_never_succeeds_gives_up_and_says_so() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        let script = Script::shared();
        let (tx, mut rx) = mpsc::channel(256);
        let (down_tx, down_rx) = mpsc::unbounded_channel();

        let run = tokio::spawn(supervise(
            registry.sessions.clone(),
            "fake-0".to_string(),
            slot.clone(),
            tx,
            down_rx,
            FakeConnector {
                script: script.clone(),
            },
            Some(script.factory()),
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        script.fail_first.store(u64::MAX, Ordering::Relaxed);
        down_tx.send(()).unwrap();

        tokio::time::timeout(Duration::from_secs(600), run)
            .await
            .expect("the run must end on its own")
            .unwrap();

        let attempts = script.attempts();
        assert!(
            attempts <= RECONNECT_MAX_ATTEMPTS as u64 + 1,
            "the attempt bound was not honoured: {attempts} attempts"
        );
        assert!(registry.lookup("fake-0").await.is_err());

        let statuses = drain(&mut rx).await;
        assert!(
            statuses.iter().any(|s| matches!(
                s,
                ConnectionStatus::Failed(msg) if msg.starts_with("could not reconnect")
            )),
            "giving up has to be reported, not silent: {statuses:?}"
        );
    }

    /// Closing a pane mid-backoff stops the run then and there, rather than
    /// letting it wake up and connect to a host nobody is watching.
    #[tokio::test(start_paused = true)]
    async fn closing_a_pane_during_the_backoff_ends_the_run() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        let script = Script::shared();
        let (tx, _rx) = mpsc::channel(64);
        let (down_tx, down_rx) = mpsc::unbounded_channel();

        let run = tokio::spawn(supervise(
            registry.sessions.clone(),
            "fake-0".to_string(),
            slot.clone(),
            tx,
            down_rx,
            FakeConnector {
                script: script.clone(),
            },
            Some(script.factory()),
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        // Long enough that the pane can close well inside the wait.
        script.fail_first.store(6, Ordering::Relaxed);
        down_tx.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;

        registry.disconnect("fake-0").await.unwrap();
        let after_close = script.attempts();

        tokio::time::timeout(Duration::from_secs(120), run)
            .await
            .expect("the run must notice the pane is gone")
            .unwrap();
        assert_eq!(
            script.attempts(),
            after_close,
            "no attempt may be made after the pane was closed"
        );
    }

    /// A session with no factory — an SSH profile whose credential has to be
    /// asked for each time — reports the drop and stops, rather than sprouting
    /// a password dialog at 3am because a link flapped.
    #[tokio::test(start_paused = true)]
    async fn a_session_that_cannot_reconnect_unattended_simply_stops() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        let script = Script::shared();
        let (tx, _rx) = mpsc::channel(64);
        let (down_tx, down_rx) = mpsc::unbounded_channel();

        let run = tokio::spawn(supervise::<
            FakeConnector,
            fn() -> std::future::Ready<Result<FakeConnector, String>>,
            _,
        >(
            registry.sessions.clone(),
            "fake-0".to_string(),
            slot.clone(),
            tx,
            down_rx,
            FakeConnector {
                script: script.clone(),
            },
            None,
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        down_tx.send(()).unwrap();

        tokio::time::timeout(Duration::from_secs(60), run)
            .await
            .expect("the run must end")
            .unwrap();
        assert_eq!(script.attempts(), 1, "no unattended retry may be made");
    }
}
