//! Coalesces a stream of `ConnectionEvent`s into fewer, larger IPC messages
//! before they cross into the webview. Without this, every individual PTY
//! read (one `ChannelMsg::Data`) pays its own full base64-encode +
//! JSON-serialize + IPC round trip — under a firehose (`cat` a large file,
//! `tail -f` a busy log, a verbose build) that's a storm of tiny messages
//! each paying the full per-message tax. `xterm.js` already coalesces on
//! the render side (`term.write`), so the win is entirely here, in the
//! forwarder. Shared by the ssh/telnet/serial Tauri command layers, which
//! otherwise differ only in their own `XxxEvent` type.

use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::mpsc::Receiver;
use wr_core::{ConnectionEvent, ConnectionStatus};

const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const FLUSH_SIZE_THRESHOLD: usize = 32 * 1024;

/// Now that output is coalesced (see above), far fewer, larger messages are
/// ever in flight at once, so a modest bound already leaves ample slack —
/// while still giving a stalled/slow frontend real backpressure through to
/// each transport's own read loop (and, for SSH, its channel flow control)
/// instead of letting an unbounded channel balloon memory under a firehose.
pub(crate) const CONNECTION_EVENT_CHANNEL_BOUND: usize = 256;

/// Drains `rx` until it closes, coalescing consecutive `Data` chunks and
/// flushing (base64-encoding, then sending one `make_data(...)` message)
/// whenever either the flush interval elapses or the buffered size crosses
/// the threshold, whichever comes first. A `Status` event flushes whatever
/// is pending first (to preserve ordering relative to the data around it),
/// then is forwarded immediately, uncoalesced — status changes are rare and
/// meaningful, not something to batch.
pub(crate) async fn forward_coalesced<E: Serialize + Clone>(
    mut rx: Receiver<ConnectionEvent>,
    channel: Channel<E>,
    make_data: impl Fn(String) -> E,
    make_status: impl Fn(&ConnectionStatus) -> E,
) {
    let mut buf: Vec<u8> = Vec::new();
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first tick fires immediately; skip it so a fresh connection with
    // no data yet doesn't race an empty flush against the first real event.
    ticker.tick().await;

    loop {
        tokio::select! {
            maybe_event = rx.recv() => {
                match maybe_event {
                    Some(ConnectionEvent::Data(bytes)) => {
                        buf.extend_from_slice(&bytes);
                        if buf.len() >= FLUSH_SIZE_THRESHOLD && !flush(&channel, &mut buf, &make_data) {
                            break;
                        }
                    }
                    Some(ConnectionEvent::Status(status)) => {
                        if !flush(&channel, &mut buf, &make_data) {
                            break;
                        }
                        if channel.send(make_status(&status)).is_err() {
                            break;
                        }
                    }
                    None => {
                        flush(&channel, &mut buf, &make_data);
                        break;
                    }
                }
            }
            _ = ticker.tick() => {
                if !buf.is_empty() && !flush(&channel, &mut buf, &make_data) {
                    break;
                }
            }
        }
    }
}

/// Returns `false` if the channel is gone (send failed) — callers stop
/// their loop in that case, same as the old one-message-per-event code did.
fn flush<E: Serialize + Clone>(
    channel: &Channel<E>,
    buf: &mut Vec<u8>,
    make_data: &impl Fn(String) -> E,
) -> bool {
    if buf.is_empty() {
        return true;
    }
    let bytes = std::mem::take(buf);
    channel.send(make_data(BASE64.encode(bytes))).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tauri::ipc::InvokeResponseBody;

    #[derive(Clone, Serialize)]
    #[serde(
        tag = "type",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )]
    enum TestEvent {
        Data { bytes_base64: String },
        Status { status: String },
    }

    /// Records each message's decoded base64 payload (for `Data` messages)
    /// as plain bytes, in send order — good enough to assert both "how many
    /// separate sends happened" and "what ended up in each one".
    #[allow(clippy::type_complexity)]
    fn recording_channel() -> (Channel<TestEvent>, Arc<Mutex<Vec<Vec<u8>>>>) {
        let received: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = received.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                let value: serde_json::Value = serde_json::from_str(&json).unwrap();
                if let Some(b64) = value.get("bytesBase64").and_then(|v| v.as_str()) {
                    recorded.lock().unwrap().push(BASE64.decode(b64).unwrap());
                }
            }
            Ok(())
        });
        (channel, received)
    }

    #[tokio::test]
    async fn small_chunks_under_the_size_threshold_are_coalesced() {
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        let (channel, received) = recording_channel();

        let handle = tokio::spawn(forward_coalesced(
            rx,
            channel,
            |bytes_base64| TestEvent::Data { bytes_base64 },
            |status| TestEvent::Status {
                status: format!("{status:?}"),
            },
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
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        let (channel, received) = recording_channel();

        let handle = tokio::spawn(forward_coalesced(
            rx,
            channel,
            |bytes_base64| TestEvent::Data { bytes_base64 },
            |status| TestEvent::Status {
                status: format!("{status:?}"),
            },
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
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        let (channel, received) = recording_channel();

        let handle = tokio::spawn(forward_coalesced(
            rx,
            channel,
            |bytes_base64| TestEvent::Data { bytes_base64 },
            |status| TestEvent::Status {
                status: format!("{status:?}"),
            },
        ));

        tx.send(ConnectionEvent::Data(b"before".to_vec()))
            .await
            .unwrap();
        tx.send(ConnectionEvent::Status(ConnectionStatus::Disconnected))
            .await
            .unwrap();
        drop(tx);
        handle.await.unwrap();

        let received = received.lock().unwrap();
        assert_eq!(received.len(), 1, "the data chunk should have been flushed");
        assert_eq!(received[0], b"before");
    }
}
