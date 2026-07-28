//! Coalesces a stream of `ConnectionEvent`s into fewer, larger IPC messages
//! before they cross into the webview. Without this, every individual PTY
//! read (one `ChannelMsg::Data`) pays its own full base64-encode +
//! JSON-serialize + IPC round trip — under a firehose (`cat` a large file,
//! `tail -f` a busy log, a verbose build) that's a storm of tiny messages
//! each paying the full per-message tax. The engine already coalesces on the
//! render side (writes are queued and drained against the frame clock — see
//! `src/lib/writeScheduler.ts`), so the win is entirely here, in the
//! forwarder. Shared by the ssh/telnet/serial Tauri command layers, which
//! otherwise differ only in their own `XxxEvent` type.
//!
//! `Data` chunks travel on their own `Channel<InvokeResponseBody>` as raw
//! bytes (`InvokeResponseBody::Raw`) rather than base64-encoded JSON on the
//! same channel as `Status`/`HostKeyPrompt` — base64 alone inflates a
//! coalesced buffer by 33%, on top of the encode/decode cost, and none of
//! that is needed for a payload that's already just bytes. `Status`/
//! `HostKeyPrompt` stay on the original JSON channel, where serde typing is
//! actually useful.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc::Receiver;
use tokio::sync::Notify;
use wr_core::{ConnectionEvent, ConnectionStatus};

const FLUSH_INTERVAL: Duration = Duration::from_millis(8);

/// Buffered bytes that force a flush regardless of the interval.
///
/// This is a flood-path knob and nothing else. It can only bind when output
/// arrives faster than `FLUSH_SIZE_THRESHOLD / FLUSH_INTERVAL`; below that
/// rate the ticker always fires first, so interactive echo latency is
/// governed by `FLUSH_INTERVAL` and is untouched by this value.
///
/// It was 32 KB, which put a 100 MB flood squarely on the size branch: 2931
/// messages of ~33 KB. Measuring both ends of the real delivery path
/// (`delivery_stats` here, `src/lib/deliveryStats.ts` in the webview) showed
/// the per-message IPC tax at ~0.70 ms against ~1.06 ms of actual engine
/// work — a 40% surcharge for crossing into the webview, paid 2931 times.
/// The frontend was idle, not blocked, for most of the shortfall: a rAF
/// series taken across its longest starved window showed frames arriving at a
/// clean 15.2 ms cadence while it waited on bytes the backend had already
/// sent.
///
/// Raising it to 256 KB measured 15.1 -> 19.7 MB/s on a 100 MB local flood,
/// with 459 flushes in place of 2931. Note what that does *not* mean: a flood
/// still flushes on the size branch, not the interval one. 256 KB accumulates
/// in ~6 ms at 41 MB/s, just inside the tick, so the median flush comes out at
/// 257 KB — threshold plus overshoot. Only the lulls flush on the ticker.
///
/// 256 KB is near the point of diminishing returns rather than an arbitrary
/// step up. Measured across the two settings, the IPC cost decomposes into
/// ~0.61 ms fixed per message plus ~2.9 ms per MB of copy; past this size the
/// per-byte term dominates and there is little left for a bigger buffer to
/// amortise. 1 MB would save a further ~6% of wall time while making each
/// uninterrupted engine write ~32 ms — visible jank for very little. At
/// 256 KB the write is ~8 ms, inside a frame, and the measured worst frame
/// gap moved only 106 -> 121 ms.
const FLUSH_SIZE_THRESHOLD: usize = 256 * 1024;

/// Counters for what this forwarder actually pushed at the webview.
///
/// Exists to answer one question the engine benchmarks structurally cannot:
/// when a flood is slow, is the frontend's parser the constraint or is it
/// everything upstream of it — transport reads, this coalescer, and the IPC
/// hop? Comparing the send rate recorded here against the receive rate the
/// frontend records (`src/lib/deliveryStats.ts`) separates those.
///
/// Process-wide and lock-free rather than per-session: it is a diagnostic that
/// must not perturb the thing it measures, and a flood is exactly when an
/// added mutex would be least welcome. The consequence is that concurrent
/// sessions aggregate together, which `reset` before a measurement makes
/// manageable.
///
/// `FLUSH_SIZE_THRESHOLD` is a floor, not a cap: a flush carries however much
/// the read that crossed the line overshot by, so `max_bytes` is the number
/// worth looking at when reasoning about frontend stalls.
mod stats {
    use super::*;

    pub(super) static FLUSHES: AtomicU64 = AtomicU64::new(0);
    pub(super) static BYTES: AtomicU64 = AtomicU64::new(0);
    pub(super) static MIN_BYTES: AtomicUsize = AtomicUsize::new(usize::MAX);
    pub(super) static MAX_BYTES: AtomicUsize = AtomicUsize::new(0);
    /// Micros since `origin()`, for the first and most recent flush — the span
    /// the byte total was delivered over, and so the send rate.
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

/// What `coalesce.rs` sent to the webview, as of now. Paired with the
/// frontend's own receive-side numbers to locate a throughput ceiling.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryStats {
    pub flushes: u64,
    pub bytes: u64,
    /// Smallest and largest single flush. `min` is usually a partial tail or an
    /// interval-tick flush; `max` shows how far past `FLUSH_SIZE_THRESHOLD` a
    /// delivery actually runs. (Named rather than restated: this said "the
    /// 32 KB threshold" long after the constant had moved to 256 KB.)
    pub min_bytes: u64,
    pub max_bytes: u64,
    /// Wall time from the first flush to the most recent, in milliseconds.
    pub span_ms: f64,
    /// Bytes per second across that span — the rate the backend sustained.
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

/// Zero the counters. Call immediately before the run being measured, since
/// the counters are process-wide and every session feeds them.
#[tauri::command]
pub fn reset_delivery_stats() {
    stats::FLUSHES.store(0, Ordering::Relaxed);
    stats::BYTES.store(0, Ordering::Relaxed);
    stats::MIN_BYTES.store(usize::MAX, Ordering::Relaxed);
    stats::MAX_BYTES.store(0, Ordering::Relaxed);
    stats::FIRST_US.store(0, Ordering::Relaxed);
    stats::LAST_US.store(0, Ordering::Relaxed);
}

/// Now that output is coalesced (see above), far fewer, larger messages are
/// ever in flight at once, so a modest bound already leaves ample slack —
/// while still giving a stalled/slow frontend real backpressure through to
/// each transport's own read loop (and, for SSH, its channel flow control)
/// instead of letting an unbounded channel balloon memory under a firehose.
///
/// On its own this bound could never engage. `Channel::send` is
/// fire-and-forget: it hands the message to the webview and returns, so the
/// forwarder always drained `rx` at full speed, `rx` never filled, and the
/// transport was never pushed back on. The unbounded growth was never here —
/// it was in the webview's own message queue, downstream of this. See
/// `FlowControl`, which is what actually makes this bound reachable.
pub(crate) const CONNECTION_EVENT_CHANNEL_BOUND: usize = 256;

/// Default bytes that may be sitting in the webview's IPC queue, unwritten,
/// before the forwarder stops draining its input.
///
/// Measured on a 100 MB flood over LAN SSH: the backend finished sending at
/// 2.56 s while the frontend was still draining at 3.69 s, so roughly 50 MB of
/// `ArrayBuffer`s were resident in the webview at peak — and that is a function
/// of how long the producer runs, not of anything the frontend controls. `yes`
/// or `cat /dev/urandom` grows it without limit until the webview process is
/// killed. This is a memory-safety bound, not a throughput one.
///
/// 16 MB is the knee, measured rather than reasoned. Three 100 MB floods over
/// LAN SSH, identical engine work each time (1553/1551/1543 ms inside write,
/// coreWrite 1305/1309/1309), varying only this value:
///
///   window   genuinely starved   active window   worst freeze
///     4 MB     448 ms (19.2%)      44.3 MB/s        25.2 ms
///    16 MB      93 ms  (4.3%)      47.6 MB/s        25.1 ms
///    32 MB      54 ms  (2.5%)      48.8 MB/s        25.1 ms
///
/// 4 MB was the first guess and it starved the frontend for a fifth of the run;
/// the reasoning behind it — that ~56 ms of queued work is plenty — ignored that
/// the queue is drained in bursts against a frame budget, not smoothly.
///
/// Past 16 MB there is almost nothing left to recover, because the constraint
/// stops being this window and becomes `FRAME_BUDGET_MS` in the write
/// scheduler: as starvation fell, deliberate pacing rose to take its place
/// (328 -> 529 ms), and throughput moved only 10%. The freeze is unchanged at
/// every setting, which is the scheduler bounding it independently.
///
/// Note this is per session, so N flooding panes hold N times this. 8 MB is on
/// the Ctrl+Alt+W cycle if that trade needs revisiting.
const DEFAULT_MAX_INFLIGHT_BYTES: u64 = 16 * 1024 * 1024;

/// The live window, so it can be retuned without a rebuild.
///
/// Adjustable because the value has to be chosen from a measurement that
/// DevTools cannot be present for — an attached inspector puts V8's WebAssembly
/// in a debuggable tier and makes the frontend ~2.75x slower, which would move
/// the very balance being tuned. A console-driven knob is therefore useless
/// here; this one is reachable from a keyboard shortcut with DevTools shut (see
/// `measureOverlay.ts`).
static INFLIGHT_WINDOW: AtomicU64 = AtomicU64::new(DEFAULT_MAX_INFLIGHT_BYTES);

/// One delivery, so the window can never be set below the size of the thing it
/// gates — which would stall the session outright.
const MIN_INFLIGHT_BYTES: u64 = FLUSH_SIZE_THRESHOLD as u64;
/// Past this the bound stops being a memory-safety bound worth having.
const MAX_INFLIGHT_BYTES: u64 = 64 * 1024 * 1024;

fn inflight_window() -> u64 {
    INFLIGHT_WINDOW.load(Ordering::Relaxed)
}

/// Sets the window and returns what it was clamped to. Wakes every waiter, so
/// raising it takes effect on a session that is already gated rather than only
/// on the next one.
#[tauri::command]
pub fn set_inflight_window(bytes: u64) -> u64 {
    let clamped = bytes.clamp(MIN_INFLIGHT_BYTES, MAX_INFLIGHT_BYTES);
    INFLIGHT_WINDOW.store(clamped, Ordering::Relaxed);
    for flow in flow_registry().lock().unwrap().values() {
        flow.credit.notify_waiters();
    }
    clamped
}

/// How long to wait for credit before sending anyway.
///
/// A frontend that never acknowledges — an older build, a wedged page, a
/// renderer killed by the OS — must not silently freeze the session. Timing out
/// degrades to the previous unbounded behaviour, which is bad, rather than to a
/// hang, which is worse and much harder to diagnose. A dead webview is caught
/// separately: `Channel::send` fails and the loop exits.
const CREDIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Per-session accounting of bytes sent to the webview but not yet written by
/// it, and the gate the forwarder waits on.
///
/// Backpressure needs a signal from the consumer, and IPC gives none: a send
/// that succeeded means the message was queued, not that anyone read it. So the
/// frontend reports what it has written (`ack_delivery`, called from the write
/// scheduler once it has actually handed bytes to the engine) and this credits
/// them back. Without that report there is no way to distinguish a frontend
/// keeping up from one falling 50 MB behind.
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
        // Saturating: an ack for more than is outstanding means the counters
        // disagree, and clamping to zero keeps the gate open rather than
        // wrapping to u64::MAX and stalling the session forever.
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

    /// Blocks until the webview has caught up enough to take more, or until the
    /// timeout gives up on hearing from it at all. The timeout is a parameter so
    /// a test can pin the give-up behaviour without waiting the real interval.
    async fn wait_for_room(&self, timeout: Duration) {
        while self.inflight.load(Ordering::Relaxed) >= inflight_window() {
            // Registered before the re-check inside `timeout` so an ack landing
            // in between is not missed, which would park this task until the
            // next one — or forever, on the last delivery.
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

fn flow_registry() -> &'static Mutex<HashMap<String, Arc<FlowControl>>> {
    FLOW.get_or_init(|| Mutex::new(HashMap::new()))
}

fn flow_for(session_id: &str) -> Arc<FlowControl> {
    flow_registry()
        .lock()
        .unwrap()
        .entry(session_id.to_string())
        .or_default()
        .clone()
}

/// Credits bytes the frontend has finished writing, freeing the forwarder to
/// send more. Called by the write scheduler, batched — see `ACK_THRESHOLD_BYTES`
/// in `src/components/Terminal.tsx`.
#[tauri::command]
pub fn ack_delivery(session_id: String, bytes: u64) {
    // Looked up rather than created: an ack for a session that has already gone
    // is not worth resurrecting an entry for, and doing so would leak one per
    // stale ack.
    let flow = flow_registry().lock().unwrap().get(&session_id).cloned();
    if let Some(flow) = flow {
        flow.ack(bytes);
    }
}

/// Drains `rx` until it closes, coalescing consecutive `Data` chunks and
/// flushing (sending one raw `InvokeResponseBody::Raw` message on
/// `data_channel`) whenever either the flush interval elapses or the
/// buffered size crosses the threshold, whichever comes first. A `Status`
/// event flushes whatever data is pending first (to preserve ordering
/// relative to the data around it), then is forwarded immediately on
/// `status_channel`, uncoalesced — status changes are rare and meaningful,
/// not something to batch.
///
/// `log_data` sees every flushed chunk before it's sent to the webview —
/// session-transcript logging hooks in here (see `logging.rs`) so logged
/// bytes never have to round-trip back over IPC from the frontend.
pub(crate) async fn forward_coalesced<E: Serialize + Clone>(
    session_id: String,
    mut rx: Receiver<ConnectionEvent>,
    status_channel: Channel<E>,
    data_channel: Channel<InvokeResponseBody>,
    make_status: impl Fn(&ConnectionStatus) -> E,
    log_data: impl Fn(&[u8]) + Send,
) {
    let flow = flow_for(&session_id);
    let mut buf: Vec<u8> = Vec::new();
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first tick fires immediately; skip it so a fresh connection with
    // no data yet doesn't race an empty flush against the first real event.
    ticker.tick().await;

    loop {
        // Awaited before taking anything else off `rx`, which is what turns
        // CONNECTION_EVENT_CHANNEL_BOUND from decoration into real
        // backpressure: not draining lets `rx` fill, which blocks the
        // transport's read loop on `tx.send().await`, which for SSH closes the
        // channel window and slows the remote host — a terminal that has
        // stopped reading, exactly as any other does.
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

    // The session is over; nothing will ever ack these bytes. Left behind, the
    // entry would hold a counter for a session that no longer exists and leak
    // one per connection for the life of the process.
    flow_registry().lock().unwrap().remove(&session_id);
}

/// Returns `false` if the channel is gone (send failed) — callers stop
/// their loop in that case, same as the old one-message-per-event code did.
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
    // Counted before the send: once it is queued the frontend owns it, and
    // counting after would leave a window where the bytes are in flight but
    // invisible to the gate.
    flow.sent(len);
    if data_channel.send(InvokeResponseBody::Raw(bytes)).is_ok() {
        true
    } else {
        // The channel is gone, so no ack is coming for these. Credit them back
        // so a caller that keeps the flow alive is not left permanently short.
        flow.ack(len);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// The delivery counters are process-wide, and `cargo test` runs these in
    /// parallel on one process — so every test that flushes bumps the same
    /// numbers. Each takes this first, which serialises them just enough for
    /// the counter assertions to mean anything.
    ///
    /// Tokio's mutex rather than `std`'s because the guard is deliberately
    /// held across the `.await`s that drive the forwarder, which is precisely
    /// what a std guard must not do (and what `clippy::await_holding_lock`
    /// exists to catch). It also has no poisoning, so one failing test cannot
    /// cascade into the others.
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

    /// Records each raw `Data` message's bytes, in send order — good enough
    /// to assert both "how many separate sends happened" and "what ended up
    /// in each one".
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

    /// The counters are process-wide, so this test owns them for its duration
    /// — hence one test covering the whole surface rather than several racing
    /// each other through `cargo test`'s thread pool.
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
        ));

        // One oversized burst (flushes on the size branch, carrying the whole
        // overshoot past the threshold) and one small tail (flushed on close).
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

    /// The bound on `rx` existed for a long time and could never engage, because
    /// `Channel::send` returns as soon as the message is queued and the
    /// forwarder therefore always drained its input at full speed. These pin the
    /// piece that makes it real: the forwarder must stop taking events once the
    /// webview is far enough behind, and start again when it catches up.
    #[tokio::test]
    async fn stops_sending_once_the_frontend_falls_far_enough_behind() {
        let _serial = serial_guard().await;
        // Pinned small rather than taking the default, so the test stays fast
        // and keeps working when the default is retuned — which it already was
        // once, from 4 MB to 16, silently breaking this.
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
        ));

        // Enough to overrun the window several times over, with nothing acking.
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

        // Crediting the whole lot back must let it move again.
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
        // Credit generously so the forwarder can finish and exit rather than
        // sitting on the gate until the test times out.
        ack_delivery(session.clone(), u64::MAX);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
        reset_delivery_stats();
        set_inflight_window(DEFAULT_MAX_INFLIGHT_BYTES);
    }

    /// A session that never acks — an older frontend, a wedged page — must
    /// degrade to the old unbounded behaviour rather than hanging, which would
    /// look like a dead connection and be far harder to diagnose.
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

    /// An ack larger than the outstanding total must clamp rather than wrap: a
    /// `u64` underflow here would park the session on a full window forever.
    #[test]
    fn over_acking_cannot_wrap_the_counter() {
        let flow = FlowControl::default();
        flow.sent(1024);
        flow.ack(u64::MAX);
        assert_eq!(flow.inflight.load(Ordering::Relaxed), 0);
    }

    /// The window is retuned from a keyboard shortcut during a live flood, so a
    /// value that stalled a session outright — or one large enough to stop being
    /// a bound at all — has to be refused rather than accepted.
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

    /// The registry is keyed by session, so one stalled tab cannot throttle
    /// another — and an ack for a session that has gone must not resurrect it.
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
        ));

        tx.send(ConnectionEvent::Data(b"hello ".to_vec()))
            .await
            .unwrap();
        tx.send(ConnectionEvent::Data(b"world".to_vec()))
            .await
            .unwrap();
        // Closing the sender ends the loop and flushes whatever's pending —
        // deterministic, unlike waiting on the flush timer in a test.
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
        ));

        let big = vec![b'x'; FLUSH_SIZE_THRESHOLD];
        tx.send(ConnectionEvent::Data(big.clone())).await.unwrap();
        // Give the coalescing task a chance to observe and flush the burst
        // before we also send a second, distinguishable chunk.
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
        ));

        tx.send(ConnectionEvent::Data(b"before".to_vec()))
            .await
            .unwrap();
        tx.send(ConnectionEvent::Status(ConnectionStatus::Disconnected))
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
