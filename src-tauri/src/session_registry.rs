//! The transport-independent part of the session command layer: the session
//! map, id counter, lookup, write/resize/disconnect, and the connect and
//! reconnect supervisor, generic over `wr_core`'s `Connector`/`Session`.
//!
//! The `#[tauri::command]` functions stay in `ssh.rs`, `telnet.rs` and
//! `serial.rs` (`generate_handler!` can't take generics) and delegate here.
//! Transport-specific state, such as SSH's host-key prompts and forwards or
//! serial's line controls, lives with the transport.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, Mutex as TokioMutex};
use wr_core::{ConnectionEvent, ConnectionStatus, Connector, Session};

/// Pre-connect input held before further input is refused. Far more than
/// anyone types during a handshake; it bounds a paste into a pane whose
/// host-key prompt sits unanswered.
const MAX_PENDING_INPUT: usize = 64 * 1024;

/// A session id's occupant. The id exists from the moment the frontend gets
/// it; until the handshake finishes, input and resizes are queued here and
/// replayed into the new session.
pub enum Slot<S> {
    Connecting {
        /// Keystrokes typed before the session existed, in order.
        input: Vec<u8>,
        /// Last size only; the PTY only cares where a drag ended.
        size: Option<(u16, u16)>,
    },
    Ready {
        session: S,
        /// The size this session was last told about, kept so a reconnect opens
        /// its PTY at the current size (see [`begin_reconnect`]).
        size: Option<(u16, u16)>,
    },
    /// Disconnected while still handshaking. Marks the slot so a handshake that
    /// finishes afterward knows it's unwanted; see [`publish_if_wanted`].
    Cancelled,
}

impl<S> Slot<S> {
    /// The connected session, or the error the frontend sees for one that is
    /// still handshaking.
    pub fn ready(&self) -> Result<&S, String> {
        match self {
            Slot::Ready { session, .. } => Ok(session),
            // Also the answer mid-reconnect.
            Slot::Connecting { .. } => Err("session is still connecting".to_string()),
            // Only via a slot handle cloned before the disconnect removed it.
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

/// Publishes a freshly connected session into its slot, unless the id was
/// disconnected during the handshake, in which case the session is closed
/// cleanly and its queued input discarded.
///
/// The map lock covers only the membership check, so one session's replay
/// (which may block on a full SSH window) can't stall every other session of
/// the transport. A `disconnect` landing between the check and the replay is
/// handled under the slot lock: `disconnect` marks the slot
/// [`Slot::Cancelled`] and `publish` refuses to replay into a marked one.
///
/// Returns whether the session was published; `false` tells the supervisor
/// the pane is gone.
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
    // Canceled before we looked, or between the look and the slot lock. Close
    // it properly (for SSH, an `SSH_MSG_DISCONNECT`) rather than dropping it.
    if let Some(mut session) = unwanted {
        let _ = session.disconnect().await;
        return false;
    }
    true
}

/// Drains whatever arrived during the handshake into the new session, then
/// publishes it. Returns the session unpublished if the slot was canceled.
/// Separate so the replay can be tested without a real transport.
async fn publish<S: Session>(slot: &SharedSlot<S>, mut session: S) -> Option<S> {
    // Held across the check and the replay, so nothing is enqueued or canceled
    // in between.
    let mut slot = slot.lock().await;
    let (pending_input, pending_size) = match &mut *slot {
        Slot::Cancelled => return Some(session),
        Slot::Connecting { input, size } => (std::mem::take(input), size.take()),
        // Unreachable: a reconnect resets the slot to `Connecting` first.
        Slot::Ready { .. } => (Vec::new(), None),
    };
    // Size first, so the program's response isn't reflowed afterward.
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

/// Takes a live slot back to `Connecting` so a reconnect queues input like
/// the first handshake did. The session id stays the same, so everything keyed
/// on it (engine, scrollback, logging, SFTP watches, coalescer credit)
/// survives the reconnect. Returns the dead session for the caller to close.
async fn begin_reconnect<S>(slot: &SharedSlot<S>) -> Reclaimed<S> {
    let mut guard = slot.lock().await;
    // The pane closed in the meantime; leave the mark in place.
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
        // No transport reports a drop before publishing.
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

/// Marks a slot that will never receive a session, so handles to it report
/// "disconnected" rather than "still connecting" forever. Only replaces a
/// `Connecting` slot; a `Ready` one would lose its session without a clean
/// close.
async fn abandon<S>(slot: &SharedSlot<S>) {
    let mut guard = slot.lock().await;
    if matches!(&*guard, Slot::Connecting { .. }) {
        *guard = Slot::Cancelled;
    }
}

/// How often the pre-connect step checks for cancellation. Polled, since half
/// a second of latency on a closed pane doesn't matter.
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Resolves once `session_id` is gone from the map (the pane was closed).
async fn removed<S>(sessions: &SlotMap<S>, session_id: &str) {
    loop {
        tokio::time::sleep(CANCEL_POLL_INTERVAL).await;
        if !sessions.lock().await.contains_key(session_id) {
            return;
        }
    }
}

/// The type `None` needs when there is no pre-connect step (a closure type
/// can't be named).
pub type NoPrepare = fn(mpsc::Sender<ConnectionEvent>) -> std::future::Ready<Result<(), String>>;

/// What has happened to the connection under a session id that stays put,
/// for things bound to the connection rather than the id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportPhase {
    /// The transport died. Fires even for sessions that won't reconnect.
    Lost,
    /// A reconnect published a new session.
    Restored,
}

/// The type `None` needs when nothing is attached to a connection (telnet,
/// serial).
pub type NoRestore = fn(TransportPhase) -> std::future::Ready<()>;

/// The type `None` needs for a transport that must never be rebuilt
/// unattended (elevated tabs: each rebuild is a UAC prompt). Windows only.
#[cfg_attr(not(windows), allow(dead_code))]
pub type NoReconnect<C> = fn() -> std::future::Ready<Result<C, String>>;

/// The pause before the first retry, doubling from there. Most drops are a
/// few seconds of wifi; an immediate retry would land while the interface is
/// still down.
const RECONNECT_BASE_DELAY: Duration = Duration::from_secs(1);

/// The ceiling the doubling stops at.
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(30);

/// Default attempts per run; about four minutes with the schedule above.
const RECONNECT_MAX_ATTEMPTS: u32 = 12;

/// Default wall-clock bound per run. Both bounds are needed: the count alone
/// lets a saturated schedule run long, the clock alone allows unlimited fast
/// early attempts.
const RECONNECT_MAX_ELAPSED_SECONDS: u64 = 300;

/// The range a caller-supplied attempt bound is clamped to. At least one,
/// since zero would mean "off" (that's [`ReconnectPolicy::enabled`]); the cap
/// guards against a corrupt settings blob.
const ATTEMPTS_RANGE: std::ops::RangeInclusive<u32> = 1..=100;

/// The range for the wall-clock bound, in seconds; below five the budget would
/// be spent before the first retry.
const ELAPSED_SECONDS_RANGE: std::ops::RangeInclusive<u64> = 5..=3600;

/// What a reconnect run may spend, and whether it may run at all. Comes from
/// the webview, so it's clamped by [`Self::sanitized`]; absent fields take the
/// defaults. The policy can only disable reconnects, never enable one the
/// backend refused (e.g. a typed credential; see `ssh.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReconnectPolicy {
    /// Whether an unattended reconnect may be attempted at all (globally or per
    /// profile).
    pub enabled: bool,
    /// Consecutive attempts one run gets before it gives up.
    pub max_attempts: u32,
    /// The wall clock the same run may spend, whichever binds first.
    pub max_elapsed_seconds: u64,
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            max_attempts: RECONNECT_MAX_ATTEMPTS,
            max_elapsed_seconds: RECONNECT_MAX_ELAPSED_SECONDS,
        }
    }
}

impl ReconnectPolicy {
    /// The policy with both bounds clamped to safe ranges. Clamped rather than
    /// rejected so a bad settings value doesn't stop the session opening.
    pub fn sanitized(self) -> Self {
        Self {
            enabled: self.enabled,
            max_attempts: self
                .max_attempts
                .clamp(*ATTEMPTS_RANGE.start(), *ATTEMPTS_RANGE.end()),
            max_elapsed_seconds: self
                .max_elapsed_seconds
                .clamp(*ELAPSED_SECONDS_RANGE.start(), *ELAPSED_SECONDS_RANGE.end()),
        }
    }

    fn max_elapsed(&self) -> Duration {
        Duration::from_secs(self.max_elapsed_seconds)
    }

    /// How long to wait before `attempt`, or `None` once the run has spent
    /// either bound.
    fn next_delay(&self, attempt: u32, elapsed: Duration) -> Option<Duration> {
        if attempt > self.max_attempts || elapsed >= self.max_elapsed() {
            return None;
        }
        Some(jittered(backoff_delay(attempt), clock_spread()))
    }
}

/// How far either side of the nominal delay a retry may land. Matters because
/// failures are often shared (a switch reboots), and panes shouldn't retry in
/// lockstep.
const RECONNECT_JITTER: f64 = 0.2;

/// The nominal pause before `attempt` (counting from 1), before jitter.
fn backoff_delay(attempt: u32) -> Duration {
    // Saturating: the shift overflows at attempt 33.
    let factor = 1u32
        .checked_shl(attempt.saturating_sub(1))
        .unwrap_or(u32::MAX);
    RECONNECT_BASE_DELAY
        .saturating_mul(factor)
        .min(RECONNECT_MAX_DELAY)
}

/// `delay` moved by up to [`RECONNECT_JITTER`] of itself; `spread` is clamped
/// to `[-1.0, 1.0]`.
fn jittered(delay: Duration, spread: f64) -> Duration {
    let scale = 1.0 + RECONNECT_JITTER * spread.clamp(-1.0, 1.0);
    delay.mul_f64(scale)
}

/// A spread in `[-1.0, 1.0]` from the clock's nanoseconds. Enough to keep
/// panes from retrying in the same millisecond; not a security decision.
fn clock_spread() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos % 2001) as f64 / 1000.0 - 1.0
}

/// The delay in whole seconds for the status line, never zero.
fn countdown_seconds(delay: Duration) -> u64 {
    (delay.as_secs_f64().round() as u64).max(1)
}

/// One session id's slot, shared between the command layer and the connect
/// task that fills it in.
type SharedSlot<S> = Arc<TokioMutex<Slot<S>>>;

/// Every live slot of one transport, by id.
type SlotMap<S> = Arc<TokioMutex<HashMap<String, SharedSlot<S>>>>;

/// Live sessions of one transport, keyed by the id handed to the frontend.
/// The map is behind an `Arc` so the connect task can hold it directly.
pub struct SessionRegistry<C: Connector> {
    sessions: SlotMap<C::Session>,
    next_id: AtomicU64,
    /// The id prefix (`"ssh"`, `"telnet"`, `"serial"`), which also keeps ids
    /// unique across transports.
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

    /// The slot for `session_id`. Returns the slot rather than the session since a
    /// caller may arrive mid-handshake; `Slot::ready` checks for a session.
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
                // Refused rather than truncated: half a paste is worse than none.
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
            // Recorded so a reconnect knows the current size.
            Slot::Ready { session, size } => {
                *size = Some((cols, rows));
                session.resize(cols, rows).await.map_err(|e| e.to_string())
            }
            Slot::Cancelled => Err("session was disconnected".to_string()),
        }
    }

    /// Removes the session from the map, then disconnects it; it's gone even if
    /// the close fails. A session still handshaking is marked
    /// [`Slot::Cancelled`] so queued input is never replayed into it; see
    /// [`publish_if_wanted`].
    pub async fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let slot = self.sessions.lock().await.remove(session_id);
        if let Some(slot) = slot {
            let mut slot = slot.lock().await;
            match &mut *slot {
                Slot::Ready { session, .. } => {
                    session.disconnect().await.map_err(|e| e.to_string())?
                }
                // Queued input is discarded with it.
                Slot::Connecting { .. } => *slot = Slot::Cancelled,
                Slot::Cancelled => {}
            }
        }
        Ok(())
    }

    /// Registers `session_id` as connecting, then drives the handshake (and any
    /// reconnects) on a spawned task while forwarding events to the frontend.
    /// Returns immediately.
    ///
    /// - `make_status` builds the transport's own event type.
    /// - `prepare` runs before the first handshake and can refuse it. It's for
    ///   Wake-on-LAN, which can take a minute: here it reports progress through the
    ///   same event channel and is canceled if the pane closes.
    /// - `reconnect` builds a fresh connector per retry, re-resolving from the
    ///   profile so edits take effect and credentials aren't held for the session's
    ///   lifetime. `None` opts out of auto-reconnect (e.g. a credential that must be
    ///   typed; see `ssh.rs`).
    /// - `on_transport` reports connection loss and restoration for things bound to
    ///   the connection (SSH's port forwards). Never fires for the first connect.
    /// - `policy` can only disable reconnects; see [`ReconnectPolicy`].
    // The last four arguments are optional capabilities; a struct would just be
    // built and destructured.
    #[allow(clippy::too_many_arguments)]
    pub async fn spawn_connect<E, F, P, Fut, MakeC, MakeFut, R, RFut>(
        &self,
        app: AppHandle,
        session_id: String,
        connector: C,
        channel: Channel<E>,
        data_channel: Channel<InvokeResponseBody>,
        make_status: F,
        prepare: Option<P>,
        reconnect: Option<MakeC>,
        on_transport: Option<R>,
        policy: ReconnectPolicy,
    ) where
        E: Serialize + Clone + Send + 'static,
        F: Fn(&ConnectionStatus) -> E + Send + 'static,
        P: FnOnce(mpsc::Sender<ConnectionEvent>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<(), String>> + Send,
        // `Sync` because the supervisor holds the factory across awaits.
        MakeC: Fn() -> MakeFut + Send + Sync + 'static,
        MakeFut: std::future::Future<Output = Result<C, String>> + Send,
        R: Fn(TransportPhase) -> RFut + Send + Sync + 'static,
        RFut: std::future::Future<Output = ()> + Send,
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

            // How the supervisor learns the transport died. Unbounded because it is
            // sent from a synchronous observer on the output path that must not block.
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
                    // Only `Lost`; an exited shell shouldn't be reconnected (see
                    // `DisconnectKind`).
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
                    // The pane closed; `disconnect` already removed the id.
                    _ = removed(&sessions, &session_id) => {
                        drop(forward);
                        return;
                    }
                };
                if let Err(message) = outcome {
                    // The transport never ran, so nothing has reported this yet.
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
                sessions,
                session_id,
                slot,
                tx,
                down_rx,
                connector,
                reconnect,
                on_transport,
                policy,
            )
            .await;

            // Each session's output pump runs on its own; let the forwarder drain.
            drop(forward);
        });
    }
}

/// One session id's whole life: the first handshake and, while the pane is
/// open, every reconnect after an unrequested drop.
///
/// A pane closed while a reconnect is in flight must not have queued input
/// replayed into the new session: [`SessionRegistry::disconnect`] marks the
/// slot under its lock, [`begin_reconnect`] won't leave a marked slot, and
/// `publish` won't fill one. Map membership is re-checked at every wait
/// (handshake, live session, backoff).
// Owned so it can run as its own task, which is how the tests drive it.
#[allow(clippy::too_many_arguments)]
async fn supervise<C, MakeC, MakeFut, R, RFut>(
    sessions: SlotMap<C::Session>,
    session_id: String,
    slot: SharedSlot<C::Session>,
    tx: mpsc::Sender<ConnectionEvent>,
    mut down_rx: mpsc::UnboundedReceiver<()>,
    connector: C,
    reconnect: Option<MakeC>,
    on_transport: Option<R>,
    policy: ReconnectPolicy,
) where
    C: Connector,
    MakeC: Fn() -> MakeFut,
    MakeFut: std::future::Future<Output = Result<C, String>>,
    R: Fn(TransportPhase) -> RFut,
    RFut: std::future::Future<Output = ()>,
{
    let sessions = &sessions;
    let session_id = session_id.as_str();
    let slot = &slot;
    let tx = &tx;
    // The user's off switch removes the factory, so an opted-out session is the
    // same as one that can't reconnect unattended.
    let reconnect = policy.enabled.then_some(reconnect).flatten();
    let reconnect = reconnect.as_ref();
    let on_transport = on_transport.as_ref();
    // Attempt zero uses the caller's connector; later ones use the factory.
    let mut pending = Some(connector);
    // Only a session that was up gets reconnected; a failed first handshake
    // just fails.
    let mut ever_connected = false;
    // Consecutive failures and when the run began; both reset on success.
    let mut attempt: u32 = 0;
    let mut run_started = std::time::Instant::now();
    // Why the last attempt couldn't build a connector, for the final message
    // (not reported per attempt, which would toast each one).
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
                    // Not fatal: a serial adapter not yet plugged back in, or a locked
                    // vault, both look like this and may resolve within the window.
                    Err(message) => {
                        build_error = Some(message);
                        // Straight to the backoff; this still spends an attempt.
                        if let Some(delay) =
                            schedule_retry(tx, &mut attempt, run_started.elapsed(), &policy).await
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

        // No lock held: the handshake can wait on a human without blocking input.
        match connector.connect(tx.clone()).await {
            Ok(session) => {
                if !publish_if_wanted(sessions, session_id, slot, session).await {
                    // The pane went away mid-handshake.
                    return;
                }
                let reconnected = ever_connected;
                ever_connected = true;
                attempt = 0;
                run_started = std::time::Instant::now();

                // Only after a reconnect. Awaited rather than spawned, so a second drop
                // during the restore is seen after it rather than raced (a forward could
                // otherwise be re-established on a dead handle).
                if reconnected {
                    if let Some(on_transport) = on_transport {
                        on_transport(TransportPhase::Restored).await;
                    }
                }

                // Wait for this session to end, or for the pane to close.
                tokio::select! {
                    // `None`: the forwarder (and so the webview) is gone.
                    down = down_rx.recv() => if down.is_none() { return },
                    _ = removed(sessions, session_id) => return,
                }

                // Only `Lost` reaches `down_rx`. Report the loss even if no retry follows:
                // e.g. a port forward's listener would otherwise look healthy while
                // carrying nothing.
                if let Some(on_transport) = on_transport {
                    on_transport(TransportPhase::Lost).await;
                }
                if reconnect.is_none() {
                    return;
                }
                match begin_reconnect(slot).await {
                    Reclaimed::Displaced(mut dead) => {
                        // Closed rather than dropped; this also resets the SFTP cells so the
                        // new session doesn't hand out dead channels.
                        let _ = dead.disconnect().await;
                    }
                    Reclaimed::Cancelled => return,
                    Reclaimed::Nothing => {}
                }
            }
            Err(error) => {
                // `connect` already reported the reason.
                if !ever_connected || reconnect.is_none() || !C::retryable(&error) {
                    sessions.lock().await.remove(session_id);
                    abandon(slot).await;
                    return;
                }
                // The slot is still `Connecting`, so input keeps queueing across the retry.
            }
        }

        let Some(delay) = schedule_retry(tx, &mut attempt, run_started.elapsed(), &policy).await
        else {
            give_up(sessions, session_id, slot, tx, attempt, build_error).await;
            return;
        };

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = removed(sessions, session_id) => return,
        }
    }
}

/// Counts an attempt, announces the wait, and returns it, or `None` when the
/// budget is spent.
async fn schedule_retry(
    tx: &mpsc::Sender<ConnectionEvent>,
    attempt: &mut u32,
    elapsed: Duration,
    policy: &ReconnectPolicy,
) -> Option<Duration> {
    *attempt += 1;
    let delay = policy.next_delay(*attempt, elapsed)?;
    let _ = tx
        .send(ConnectionEvent::Status(ConnectionStatus::Reconnecting {
            attempt: *attempt,
            in_seconds: countdown_seconds(delay),
        }))
        .await;
    Some(delay)
}

/// Ends a reconnect run: reports it, drops the id, and marks the slot.
async fn give_up<S: Session>(
    sessions: &SlotMap<S>,
    session_id: &str,
    slot: &SharedSlot<S>,
    tx: &mpsc::Sender<ConnectionEvent>,
    attempts: u32,
    last_error: Option<String>,
) {
    // One message for the run, with the most recent error.
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

    /// Records what reached the transport, in order.
    #[derive(Default)]
    struct FakeSession {
        writes: Vec<Vec<u8>>,
        sizes: Vec<(u16, u16)>,
        /// Set by `disconnect`, to tell a clean close from a `Drop`.
        disconnected: Arc<std::sync::atomic::AtomicBool>,
    }

    /// Carries its own retryability so one fake connector can produce both kinds.
    #[derive(Debug)]
    struct FakeError {
        retryable: bool,
    }

    impl FakeError {
        fn transient() -> Self {
            Self { retryable: true }
        }

        /// A rejected credential: retrying spends the server's `MaxAuthTries`.
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

    /// A slot's state, for panic messages.
    fn describe(slot: &Slot<FakeSession>) -> &'static str {
        match slot {
            Slot::Connecting { .. } => "connecting",
            Slot::Ready { .. } => "ready",
            Slot::Cancelled => "canceled",
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

    /// Typing at a pane that's still connecting isn't lost.
    #[tokio::test]
    async fn keystrokes_typed_during_the_handshake_are_delivered() {
        let slot = connecting();
        enqueue(&slot, b"who").await;
        enqueue(&slot, b"ami\n").await;

        assert!(publish(&slot, FakeSession::default()).await.is_none());

        assert_eq!(published(&slot).await.writes, vec![b"whoami\n".to_vec()]);
    }

    /// A resize during the handshake is applied.
    #[tokio::test]
    async fn a_resize_during_the_handshake_is_applied() {
        let slot = connecting();
        enqueue_size(&slot, 120, 40).await;

        assert!(publish(&slot, FakeSession::default()).await.is_none());

        assert_eq!(published(&slot).await.sizes, vec![(120, 40)]);
    }

    /// Only the last size is replayed.
    #[tokio::test]
    async fn only_the_final_size_is_replayed() {
        let slot = connecting();
        enqueue_size(&slot, 80, 24).await;
        enqueue_size(&slot, 100, 30).await;
        enqueue_size(&slot, 120, 40).await;

        assert!(publish(&slot, FakeSession::default()).await.is_none());

        assert_eq!(published(&slot).await.sizes, vec![(120, 40)]);
    }

    /// Resize before write, so the program answers at the new size.
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

    /// Nothing queued means nothing sent.
    #[tokio::test]
    async fn an_idle_handshake_replays_nothing() {
        let slot = connecting();
        assert!(publish(&slot, FakeSession::default()).await.is_none());

        let session = published(&slot).await;
        assert!(session.writes.is_empty());
        assert!(session.sizes.is_empty());
    }

    /// A connector that fails a scripted number of times before succeeding, for
    /// driving the reconnect loop without a transport.
    struct FakeConnector {
        script: Arc<Script>,
    }

    /// Shared by every connector a factory builds, so attempts count across them.
    #[derive(Default)]
    struct Script {
        /// How many attempts to fail before the next one succeeds.
        fail_first: AtomicU64,
        /// Whether those failures are worth retrying.
        fatal: std::sync::atomic::AtomicBool,
        /// Every `connect` call, successful or not.
        attempts: AtomicU64,
        /// Set by the session's `disconnect`.
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

        /// A factory of the shape `spawn_connect` takes, drawing from this script.
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
                .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1))
                .is_ok()
            {
                // Real connectors report their own failure from inside `connect`.
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

    /// A paste into a pane stuck at its host-key prompt must not grow unbounded.
    #[tokio::test]
    async fn the_pre_connect_queue_is_capped() {
        let registry = registry_with_connecting_slot("fake-0").await;

        assert!(registry.write("fake-0", &vec![b'x'; 1024]).await.is_ok());

        // Past the cap: refused whole.
        let huge = vec![b'x'; MAX_PENDING_INPUT];
        assert!(registry.write("fake-0", &huge).await.is_err());

        // Earlier input stays queued.
        let slot = registry.lookup("fake-0").await.unwrap();
        let queued = match &*slot.lock().await {
            Slot::Connecting { input, .. } => input.len(),
            other => panic!("should still be connecting, was {}", describe(other)),
        };
        assert_eq!(queued, 1024);
    }

    /// Once connected, large writes go straight to the transport.
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

    /// A pane closed during the handshake must not have its queued input (maybe a
    /// password) sent to the host.
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

        assert!(
            slot.lock().await.ready().is_err(),
            "a canceled slot must not receive the session"
        );
        assert!(
            disconnected.load(Ordering::Relaxed),
            "expected a clean disconnect, not a bare Drop"
        );
    }

    /// An id that's still registered gets its session and queued input.
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

    /// `disconnect` landing after the membership check passed still wins via the
    /// slot mark.
    #[tokio::test]
    async fn a_disconnect_after_the_membership_check_still_wins() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        registry.write("fake-0", b"hunter2\n").await.unwrap();

        // The membership check passes...
        assert!(registry.sessions.lock().await.contains_key("fake-0"));

        // ...then the pane closes before the publish.
        registry.disconnect("fake-0").await.unwrap();

        let disconnected = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let session = FakeSession {
            disconnected: disconnected.clone(),
            ..Default::default()
        };
        let unpublished = publish(&slot, session).await;

        let unpublished = unpublished.expect("a canceled slot must hand the session back");
        assert!(
            unpublished.writes.is_empty(),
            "queued input must not reach a host the user canceled"
        );
        assert!(slot.lock().await.ready().is_err());
    }

    /// The same race through `publish_if_wanted`.
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

    /// Disconnecting a connecting id marks its slot, which is what handles cloned
    /// before the removal (e.g. via `Slot::ready`) see.
    #[tokio::test]
    async fn disconnecting_a_connecting_id_marks_its_slot() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        registry.write("fake-0", b"queued").await.unwrap();

        registry.disconnect("fake-0").await.unwrap();

        match &*slot.lock().await {
            Slot::Cancelled => {}
            other => panic!("expected a canceled slot, was {}", describe(other)),
        }
        assert!(slot.lock().await.ready().is_err());
        // The id is gone from the map too.
        assert!(registry.write("fake-0", b"x").await.is_err());
        assert!(registry.resize("fake-0", 80, 24).await.is_err());
    }

    /// A connecting slot reports an error rather than blocking.
    #[tokio::test]
    async fn ready_reports_a_connecting_slot_rather_than_blocking() {
        let slot = connecting();
        assert!(slot.lock().await.ready().is_err());

        assert!(publish(&slot, FakeSession::default()).await.is_none());
        assert!(slot.lock().await.ready().is_ok());
    }

    // ---- auto-reconnect ----------------------------------------------------

    /// The exact schedule: doubling from one second, capped at thirty.
    #[test]
    fn the_backoff_doubles_and_then_stops_doubling() {
        let seconds: Vec<u64> = (1..=8).map(|n| backoff_delay(n).as_secs()).collect();
        assert_eq!(seconds, vec![1, 2, 4, 8, 16, 30, 30, 30]);
    }

    /// The shift overflows at attempt 33; it must not panic.
    #[test]
    fn an_absurd_attempt_number_still_yields_the_cap() {
        assert_eq!(backoff_delay(u32::MAX), RECONNECT_MAX_DELAY);
    }

    /// Jitter stays inside its band in both directions.
    #[test]
    fn jitter_stays_within_its_band() {
        let base = Duration::from_secs(10);
        assert_eq!(jittered(base, 0.0), base);
        assert_eq!(jittered(base, 1.0), Duration::from_secs(12));
        assert_eq!(jittered(base, -1.0), Duration::from_secs(8));
        // Out-of-range input is clamped.
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

    /// Each bound ends the run on its own.
    #[test]
    fn a_run_is_bounded_by_attempts_and_by_the_clock_separately() {
        let policy = ReconnectPolicy::default();
        assert!(policy
            .next_delay(policy.max_attempts, Duration::ZERO)
            .is_some());
        assert!(policy
            .next_delay(policy.max_attempts + 1, Duration::ZERO)
            .is_none());
        assert!(policy.next_delay(1, policy.max_elapsed()).is_none());
    }

    /// Shortening either bound alone must end the run sooner.
    #[test]
    fn a_shortened_bound_is_the_one_that_binds() {
        let fewer = ReconnectPolicy {
            max_attempts: 3,
            ..ReconnectPolicy::default()
        };
        assert!(fewer.next_delay(3, Duration::ZERO).is_some());
        assert!(fewer.next_delay(4, Duration::ZERO).is_none());

        let briefer = ReconnectPolicy {
            max_elapsed_seconds: 30,
            ..ReconnectPolicy::default()
        };
        assert!(briefer.next_delay(1, Duration::from_secs(29)).is_some());
        assert!(briefer.next_delay(1, Duration::from_secs(30)).is_none());
    }

    /// Loop bounds from the webview are clamped to their ranges.
    #[test]
    fn a_policy_off_the_wire_is_clamped_rather_than_refused() {
        let absurd = ReconnectPolicy {
            enabled: true,
            max_attempts: u32::MAX,
            max_elapsed_seconds: u64::MAX,
        }
        .sanitized();
        assert_eq!(absurd.max_attempts, *ATTEMPTS_RANGE.end());
        assert_eq!(absurd.max_elapsed_seconds, *ELAPSED_SECONDS_RANGE.end());

        // Zero means disabled, not a shorter bound, so it clamps up.
        let zeroed = ReconnectPolicy {
            enabled: true,
            max_attempts: 0,
            max_elapsed_seconds: 0,
        }
        .sanitized();
        assert_eq!(zeroed.max_attempts, *ATTEMPTS_RANGE.start());
        assert_eq!(zeroed.max_elapsed_seconds, *ELAPSED_SECONDS_RANGE.start());
        assert!(
            zeroed.enabled,
            "clamping a bound must not change the switch"
        );
    }

    /// Absent fields keep their defaults.
    #[test]
    fn an_absent_field_keeps_the_default() {
        let partial: ReconnectPolicy = serde_json::from_str(r#"{"maxAttempts": 4}"#).unwrap();
        assert_eq!(partial.max_attempts, 4);
        assert_eq!(
            partial.max_elapsed_seconds,
            ReconnectPolicy::default().max_elapsed_seconds
        );
        assert!(partial.enabled);

        let empty: ReconnectPolicy = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, ReconnectPolicy::default());
    }

    /// Jitter often puts the first step under half a second; never show "0s".
    #[test]
    fn the_countdown_never_reads_zero() {
        assert_eq!(countdown_seconds(Duration::from_millis(1)), 1);
        assert_eq!(countdown_seconds(Duration::from_millis(400)), 1);
        assert_eq!(countdown_seconds(Duration::from_millis(1600)), 2);
    }

    /// A reconnect reopens at the pane's current size, not its original one.
    #[tokio::test]
    async fn a_reconnect_carries_the_panes_current_size_forward() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        assert!(publish(&slot, FakeSession::default()).await.is_none());

        registry.resize("fake-0", 200, 60).await.unwrap();

        let Reclaimed::Displaced(_) = begin_reconnect(&slot).await else {
            panic!("expected the live session to be displaced");
        };

        // The new window already knows the size.
        assert!(publish(&slot, FakeSession::default()).await.is_none());
        assert_eq!(published(&slot).await.sizes, vec![(200, 60)]);
    }

    /// A pane closed mid-reconnect must not have queued input replayed into the
    /// new session.
    #[tokio::test]
    async fn a_pane_closed_mid_reconnect_never_receives_its_queued_input() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        assert!(publish(&slot, FakeSession::default()).await.is_none());

        let Reclaimed::Displaced(_) = begin_reconnect(&slot).await else {
            panic!("expected the live session to be displaced");
        };
        // Typed into the reconnecting pane...
        registry.write("fake-0", b"hunter2\n").await.unwrap();
        // ...then closed before the handshake lands.
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

        let unpublished = unpublished.expect("a canceled slot must hand the session back");
        assert!(
            unpublished.writes.is_empty(),
            "queued input must not reach a session the user closed the pane on"
        );
    }

    /// The cancel mark survives an attempt to reopen the window.
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

    /// `abandon` never drops a live session.
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

    /// Every status the supervisor emitted, in order.
    async fn drain(rx: &mut mpsc::Receiver<ConnectionEvent>) -> Vec<ConnectionStatus> {
        let mut seen = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let ConnectionEvent::Status(status) = event {
                seen.push(status);
            }
        }
        seen
    }

    /// A dropped transport comes back under the same id, in the same slot.
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
            None::<NoRestore>,
            ReconnectPolicy::default(),
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(slot.lock().await.ready().is_ok());

        down_tx.send(()).unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;

        assert_eq!(script.attempts(), 2, "it should have reconnected once");
        assert!(
            slot.lock().await.ready().is_ok(),
            "the same slot should now hold the new session"
        );
        // The id never moved.
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

    /// Every phase the transport hook was told about, in order.
    type PhaseLog = Arc<std::sync::Mutex<Vec<TransportPhase>>>;

    fn phase_recorder(log: PhaseLog) -> impl Fn(TransportPhase) -> std::future::Ready<()> {
        move |phase| {
            log.lock().unwrap().push(phase);
            std::future::ready(())
        }
    }

    /// The hook reports `Lost` then `Restored`, and nothing on the first connect.
    /// SSH marks forwards dead on `Lost`; reporting only `Restored` left them
    /// looking healthy for the whole outage.
    #[tokio::test(start_paused = true)]
    async fn the_transport_hook_reports_the_loss_before_the_replacement() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        let script = Script::shared();
        let (tx, _rx) = mpsc::channel(64);
        let (down_tx, down_rx) = mpsc::unbounded_channel();

        let log: PhaseLog = Arc::new(std::sync::Mutex::new(Vec::new()));

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
            Some(phase_recorder(log.clone())),
            ReconnectPolicy::default(),
        ));

        // The first connect reports nothing.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(slot.lock().await.ready().is_ok());
        assert!(
            log.lock().unwrap().is_empty(),
            "a first connect has nothing attached to it yet"
        );

        down_tx.send(()).unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;

        assert!(
            slot.lock().await.ready().is_ok(),
            "it should have come back"
        );
        assert_eq!(
            *log.lock().unwrap(),
            vec![TransportPhase::Lost, TransportPhase::Restored],
            "the loss must be reported when it happens, not implied by the recovery"
        );

        registry.disconnect("fake-0").await.unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(5), run).await;
    }

    /// A session that can't reconnect still reports `Lost`, or its forwards would
    /// look live forever.
    #[tokio::test(start_paused = true)]
    async fn a_session_that_cannot_reconnect_still_reports_the_loss() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        let script = Script::shared();
        let (tx, _rx) = mpsc::channel(64);
        let (down_tx, down_rx) = mpsc::unbounded_channel();

        let log: PhaseLog = Arc::new(std::sync::Mutex::new(Vec::new()));

        let run = tokio::spawn(supervise::<
            FakeConnector,
            fn() -> std::future::Ready<Result<FakeConnector, String>>,
            _,
            _,
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
            Some(phase_recorder(log.clone())),
            ReconnectPolicy::default(),
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        down_tx.send(()).unwrap();

        tokio::time::timeout(Duration::from_secs(60), run)
            .await
            .expect("the run must end")
            .unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            vec![TransportPhase::Lost],
            "the loss is reported even though nothing will replace it"
        );
    }

    /// Input typed mid-reconnect reaches the new session, as mid-handshake does.
    #[tokio::test(start_paused = true)]
    async fn keystrokes_typed_mid_reconnect_reach_the_new_session() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
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
            None::<NoRestore>,
            ReconnectPolicy::default(),
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        down_tx.send(()).unwrap();
        // Mid-backoff: the queue is open.
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

    /// Auth failures aren't retried: each attempt spends the server's
    /// `MaxAuthTries`.
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
            None::<NoRestore>,
            ReconnectPolicy::default(),
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        // From here on every attempt is refused, as a credential would be.
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

    /// A failed first handshake is not retried.
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
            None::<NoRestore>,
            ReconnectPolicy::default(),
        )
        .await;

        assert_eq!(script.attempts(), 1);
        assert!(registry.lookup("fake-0").await.is_err());
        assert!(
            matches!(&*slot.lock().await, Slot::Cancelled),
            "a slot nothing will publish into must say so rather than queue forever"
        );
    }

    /// A host that never comes back ends the run with a reported failure.
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
            None::<NoRestore>,
            ReconnectPolicy::default(),
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
            "the attempt bound was not honored: {attempts} attempts"
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

    /// Closing the pane mid-backoff stops the run immediately.
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
            None::<NoRestore>,
            ReconnectPolicy::default(),
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
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

    /// No factory (e.g. a credential asked for each time): report the drop and
    /// stop, rather than prompting unattended.
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
            NoRestore,
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
            None,
            ReconnectPolicy::default(),
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        down_tx.send(()).unwrap();

        tokio::time::timeout(Duration::from_secs(60), run)
            .await
            .expect("the run must end")
            .unwrap();
        assert_eq!(script.attempts(), 1, "no unattended retry may be made");
    }

    /// Disabling reconnect stops the run but still reports `Lost`; off means
    /// "don't dial", not "don't report".
    #[tokio::test(start_paused = true)]
    async fn a_disabled_policy_stops_the_run_but_still_reports_the_loss() {
        let registry = registry_with_connecting_slot("fake-0").await;
        let slot = registry.lookup("fake-0").await.unwrap();
        let script = Script::shared();
        let (tx, _rx) = mpsc::channel(64);
        let (down_tx, down_rx) = mpsc::unbounded_channel();

        let log: PhaseLog = Arc::new(std::sync::Mutex::new(Vec::new()));

        // A working factory; only the policy stops the reconnect.
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
            Some(phase_recorder(log.clone())),
            ReconnectPolicy {
                enabled: false,
                ..ReconnectPolicy::default()
            },
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        down_tx.send(()).unwrap();

        tokio::time::timeout(Duration::from_secs(60), run)
            .await
            .expect("the run must end rather than sit in a backoff")
            .unwrap();

        assert_eq!(
            script.attempts(),
            1,
            "the factory must not be called once the user has said no"
        );
        assert_eq!(
            *log.lock().unwrap(),
            vec![TransportPhase::Lost],
            "the drop is still news to whatever was bound to the connection"
        );
    }

    /// A shortened attempt bound holds end to end.
    #[tokio::test(start_paused = true)]
    async fn a_shortened_policy_gives_up_sooner_than_the_default_would() {
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
            None::<NoRestore>,
            ReconnectPolicy {
                max_attempts: 2,
                ..ReconnectPolicy::default()
            },
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        script.fail_first.store(u64::MAX, Ordering::Relaxed);
        down_tx.send(()).unwrap();

        tokio::time::timeout(Duration::from_secs(600), run)
            .await
            .expect("the run must end on its own")
            .unwrap();

        // The first connect plus two retries.
        assert_eq!(
            script.attempts(),
            3,
            "the shortened bound must be the one that binds"
        );

        let statuses = drain(&mut rx).await;
        assert!(
            statuses.iter().any(|s| matches!(
                s,
                ConnectionStatus::Failed(msg) if msg.contains("after 3 attempts")
            )),
            "giving up early still has to be reported, and say how many: {statuses:?}"
        );
    }
}
