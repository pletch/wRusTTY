use async_trait::async_trait;
use tokio::sync::mpsc::Sender;

use crate::events::ConnectionEvent;

/// Protocol-agnostic transport contract implemented by `wr-ssh`, `wr-telnet`,
/// and `wr-serial`. The UI and tab manager talk to sessions only through
/// these traits, so adding a protocol later means adding a crate, not
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
///
/// # Why this is two traits
///
/// It used to be one, with `connect(&mut self)` alongside `write`/`resize`.
/// That made "not yet connected" and "connected" the same type, and since
/// every caller holds a session behind a mutex, driving the handshake meant
/// holding that mutex for its whole duration — TCP connect, KEX, auth, *and*
/// the host-key prompt, which blocks on a human reading a fingerprint. Any
/// input or resize arriving in that window queued behind it.
///
/// Splitting them means the handshake runs against a value nothing else can
/// reach, and only the connected session is ever shared. The type also stops
/// admitting a state it can't serve: a `Session` exists because a handshake
/// succeeded, so `write` no longer needs to explain what it does before one
/// has.
#[async_trait]
pub trait Connector: Send + 'static {
    type Session: Session<Error = Self::Error>;
    type Error: std::error::Error + Send + Sync + 'static;

    /// Drives the handshake and yields the live session.
    ///
    /// Takes `self` by value: a connector is single-use, and consuming it is
    /// what stops a second `connect` on something already connected from
    /// being expressible.
    async fn connect(self, events: Sender<ConnectionEvent>) -> Result<Self::Session, Self::Error>;
}

/// A transport that has completed its handshake.
#[async_trait]
pub trait Session: Send {
    type Error: std::error::Error + Send + Sync + 'static;

    async fn write(&mut self, data: &[u8]) -> Result<(), Self::Error>;

    /// Notify the remote side of a terminal size change (PTY resize / NAWS /
    /// no-op for transports without a concept of rows and cols).
    async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), Self::Error>;

    async fn disconnect(&mut self) -> Result<(), Self::Error>;
}
