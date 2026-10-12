use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use wr_core::{write_paced, ConnectionEvent, ConnectionStatus, Connector, DisconnectKind, Session};

use crate::config::TelnetConfig;
use crate::error::TelnetError;
use crate::protocol::{self, Parser};

/// Sends a protocol reply (option negotiation, terminal type, NAWS) up the
/// write channel. Returns false if the session or write task is gone, meaning
/// the read loop should stop.
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
    /// `Option` so `disconnect` can drop the sender, ending the write task.
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
        // Dropping the sender ends the write task, which drops its
        // `OwnedWriteHalf`, and tokio shuts down the write side so the peer sees
        // EOF. The read task then ends on EOF. Relies on the read task's reply
        // sender being weak (see `connect_inner`).
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
                // Paced (see `wr_core::WRITE_CHUNK`): the far side is a pty with the
                // same input buffer. Protocol replies take the single-chunk path.
                // Chunking after `escape_data` is safe: TCP keeps a doubled IAC together.
                if write_paced(&mut write_half, &bytes).await.is_err() {
                    break;
                }
            }
        });

        let output_events = events.clone();
        let last_size = self.last_size.clone();
        // Weak, so the read task doesn't keep the channel alive after
        // `disconnect` (which would keep the socket open). It can still send while
        // the session holds its strong sender.
        let reply_tx = input_tx.downgrade();
        // Resolved outside the loop: the reply task outlives this borrow, and the
        // answer is fixed.
        let term_type = self.config.term_type().to_string();
        tokio::spawn(async move {
            let mut parser = Parser::new();
            let mut buf = [0u8; 4096];
            // Telnet's two endings look alike here but mean opposite things to
            // auto-reconnect (see `DisconnectKind`).
            let kind = 'read: loop {
                let n = match read_half.read(&mut buf).await {
                    // A clean FIN: the server hung up (a logout).
                    Ok(0) => break 'read DisconnectKind::Closed,
                    // A reset, an unreachable host, an interface going down.
                    Err(_) => break 'read DisconnectKind::Lost,
                    Ok(n) => n,
                };

                let out = parser.feed(&buf[..n]);

                // The remaining exits are this side letting go, so the status is moot.
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
    // The lib writes via `write_paced`; only these tests need the trait.
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    /// A listener that returns the accepted socket, so a test can check what the
    /// peer observed.
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

    /// `disconnect` closes the connection: the peer sees EOF.
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

        // Read to EOF; what matters is that the read terminates.
        let mut sink = Vec::new();
        let eof = tokio::time::timeout(Duration::from_secs(5), peer.read_to_end(&mut sink)).await;

        assert!(
            eof.is_ok(),
            "peer never saw EOF — the write half was not shut down, so the \
             connection leaked (this is exactly the bug)"
        );
        eof.unwrap().expect("read_to_end failed");
    }

    /// While the session is alive, the connection stays open.
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
            // Negotiation bytes are fine; zero-length (EOF) isn't.
            Ok(Ok(n)) => assert!(n > 0, "connection closed while the session was still alive"),
            Ok(Err(e)) => panic!("connection errored while the session was alive: {e}"),
        }
    }

    /// Replies still reach the wire through the weak sender.
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

        // The read task answers through `send_reply`.
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
