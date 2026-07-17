//! Coalesces a stream of `ConnectionEvent`s into fewer, larger IPC messages
//! before they cross into the webview. Without this, every individual PTY
//! read (one `ChannelMsg::Data`) pays its own full base64-encode +
//! JSON-serialize + IPC round trip — under a firehose (`cat` a large file,
//! `tail -f` a busy log, a verbose build) that's a storm of tiny messages
//! each paying the full per-message tax. `xterm.js` already coalesces on
//! the render side (`term.write`), so the win is entirely here, in the
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

use std::time::Duration;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
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
/// flushing (sending one raw `InvokeResponseBody::Raw` message on
/// `data_channel`) whenever either the flush interval elapses or the
/// buffered size crosses the threshold, whichever comes first. A `Status`
/// event flushes whatever data is pending first (to preserve ordering
/// relative to the data around it), then is forwarded immediately on
/// `status_channel`, uncoalesced — status changes are rare and meaningful,
/// not something to batch.
pub(crate) async fn forward_coalesced<E: Serialize + Clone>(
    mut rx: Receiver<ConnectionEvent>,
    status_channel: Channel<E>,
    data_channel: Channel<InvokeResponseBody>,
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
                        if buf.len() >= FLUSH_SIZE_THRESHOLD && !flush(&data_channel, &mut buf) {
                            break;
                        }
                    }
                    Some(ConnectionEvent::Status(status)) => {
                        if !flush(&data_channel, &mut buf) {
                            break;
                        }
                        if status_channel.send(make_status(&status)).is_err() {
                            break;
                        }
                    }
                    None => {
                        flush(&data_channel, &mut buf);
                        break;
                    }
                }
            }
            _ = ticker.tick() => {
                if !buf.is_empty() && !flush(&data_channel, &mut buf) {
                    break;
                }
            }
        }
    }
}

/// Returns `false` if the channel is gone (send failed) — callers stop
/// their loop in that case, same as the old one-message-per-event code did.
fn flush(data_channel: &Channel<InvokeResponseBody>, buf: &mut Vec<u8>) -> bool {
    if buf.is_empty() {
        return true;
    }
    let bytes = std::mem::take(buf);
    data_channel.send(InvokeResponseBody::Raw(bytes)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

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

    #[tokio::test]
    async fn small_chunks_under_the_size_threshold_are_coalesced() {
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        let status_channel = Channel::new(|_| Ok(()));
        let (data_channel, received) = recording_data_channel();

        let handle = tokio::spawn(forward_coalesced(
            rx,
            status_channel,
            data_channel,
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
        let status_channel = Channel::new(|_| Ok(()));
        let (data_channel, received) = recording_data_channel();

        let handle = tokio::spawn(forward_coalesced(
            rx,
            status_channel,
            data_channel,
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
            rx,
            status_channel,
            data_channel,
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
