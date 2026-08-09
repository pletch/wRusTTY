use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use wr_core::{ConnectionEvent, ConnectionStatus, Connector, DisconnectKind, Session};

use crate::config::TelnetConfig;
use crate::error::TelnetError;
use crate::protocol::{self, Parser};

/// Sends a protocol reply (option negotiation, terminal type, NAWS) back up
/// the write channel, if the session still exists.
///
/// Returns false when it does not — either the session was disconnected, or
/// the write task is gone. Both mean the read loop should stop.
async fn send_reply(tx: &mpsc::WeakSender<Vec<u8>>, bytes: Vec<u8>) -> bool {
    match tx.upgrade() {
        Some(tx) => tx.send(bytes).await.is_ok(),
        None => false,
    }
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_SIZE: (u16, u16) = (80, 24);

/// Everything needed to open a telnet session, before one exists.
pub struct TelnetConnector {
    config: TelnetConfig,
    last_size: Arc<Mutex<(u16, u16)>>,
}

impl TelnetConnector {
    pub fn new(config: TelnetConfig) -> Self {
        Self {
            config,
            last_size: Arc::new(Mutex::new(DEFAULT_SIZE)),
        }
    }
}

/// A connected telnet session: the write channel, plus the last size so a
/// late NAWS negotiation can be answered with the current one.
pub struct TelnetSession {
    /// `Option` only so `disconnect` can drop the sender, which is what ends
    /// the write task. It is always `Some` on a freshly connected session —
    /// "not connected yet" is no longer a state this type can be in.
    input_tx: Option<mpsc::Sender<Vec<u8>>>,
    last_size: Arc<Mutex<(u16, u16)>>,
}

#[async_trait]
impl Connector for TelnetConnector {
    type Session = TelnetSession;
    type Error = TelnetError;

    async fn connect(
        self,
        events: mpsc::Sender<ConnectionEvent>,
    ) -> Result<TelnetSession, TelnetError> {
        let _ = events
            .send(ConnectionEvent::Status(ConnectionStatus::Connecting))
            .await;
        let host = self.config.host.clone();
        let port = self.config.port;
        let result = self.connect_inner(&events).await;
        match &result {
            Ok(_) => {
                let _ = events
                    .send(ConnectionEvent::Status(ConnectionStatus::Connected))
                    .await;
            }
            Err(e) => {
                let _ = events
                    .send(ConnectionEvent::Status(ConnectionStatus::Failed(
                        e.to_string(),
                    )))
                    .await;
                tracing::warn!(%host, port, error = %e, "telnet connect failed");
            }
        }
        result
    }
}

#[async_trait]
impl Session for TelnetSession {
    type Error = TelnetError;

    async fn write(&mut self, data: &[u8]) -> Result<(), TelnetError> {
        let tx = self.input_tx.as_ref().ok_or(TelnetError::NotConnected)?;
        tx.send(protocol::escape_data(data))
            .await
            .map_err(|_| TelnetError::NotConnected)
    }

    async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), TelnetError> {
        *self.last_size.lock().await = (cols, rows);
        let tx = self.input_tx.as_ref().ok_or(TelnetError::NotConnected)?;
        tx.send(protocol::encode_naws(cols, rows))
            .await
            .map_err(|_| TelnetError::NotConnected)
    }

    async fn disconnect(&mut self) -> Result<(), TelnetError> {
        // Dropping the sender closes the channel, which ends the write task,
        // which drops its `OwnedWriteHalf` — and tokio shuts the write side of
        // the socket down on that drop, so the peer sees EOF. The read task
        // then ends on its own once its half returns EOF/error.
        //
        // This only works because the read task's reply sender is weak; see
        // `connect_inner`. With a strong clone the channel outlived this and
        // the connection was never closed at all.
        self.input_tx = None;
        Ok(())
    }
}

impl TelnetConnector {
    async fn connect_inner(
        self,
        events: &mpsc::Sender<ConnectionEvent>,
    ) -> Result<TelnetSession, TelnetError> {
        let addr = (self.config.host.as_str(), self.config.port);
        let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr))
            .await
            .map_err(|_| TelnetError::Timeout {
                host: self.config.host.clone(),
                port: self.config.port,
            })?
            .map_err(|e| TelnetError::Connect {
                host: self.config.host.clone(),
                port: self.config.port,
                source: e,
            })?;

        let (mut read_half, mut write_half) = stream.into_split();
        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(1000);

        tokio::spawn(async move {
            while let Some(bytes) = input_rx.recv().await {
                if write_half.write_all(&bytes).await.is_err() {
                    break;
                }
                if write_half.flush().await.is_err() {
                    break;
                }
            }
        });

        let output_events = events.clone();
        let last_size = self.last_size.clone();
        // A *weak* sender, deliberately.
        //
        // This was `input_tx.clone()`, which meant the read task kept the
        // channel alive: `disconnect` dropped the session's sender, but the
        // clone here held the last strong reference, so `input_rx.recv()`
        // never returned `None`, the write task never ended, its
        // `OwnedWriteHalf` was never dropped, and no FIN was ever sent. The
        // TCP connection stayed ESTABLISHED until the process exited — one
        // leaked socket per closed telnet tab, and a half-open connection the
        // server had no reason to clean up either.
        //
        // A `WeakSender` can still send while the session holds its strong
        // one, which is the whole of what the reply path needs, and stops
        // counting the moment the session lets go.
        let reply_tx = input_tx.downgrade();
        // Resolved here rather than inside the loop: the reply task outlives
        // this borrow of `self`, and the answer can't change mid-session
        // anyway (a server may ask more than once, but our answer is fixed).
        let term_type = self.config.term_type().to_string();
        tokio::spawn(async move {
            let mut parser = Parser::new();
            let mut buf = [0u8; 4096];
            // Carried out of the loop rather than assumed, because telnet's two
            // ways of ending read almost identically here and mean opposite
            // things to auto-reconnect. See `DisconnectKind`.
            let kind = 'read: loop {
                let n = match read_half.read(&mut buf).await {
                    // A clean FIN: the server hung up, which is what logging
                    // out of a remote host looks like.
                    Ok(0) => break 'read DisconnectKind::Closed,
                    // A reset, an unreachable host, an interface going down.
                    Err(_) => break 'read DisconnectKind::Lost,
                    Ok(n) => n,
                };

                let out = parser.feed(&buf[..n]);

                // The remaining exits are all *this* side letting go — the
                // session was disconnected, or the webview went away — so the
                // status they report is moot; nothing is left to receive it.
                if !out.data.is_empty()
                    && output_events
                        .send(ConnectionEvent::Data(out.data))
                        .await
                        .is_err()
                {
                    break 'read DisconnectKind::Closed;
                }
                if !out.replies.is_empty() && !send_reply(&reply_tx, out.replies).await {
                    break 'read DisconnectKind::Closed;
                }
                if out.terminal_type_requested {
                    let bytes = protocol::encode_terminal_type(&term_type);
                    if !send_reply(&reply_tx, bytes).await {
                        break 'read DisconnectKind::Closed;
                    }
                }
                if out.naws_accepted {
                    let (cols, rows) = *last_size.lock().await;
                    let bytes = protocol::encode_naws(cols, rows);
                    if !send_reply(&reply_tx, bytes).await {
                        break 'read DisconnectKind::Closed;
                    }
                }
            };
            let _ = output_events
                .send(ConnectionEvent::Status(ConnectionStatus::Disconnected(
                    kind,
                )))
                .await;
        });

        Ok(TelnetSession {
            input_tx: Some(input_tx),
            last_size: self.last_size,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// A listener that hands back the accepted socket, so a test can ask what
    /// the peer actually observed rather than what we hoped it did.
    async fn listener() -> (TcpListener, u16) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        (l, port)
    }

    fn config(port: u16) -> TelnetConfig {
        TelnetConfig {
            host: "127.0.0.1".to_string(),
            port,
            ..Default::default()
        }
    }

    /// The regression this exists for.
    ///
    /// `disconnect` drops the session's sender, which must close the channel,
    /// which ends the write task, which drops its `OwnedWriteHalf` and shuts
    /// the write side of the socket down. The peer sees EOF.
    ///
    /// It did not, for a while: the read task held `input_tx.clone()`, so the
    /// channel never closed and the connection stayed ESTABLISHED until the
    /// process exited — one leaked socket per closed telnet tab. A smoke test
    /// caught it because two sockets closed at once on quit when only one
    /// session was open.
    #[tokio::test]
    async fn disconnect_closes_the_connection() {
        let (l, port) = listener().await;
        let accepted = tokio::spawn(async move { l.accept().await.unwrap().0 });

        let (tx, _rx) = mpsc::channel(64);
        let mut session = TelnetConnector::new(config(port))
            .connect(tx)
            .await
            .unwrap();
        let mut peer = accepted.await.unwrap();

        session.disconnect().await.unwrap();

        // Read to EOF. Whatever negotiation bytes are in flight are drained
        // first; what matters is that the read *terminates* rather than
        // blocking forever on a connection nobody closed.
        let mut sink = Vec::new();
        let eof = tokio::time::timeout(Duration::from_secs(5), peer.read_to_end(&mut sink)).await;

        assert!(
            eof.is_ok(),
            "peer never saw EOF — the write half was not shut down, so the \
             connection leaked (this is exactly the bug)"
        );
        eof.unwrap().expect("read_to_end failed");
    }

    /// The other half of the same property: while the session is alive, the
    /// connection must stay open. A fix that closed it eagerly would pass the
    /// test above and break the app.
    #[tokio::test]
    async fn the_connection_stays_open_while_the_session_lives() {
        let (l, port) = listener().await;
        let accepted = tokio::spawn(async move { l.accept().await.unwrap().0 });

        let (tx, _rx) = mpsc::channel(64);
        let _session = TelnetConnector::new(config(port))
            .connect(tx)
            .await
            .unwrap();
        let mut peer = accepted.await.unwrap();

        let mut buf = [0u8; 64];
        let read = tokio::time::timeout(Duration::from_millis(300), peer.read(&mut buf)).await;
        match read {
            // Timed out waiting for more: the connection is open and idle.
            Err(_) => {}
            // Negotiation bytes are fine; a zero-length read is EOF and is not.
            Ok(Ok(n)) => assert!(n > 0, "connection closed while the session was still alive"),
            Ok(Err(e)) => panic!("connection errored while the session was alive: {e}"),
        }
    }

    /// Replies still reach the wire through the weak sender — the negotiation
    /// path must keep working, or the fix has traded a leak for a mute client.
    #[tokio::test]
    async fn negotiation_replies_still_reach_the_peer() {
        let (l, port) = listener().await;
        let accepted = tokio::spawn(async move { l.accept().await.unwrap().0 });

        let (tx, _rx) = mpsc::channel(64);
        let session = TelnetConnector::new(config(port))
            .connect(tx)
            .await
            .unwrap();
        let mut peer = accepted.await.unwrap();

        // Ask for the terminal type; the read task answers through `send_reply`.
        peer.write_all(&[protocol::IAC, protocol::DO, protocol::OPT_TERMINAL_TYPE])
            .await
            .unwrap();

        let mut buf = [0u8; 256];
        let n = tokio::time::timeout(Duration::from_secs(5), peer.read(&mut buf))
            .await
            .expect("no reply within 5s — the weak sender failed to upgrade")
            .unwrap();

        assert!(n > 0, "peer got EOF instead of a negotiation reply");
        drop(session);
    }
}
