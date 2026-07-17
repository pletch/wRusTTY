use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use wr_core::{Connection, ConnectionEvent, ConnectionStatus};

use crate::config::TelnetConfig;
use crate::error::TelnetError;
use crate::protocol::{self, Parser};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_SIZE: (u16, u16) = (80, 24);

pub struct TelnetSession {
    config: TelnetConfig,
    input_tx: Option<mpsc::Sender<Vec<u8>>>,
    last_size: Arc<Mutex<(u16, u16)>>,
}

impl TelnetSession {
    pub fn new(config: TelnetConfig) -> Self {
        Self {
            config,
            input_tx: None,
            last_size: Arc::new(Mutex::new(DEFAULT_SIZE)),
        }
    }
}

#[async_trait]
impl Connection for TelnetSession {
    type Error = TelnetError;

    async fn connect(&mut self, events: mpsc::Sender<ConnectionEvent>) -> Result<(), TelnetError> {
        let _ = events
            .send(ConnectionEvent::Status(ConnectionStatus::Connecting))
            .await;
        let result = self.connect_inner(&events).await;
        match &result {
            Ok(()) => {
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
                tracing::warn!(host = %self.config.host, port = self.config.port, error = %e, "telnet connect failed");
            }
        }
        result
    }

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
        // Dropping the sender ends the write task; the read task ends on
        // its own once the socket's read half returns EOF/error.
        self.input_tx = None;
        Ok(())
    }
}

impl TelnetSession {
    async fn connect_inner(
        &mut self,
        events: &mpsc::Sender<ConnectionEvent>,
    ) -> Result<(), TelnetError> {
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
        let reply_tx = input_tx.clone();
        tokio::spawn(async move {
            let mut parser = Parser::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = match read_half.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };

                let out = parser.feed(&buf[..n]);

                if !out.data.is_empty()
                    && output_events
                        .send(ConnectionEvent::Data(out.data))
                        .await
                        .is_err()
                {
                    break;
                }
                if !out.replies.is_empty() && reply_tx.send(out.replies).await.is_err() {
                    break;
                }
                if out.terminal_type_requested {
                    let bytes = protocol::encode_terminal_type("xterm-256color");
                    if reply_tx.send(bytes).await.is_err() {
                        break;
                    }
                }
                if out.naws_accepted {
                    let (cols, rows) = *last_size.lock().await;
                    let bytes = protocol::encode_naws(cols, rows);
                    if reply_tx.send(bytes).await.is_err() {
                        break;
                    }
                }
            }
            let _ = output_events
                .send(ConnectionEvent::Status(ConnectionStatus::Disconnected))
                .await;
        });

        self.input_tx = Some(input_tx);
        Ok(())
    }
}
