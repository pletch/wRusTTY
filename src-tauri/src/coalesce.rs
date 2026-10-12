//! Coalesces a session's `ConnectionEvent`s into fewer, larger IPC messages, so
//! a flood of small PTY reads doesn't pay the per-message IPC cost for each.
//! (The frontend separately meters writes against the frame clock; see
//! `src/lib/writeScheduler.ts`.) Shared by the ssh/telnet/serial command layers.
//!
//! `Data` travels as raw bytes on its own `Channel<InvokeResponseBody>`, avoiding
//! base64 (+33%) and JSON. `Status` and prompts stay on the typed JSON channel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc::Receiver;
use tokio::sync::Notify;
use wr_core::{ConnectionEvent, ConnectionStatus};

const FLUSH_INTERVAL: Duration = Duration::from_millis(8);

/// Buffered bytes that force a flush regardless of the interval. Only binds
/// during floods (above `FLUSH_SIZE_THRESHOLD / FLUSH_INTERVAL`), so interactive
/// latency is governed by `FLUSH_INTERVAL`. Measured to be near the point of
/// diminishing returns: per-message IPC overhead is amortized, while each engine
/// write (~8 ms) still fits in a frame. See docs/DEV_HISTORY.md.
const FLUSH_SIZE_THRESHOLD: usize = 256 * 1024;

/// Counters for what this forwarder pushed to the webview. Compared with the
/// frontend's receive-side numbers (`src/lib/deliveryStats.ts`), they show
/// whether a slow flood is limited by the parser or by everything upstream.
///
/// Process-wide and lock-free so they don't perturb what they measure;
/// concurrent sessions aggregate, so `reset` before measuring. A flush carries
/// the overshoot past `FLUSH_SIZE_THRESHOLD`, so watch `max_bytes` when
/// reasoning about frontend stalls.
mod stats {
    use super::*;

    pub(super) static FLUSHES: AtomicU64 = AtomicU64::new(0);
    pub(super) static BYTES: AtomicU64 = AtomicU64::new(0);
    pub(super) static MIN_BYTES: AtomicUsize = AtomicUsize::new(usize::MAX);
    pub(super) static MAX_BYTES: AtomicUsize = AtomicUsize::new(0);
    /// Micros since `origin()` of the first and latest flush: the send window.
    pub(super) static FIRST_US: AtomicU64 = AtomicU64::new(0);
    pub(super) static LAST_US: AtomicU64 = AtomicU64::new(0);

    static ORIGIN: OnceLock<Instant> = OnceLock::new();

    pub(super) fn origin() -> Instant {
        *ORIGIN.get_or_init(Instant::now)
    }

    pub(super) fn record(len: usize) {
        let now = origin().elapsed().as_micros() as u64;
        FLUSHES.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(len as u64, Ordering::Relaxed);
        MIN_BYTES.fetch_min(len, Ordering::Relaxed);
        MAX_BYTES.fetch_max(len, Ordering::Relaxed);
        // Only the first flush sets the start of the window.
        let _ = FIRST_US.compare_exchange(0, now.max(1), Ordering::Relaxed, Ordering::Relaxed);
        LAST_US.store(now, Ordering::Relaxed);
    }
}

/// What this forwarder has sent, for comparison with the frontend's receive
/// side.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryStats {
    pub flushes: u64,
    pub bytes: u64,
    /// Smallest and largest single flush. `max` shows how far past
    /// `FLUSH_SIZE_THRESHOLD` a delivery runs.
    pub min_bytes: u64,
    pub max_bytes: u64,
    /// Wall time from the first flush to the most recent, in milliseconds.
    pub span_ms: f64,
    /// Bytes per second across that span.
    pub bytes_per_sec: f64,
}

#[tauri::command]
pub fn delivery_stats() -> DeliveryStats {
    let flushes = stats::FLUSHES.load(Ordering::Relaxed);
    if flushes == 0 {
        return DeliveryStats::default();
    }
    let bytes = stats::BYTES.load(Ordering::Relaxed);
    let first = stats::FIRST_US.load(Ordering::Relaxed);
    let last = stats::LAST_US.load(Ordering::Relaxed);
    let span_ms = (last.saturating_sub(first)) as f64 / 1000.0;
    DeliveryStats {
        flushes,
        bytes,
        min_bytes: stats::MIN_BYTES.load(Ordering::Relaxed) as u64,
        max_bytes: stats::MAX_BYTES.load(Ordering::Relaxed) as u64,
        span_ms,
        bytes_per_sec: if span_ms > 0.0 {
            bytes as f64 / (span_ms / 1000.0)
        } else {
            0.0
        },
    }
}

/// Zero the counters (process-wide) right before a measured run.
#[tauri::command]
pub fn reset_delivery_stats() {
    stats::FLUSHES.store(0, Ordering::Relaxed);
    stats::BYTES.store(0, Ordering::Relaxed);
    stats::MIN_BYTES.store(usize::MAX, Ordering::Relaxed);
    stats::MAX_BYTES.store(0, Ordering::Relaxed);
    stats::FIRST_US.store(0, Ordering::Relaxed);
    stats::LAST_US.store(0, Ordering::Relaxed);
}

/// Bound on the event channel from transport to forwarder, giving a slow
/// frontend real backpressure through to each transport's read loop (and SSH's
/// channel window). It only engages because `FlowControl` stops the forwarder
/// draining `rx` when the webview falls behind; `Channel::send` itself never
/// blocks.
pub(crate) const CONNECTION_EVENT_CHANNEL_BOUND: usize = 256;

/// Default bytes that may sit unwritten in the webview's IPC queue before the
/// forwarder stops draining. A memory-safety bound: without it a producer like
/// `yes` grows the webview's queue until the process is killed. 16 MB was
/// measured as the knee (smaller windows starve the frontend; larger ones gain
/// little, since the write scheduler's frame budget takes over). Per session.
/// See docs/DEV_HISTORY.md.
const DEFAULT_MAX_INFLIGHT_BYTES: u64 = 16 * 1024 * 1024;

/// The live window, adjustable at runtime because tuning must happen with
/// DevTools closed (an attached inspector slows the frontend ~2.75x). Reached
/// from a keyboard shortcut; see `measureOverlay.ts`.
static INFLIGHT_WINDOW: AtomicU64 = AtomicU64::new(DEFAULT_MAX_INFLIGHT_BYTES);

/// One delivery; a smaller window would stall the session.
const MIN_INFLIGHT_BYTES: u64 = FLUSH_SIZE_THRESHOLD as u64;
/// Past this the bound stops being a memory-safety bound worth having.
const MAX_INFLIGHT_BYTES: u64 = 64 * 1024 * 1024;

fn inflight_window() -> u64 {
    INFLIGHT_WINDOW.load(Ordering::Relaxed)
}

/// Sets the window and returns the clamped value. Wakes waiters so it applies
/// to sessions already gated.
#[tauri::command]
pub fn set_inflight_window(bytes: u64) -> u64 {
    let clamped = bytes.clamp(MIN_INFLIGHT_BYTES, MAX_INFLIGHT_BYTES);
    INFLIGHT_WINDOW.store(clamped, Ordering::Relaxed);
    for flow in lock_registry().values() {
        flow.credit.notify_waiters();
    }
    clamped
}

/// How long to wait for credit before sending anyway, so a frontend that never
/// acknowledges degrades to unbounded sending rather than a hang. A dead
/// webview is caught separately (`Channel::send` fails).
const CREDIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Per-session count of bytes sent to the webview but not yet written, and the
/// gate the forwarder waits on. IPC success only means "queued", so the
/// frontend reports what it has actually written (`ack_delivery`, from the
/// write scheduler) and that is credited back.
#[derive(Default)]
pub struct FlowControl {
    inflight: AtomicU64,
    credit: Notify,
}

impl FlowControl {
    fn sent(&self, bytes: u64) {
        self.inflight.fetch_add(bytes, Ordering::Relaxed);
    }

    fn ack(&self, bytes: u64) {
        // Saturating: a mismatched over-ack opens the gate rather than wrapping
        // and stalling forever.
        let mut current = self.inflight.load(Ordering::Relaxed);
        loop {
            let next = current.saturating_sub(bytes);
            match self.inflight.compare_exchange_weak(
                current,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(seen) => current = seen,
            }
        }
        self.credit.notify_waiters();
    }

    /// Waits until the webview has caught up, or until `timeout`. A parameter so
    /// tests can pin the give-up behavior quickly.
    async fn wait_for_room(&self, timeout: Duration) {
        while self.inflight.load(Ordering::Relaxed) >= inflight_window() {
            // Registered before the re-check so an ack in between isn't missed.
            let waiter = self.credit.notified();
            if self.inflight.load(Ordering::Relaxed) < inflight_window() {
                return;
            }
            if tokio::time::timeout(timeout, waiter).await.is_err() {
                return;
            }
        }
    }
}

static FLOW: OnceLock<Mutex<HashMap<String, Arc<FlowControl>>>> = OnceLock::new();

/// Locks the registry, recovering from poisoning: one panic shouldn't kill the
/// output path for every session, and the map can't be left half-updated
/// (`logging.rs` does the same).
fn lock_registry() -> std::sync::MutexGuard<'static, HashMap<String, Arc<FlowControl>>> {
    flow_registry()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn flow_registry() -> &'static Mutex<HashMap<String, Arc<FlowControl>>> {
    FLOW.get_or_init(|| Mutex::new(HashMap::new()))
}

fn flow_for(session_id: &str) -> Arc<FlowControl> {
    lock_registry()
        .entry(session_id.to_string())
        .or_default()
        .clone()
}

/// Credits bytes the frontend has written, freeing the forwarder to send more.
/// Batched by the frontend; see `ACK_THRESHOLD_BYTES` in
/// `src/components/Terminal.tsx`.
#[tauri::command]
pub fn ack_delivery(session_id: String, bytes: u64) {
    // Looked up, not created: don't resurrect an entry for a finished session.
    let flow = lock_registry().get(&session_id).cloned();
    if let Some(flow) = flow {
        flow.ack(bytes);
    }
}

/// Drains `rx` until it closes, coalescing `Data` and flushing it as one raw
/// message on `data_channel` when the interval elapses or the buffer passes the
/// threshold. A `Status` flushes pending data first (preserving order), then
/// goes out immediately on `status_channel`.
///
/// `log_data` sees every flushed chunk (session transcripts; see `logging.rs`).
/// `on_status` sees every status, so `session_registry.rs` learns of a dropped
/// transport without an extra hop on the data path. Both are synchronous:
/// nothing on this loop may block.
// The last three arguments are distinct consumers of one stream.
// Seven arguments, exactly at clippy's threshold. The last three are each a
// distinct consumer of the same stream — render, log, supervise — and a struct
// grouping them would be built once at the only call site and destructured
// immediately here.
pub(crate) async fn forward_coalesced<E: Serialize + Clone>(
    session_id: String,
    mut rx: Receiver<ConnectionEvent>,
    status_channel: Channel<E>,
    data_channel: Channel<InvokeResponseBody>,
    make_status: impl Fn(&ConnectionStatus) -> E,
    log_data: impl Fn(&[u8]) + Send,
    on_status: impl Fn(&ConnectionStatus) + Send,
) {
    let flow = flow_for(&session_id);
    let mut buf: Vec<u8> = Vec::new();
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Skip the immediate first tick.
    ticker.tick().await;

    loop {
        // Awaited before taking more from `rx`: not draining lets `rx` fill, which
        // blocks the transport's read loop (and closes SSH's channel window).
        flow.wait_for_room(CREDIT_TIMEOUT).await;

        tokio::select! {
            maybe_event = rx.recv() => {
                match maybe_event {
                    Some(ConnectionEvent::Data(bytes)) => {
                        buf.extend_from_slice(&bytes);
                        if buf.len() >= FLUSH_SIZE_THRESHOLD
                            && !flush(&data_channel, &mut buf, &log_data, &flow)
                        {
                            break;
                        }
                    }
                    Some(ConnectionEvent::Status(status)) => {
                        if !flush(&data_channel, &mut buf, &log_data, &flow) {
                            break;
                        }
                        // Before the send, so the supervisor learns of a drop even when the
                        // webview is gone.
                        on_status(&status);
                        if status_channel.send(make_status(&status)).is_err() {
                            break;
                        }
                    }
                    None => {
                        flush(&data_channel, &mut buf, &log_data, &flow);
                        break;
                    }
                }
            }
            _ = ticker.tick() => {
                if !buf.is_empty() && !flush(&data_channel, &mut buf, &log_data, &flow) {
                    break;
                }
            }
        }
    }

    // Nothing will ack these now; drop the entry so it doesn't leak.
    lock_registry().remove(&session_id);
}

/// Returns `false` if the channel is gone; callers stop their loop.
fn flush(
    data_channel: &Channel<InvokeResponseBody>,
    buf: &mut Vec<u8>,
    log_data: &impl Fn(&[u8]),
    flow: &FlowControl,
) -> bool {
    if buf.is_empty() {
        return true;
    }
    let bytes = std::mem::take(buf);
    let len = bytes.len() as u64;
    stats::record(bytes.len());
    log_data(&bytes);
    // Counted before the send, so queued bytes are never invisible to the gate.
    flow.sent(len);
    if data_channel.send(InvokeResponseBody::Raw(bytes)).is_ok() {
        true
    } else {
        // No ack is coming; credit them back.
        flow.ack(len);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// The counters are process-wide and tests run in parallel, so tests that
    /// flush take this lock. A tokio mutex, since it's held across awaits (and has
    /// no poisoning).
    static COALESCE_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    async fn serial_guard() -> tokio::sync::MutexGuard<'static, ()> {
        COALESCE_TESTS.lock().await
    }

    #[derive(Clone, Serialize)]
    #[serde(
        tag = "type",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )]
    enum TestEvent {
        Status { status: String },
    }

    /// Records each raw `Data` message, in send order.
    #[allow(clippy::type_complexity)]
    fn recording_data_channel() -> (Channel<InvokeResponseBody>, Arc<Mutex<Vec<Vec<u8>>>>) {
        let received: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = received.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                recorded.lock().unwrap().push(bytes);
            }
            Ok(())
        });
        (channel, received)
    }

    /// One test covers the whole stats surface, since the counters are shared.
    #[tokio::test]
    async fn delivery_stats_count_what_was_actually_flushed() {
        let _serial = serial_guard().await;
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        let status_channel = Channel::new(|_| Ok(()));
        let (data_channel, _received) = recording_data_channel();

        reset_delivery_stats();
        assert_eq!(
            delivery_stats().flushes,
            0,
            "reset should zero the counters"
        );
        assert_eq!(delivery_stats().bytes, 0);

        let handle = tokio::spawn(forward_coalesced(
            "test-session".to_string(),
            rx,
            status_channel,
            data_channel,
            |status| TestEvent::Status {
                status: format!("{status:?}"),
            },
            |_: &[u8]| {},
            |_: &ConnectionStatus| {},
        ));

        // One oversized burst (size-branch flush, with overshoot) and a small tail
        // (flushed on close).
        let big = vec![b'x'; FLUSH_SIZE_THRESHOLD + 5000];
        tx.send(ConnectionEvent::Data(big.clone())).await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        tx.send(ConnectionEvent::Data(b"tail".to_vec()))
            .await
            .unwrap();
        drop(tx);
        handle.await.unwrap();

        let stats = delivery_stats();
        assert_eq!(stats.flushes, 2);
        assert_eq!(stats.bytes, (FLUSH_SIZE_THRESHOLD + 5000 + 4) as u64);
        assert_eq!(stats.min_bytes, 4, "the tail is the smallest flush");
        assert_eq!(
            stats.max_bytes,
            (FLUSH_SIZE_THRESHOLD + 5000) as u64,
            "a flush carries past the threshold by the overshoot — the number \
             that matters for frontend stalls"
        );

        reset_delivery_stats();
    }

    /// The forwarder stops taking events once the webview is far enough behind and
    /// resumes when it catches up.
    #[tokio::test]
    async fn stops_sending_once_the_frontend_falls_far_enough_behind() {
        let _serial = serial_guard().await;
        // Pinned small so the test is fast and independent of the default.
        set_inflight_window(1024 * 1024);
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        let status_channel = Channel::new(|_| Ok(()));
        let (data_channel, received) = recording_data_channel();
        let session = "backpressure-test".to_string();

        let handle = tokio::spawn(forward_coalesced(
            session.clone(),
            rx,
            status_channel,
            data_channel,
            |status| TestEvent::Status {
                status: format!("{status:?}"),
            },
            |_: &[u8]| {},
            |_: &ConnectionStatus| {},
        ));

        // Overrun the window several times, with no acks.
        let burst = vec![b'x'; FLUSH_SIZE_THRESHOLD];
        for _ in 0..48 {
            if tx.send(ConnectionEvent::Data(burst.clone())).await.is_err() {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;

        let window = inflight_window();
        let sent: usize = received.lock().unwrap().iter().map(|b| b.len()).sum();
        assert!(
            (sent as u64) <= window + FLUSH_SIZE_THRESHOLD as u64,
            "expected the forwarder to stop within one delivery of the window, \
             sent {sent} bytes against a {window} byte window"
        );
        assert!(
            sent > 0,
            "it should have sent up to the window, not nothing"
        );

        // Crediting it all back lets it move again.
        ack_delivery(session.clone(), sent as u64);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let after = received
            .lock()
            .unwrap()
            .iter()
            .map(|b| b.len())
            .sum::<usize>();
        assert!(
            after > sent,
            "acking should have released more; stuck at {sent} bytes"
        );

        drop(tx);
        // Credit generously so the forwarder can exit.
        ack_delivery(session.clone(), u64::MAX);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
        reset_delivery_stats();
        set_inflight_window(DEFAULT_MAX_INFLIGHT_BYTES);
    }

    /// A session that never acks degrades to unbounded sending instead of hanging.
    #[tokio::test]
    async fn gives_up_waiting_for_credit_rather_than_hanging() {
        let flow = FlowControl::default();
        flow.sent(inflight_window() * 2);
        let short = Duration::from_millis(20);
        let started = Instant::now();
        flow.wait_for_room(short).await;
        assert!(
            started.elapsed() >= short,
            "it should have waited for credit before giving up"
        );
        assert!(
            flow.inflight.load(Ordering::Relaxed) >= inflight_window(),
            "giving up must not fabricate credit — it proceeds despite the window"
        );
    }

    /// An over-ack clamps to zero rather than wrapping.
    #[test]
    fn over_acking_cannot_wrap_the_counter() {
        let flow = FlowControl::default();
        flow.sent(1024);
        flow.ack(u64::MAX);
        assert_eq!(flow.inflight.load(Ordering::Relaxed), 0);
    }

    /// The live-tunable window rejects values that would stall a session or stop
    /// bounding anything.
    #[tokio::test]
    async fn the_window_cannot_be_set_somewhere_useless() {
        let _serial = serial_guard().await;
        assert_eq!(set_inflight_window(0), MIN_INFLIGHT_BYTES);
        assert_eq!(set_inflight_window(1), MIN_INFLIGHT_BYTES);
        assert_eq!(set_inflight_window(u64::MAX), MAX_INFLIGHT_BYTES);
        assert_eq!(set_inflight_window(8 * 1024 * 1024), 8 * 1024 * 1024);
        assert_eq!(inflight_window(), 8 * 1024 * 1024);
        assert_eq!(
            set_inflight_window(DEFAULT_MAX_INFLIGHT_BYTES),
            DEFAULT_MAX_INFLIGHT_BYTES
        );
    }

    /// Flow is per session, and an ack for a finished session doesn't recreate it.
    #[tokio::test]
    async fn flow_is_per_session_and_does_not_leak() {
        let a = flow_for("session-a");
        a.sent(inflight_window());
        let b = flow_for("session-b");
        assert_eq!(
            b.inflight.load(Ordering::Relaxed),
            0,
            "sessions are separate"
        );

        flow_registry().lock().unwrap().remove("session-a");
        flow_registry().lock().unwrap().remove("session-b");
        ack_delivery("session-a".to_string(), 1);
        assert!(
            !flow_registry().lock().unwrap().contains_key("session-a"),
            "an ack for a finished session should not recreate its entry"
        );
    }

    #[tokio::test]
    async fn small_chunks_under_the_size_threshold_are_coalesced() {
        let _serial = serial_guard().await;
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        let status_channel = Channel::new(|_| Ok(()));
        let (data_channel, received) = recording_data_channel();

        let handle = tokio::spawn(forward_coalesced(
            "test-session".to_string(),
            rx,
            status_channel,
            data_channel,
            |status| TestEvent::Status {
                status: format!("{status:?}"),
            },
            |_: &[u8]| {},
            |_: &ConnectionStatus| {},
        ));

        tx.send(ConnectionEvent::Data(b"hello ".to_vec()))
            .await
            .unwrap();
        tx.send(ConnectionEvent::Data(b"world".to_vec()))
            .await
            .unwrap();
        // Closing the sender flushes deterministically.
        drop(tx);
        handle.await.unwrap();

        let received = received.lock().unwrap();
        assert_eq!(received.len(), 1, "expected exactly one coalesced send");
        assert_eq!(received[0], b"hello world");
    }

    #[tokio::test]
    async fn exceeding_the_size_threshold_flushes_immediately() {
        let _serial = serial_guard().await;
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        let status_channel = Channel::new(|_| Ok(()));
        let (data_channel, received) = recording_data_channel();

        let handle = tokio::spawn(forward_coalesced(
            "test-session".to_string(),
            rx,
            status_channel,
            data_channel,
            |status| TestEvent::Status {
                status: format!("{status:?}"),
            },
            |_: &[u8]| {},
            |_: &ConnectionStatus| {},
        ));

        let big = vec![b'x'; FLUSH_SIZE_THRESHOLD];
        tx.send(ConnectionEvent::Data(big.clone())).await.unwrap();
        // Let the burst flush before sending a distinguishable second chunk.
        tokio::time::sleep(Duration::from_millis(20)).await;
        tx.send(ConnectionEvent::Data(b"tail".to_vec()))
            .await
            .unwrap();
        drop(tx);
        handle.await.unwrap();

        let received = received.lock().unwrap();
        assert_eq!(
            received.len(),
            2,
            "expected the oversized burst to flush separately from the trailing chunk"
        );
        assert_eq!(received[0], big);
        assert_eq!(received[1], b"tail");
    }

    #[tokio::test]
    async fn status_event_flushes_pending_data_first_preserving_order() {
        let _serial = serial_guard().await;
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        let status_received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let status_recorded = status_received.clone();
        let status_channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                status_recorded.lock().unwrap().push(json);
            }
            Ok(())
        });
        let (data_channel, data_received) = recording_data_channel();

        let handle = tokio::spawn(forward_coalesced(
            "test-session".to_string(),
            rx,
            status_channel,
            data_channel,
            |status| TestEvent::Status {
                status: format!("{status:?}"),
            },
            |_: &[u8]| {},
            |_: &ConnectionStatus| {},
        ));

        tx.send(ConnectionEvent::Data(b"before".to_vec()))
            .await
            .unwrap();
        tx.send(ConnectionEvent::Status(ConnectionStatus::Disconnected(
            wr_core::DisconnectKind::Closed,
        )))
        .await
        .unwrap();
        drop(tx);
        handle.await.unwrap();

        let data_received = data_received.lock().unwrap();
        assert_eq!(
            data_received.len(),
            1,
            "the data chunk should have been flushed"
        );
        assert_eq!(data_received[0], b"before");
        assert_eq!(
            status_received.lock().unwrap().len(),
            1,
            "the status event should still have been forwarded"
        );
    }
}
