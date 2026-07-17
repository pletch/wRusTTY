use async_trait::async_trait;
use tokio::sync::mpsc::Sender;

use crate::events::ConnectionEvent;

/// Protocol-agnostic transport contract implemented by `wr-ssh`, `wr-telnet`,
/// and `wr-serial`. The UI and tab manager talk to sessions only through
/// this trait, so adding a protocol later means adding a crate, not
/// touching frontend or session-management code.
///
/// Output (bytes, status changes) is pushed through `events` rather than
/// returned from `connect`, since a session keeps producing data for its
/// whole lifetime, not just in response to a single call.
///
/// Bounded (not unbounded): a fast server and a slow webview would
/// otherwise have no backpressure, letting memory balloon under a firehose.
/// A bounded sender's `.send().await` blocks once the channel is full,
/// which naturally slows how fast each transport drains its own read loop
/// — for SSH that propagates back through the channel's own flow control.
#[async_trait]
pub trait Connection: Send {
    type Error: std::error::Error + Send + Sync + 'static;

    async fn connect(&mut self, events: Sender<ConnectionEvent>) -> Result<(), Self::Error>;

    async fn write(&mut self, data: &[u8]) -> Result<(), Self::Error>;

    /// Notify the remote side of a terminal size change (PTY resize / NAWS /
    /// no-op for transports without a concept of rows and cols).
    async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), Self::Error>;

    async fn disconnect(&mut self) -> Result<(), Self::Error>;
}
