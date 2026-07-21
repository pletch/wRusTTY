use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_serial::SerialPort;
use wr_core::{Connection, ConnectionEvent, ConnectionStatus};

use crate::config::{translate_line_ending, SerialConfig};
use crate::error::SerialError;

enum WriteCommand {
    Data(Vec<u8>),
    Dtr(bool),
    Rts(bool),
    Break(Duration),
}

/// How long a break condition is held by default.
///
/// A break is the line held at logic zero for longer than one character
/// frame — the out-of-band attention signal on a serial console. Cisco
/// password recovery and ROMMON entry need one during boot, as do plenty of
/// embedded bootloaders. RS-232 has no fixed duration; ~300 ms is comfortably
/// past every receiver's detection threshold at any baud rate anyone still
/// uses, and matches what PuTTY sends.
pub const DEFAULT_BREAK: Duration = Duration::from_millis(300);

/// A live (or not-yet-connected) serial session. Unlike SSH/telnet, all I/O
/// and control-line access (DTR/RTS) has to live in a single task: the
/// underlying `SerialStream` can't be cloned (tokio-serial explicitly
/// doesn't support it) and `tokio::io::split` would type-erase away the
/// `SerialPort` trait methods DTR/RTS need — so reads, writes, and control
/// requests are all multiplexed through one `select!` loop instead.
pub struct SerialSession {
    config: SerialConfig,
    input_tx: Option<mpsc::Sender<WriteCommand>>,
}

impl SerialSession {
    pub fn new(config: SerialConfig) -> Self {
        Self {
            config,
            input_tx: None,
        }
    }

    pub async fn set_dtr(&self, level: bool) -> Result<(), SerialError> {
        let tx = self.input_tx.as_ref().ok_or(SerialError::NotConnected)?;
        tx.send(WriteCommand::Dtr(level))
            .await
            .map_err(|_| SerialError::NotConnected)
    }

    pub async fn set_rts(&self, level: bool) -> Result<(), SerialError> {
        let tx = self.input_tx.as_ref().ok_or(SerialError::NotConnected)?;
        tx.send(WriteCommand::Rts(level))
            .await
            .map_err(|_| SerialError::NotConnected)
    }

    /// Holds a break condition on the line for `duration`.
    ///
    /// Queued through the same channel as writes rather than touching the
    /// port directly, so it can't interleave with a write in progress — a
    /// break landing mid-character would corrupt that character instead of
    /// signalling cleanly.
    pub async fn send_break(&self, duration: Duration) -> Result<(), SerialError> {
        let tx = self.input_tx.as_ref().ok_or(SerialError::NotConnected)?;
        tx.send(WriteCommand::Break(duration))
            .await
            .map_err(|_| SerialError::NotConnected)
    }
}

#[async_trait]
impl Connection for SerialSession {
    type Error = SerialError;

    async fn connect(&mut self, events: mpsc::Sender<ConnectionEvent>) -> Result<(), SerialError> {
        let _ = events
            .send(ConnectionEvent::Status(ConnectionStatus::Connecting))
            .await;
        let result = self.connect_inner(&events);
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
                tracing::warn!(port = %self.config.port_name, error = %e, "serial connect failed");
            }
        }
        result
    }

    async fn write(&mut self, data: &[u8]) -> Result<(), SerialError> {
        let translated = translate_line_ending(data, self.config.line_ending);
        let tx = self.input_tx.as_ref().ok_or(SerialError::NotConnected)?;
        tx.send(WriteCommand::Data(translated))
            .await
            .map_err(|_| SerialError::NotConnected)
    }

    /// No-op: serial has no concept of terminal size to negotiate.
    async fn resize(&mut self, _cols: u16, _rows: u16) -> Result<(), SerialError> {
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SerialError> {
        self.input_tx = None;
        Ok(())
    }
}

impl SerialSession {
    fn connect_inner(&mut self, events: &mpsc::Sender<ConnectionEvent>) -> Result<(), SerialError> {
        let builder = tokio_serial::new(self.config.port_name.clone(), self.config.baud_rate)
            .data_bits(self.config.data_bits.into())
            .parity(self.config.parity.into())
            .stop_bits(self.config.stop_bits.into())
            .flow_control(self.config.flow_control.into());

        let mut stream =
            tokio_serial::SerialStream::open(&builder).map_err(|e| SerialError::Open {
                port: self.config.port_name.clone(),
                source: e,
            })?;

        let (tx, mut rx) = mpsc::channel::<WriteCommand>(1000);
        let local_echo = self.config.local_echo;
        let output_events = events.clone();

        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            loop {
                tokio::select! {
                    result = stream.read(&mut buf) => {
                        match result {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if output_events
                                    .send(ConnectionEvent::Data(buf[..n].to_vec()))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        }
                    }
                    cmd = rx.recv() => {
                        match cmd {
                            Some(WriteCommand::Data(bytes)) => {
                                if stream.write_all(&bytes).await.is_err() {
                                    break;
                                }
                                if local_echo
                                    && output_events
                                        .send(ConnectionEvent::Data(bytes))
                                        .await
                                        .is_err()
                                {
                                    break;
                                }
                            }
                            Some(WriteCommand::Dtr(level)) => {
                                if let Err(e) = stream.write_data_terminal_ready(level) {
                                    tracing::warn!(error = %e, "failed to set DTR");
                                }
                            }
                            Some(WriteCommand::Rts(level)) => {
                                if let Err(e) = stream.write_request_to_send(level) {
                                    tracing::warn!(error = %e, "failed to set RTS");
                                }
                            }
                            Some(WriteCommand::Break(duration)) => {
                                // Deliberately blocks this loop for the
                                // duration: a break is a line-level condition,
                                // and holding it is the whole operation. The
                                // OS keeps buffering inbound bytes meanwhile,
                                // so nothing is lost — and any device that
                                // matters is about to reset anyway.
                                if let Err(e) = stream.set_break() {
                                    tracing::warn!(error = %e, "failed to assert break");
                                } else {
                                    tokio::time::sleep(duration).await;
                                    if let Err(e) = stream.clear_break() {
                                        tracing::warn!(error = %e, "failed to clear break");
                                    }
                                }
                            }
                            None => break,
                        }
                    }
                }
            }
            let _ = output_events
                .send(ConnectionEvent::Status(ConnectionStatus::Disconnected))
                .await;
        });

        self.input_tx = Some(tx);
        Ok(())
    }
}
