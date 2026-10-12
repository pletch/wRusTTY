use async_trait::async_trait;
use tokio::sync::mpsc::Sender;

use crate::events::ConnectionEvent;

/// Protocol-agnostic transport contract implemented by `wr-ssh`, `wr-telnet`,
/// `wr-serial` and `wr-local`. The UI and session management talk to sessions
/// only through these traits.
///
/// Output is pushed through `events`, since a session produces data for its
/// whole lifetime. The channel is bounded, so a full channel blocks the
/// transport's read loop, which is the backpressure (for SSH, through the
/// channel's own flow control).
///
/// Two traits so the handshake runs on a value nothing else can reach, while
/// only the connected session is shared behind a mutex; a `Session` exists
/// only after a successful handshake.
#[async_trait]
pub trait Connector: Send + 'static {
    type Session: Session<Error = Self::Error>;
    type Error: std::error::Error + Send + Sync + 'static;

    /// Drives the handshake and yields the live session. Consumes `self`, so a
    /// second `connect` can't be expressed.
    async fn connect(self, events: Sender<ConnectionEvent>) -> Result<Self::Session, Self::Error>;

    /// Whether a failed attempt is worth retrying unattended (consulted only
    /// while auto-reconnecting). Defaults to `true`, since a reconnect usually
    /// fails on a host that isn't back yet. Override where a retry costs
    /// something: an SSH auth failure spends one of `MaxAuthTries` (6 in OpenSSH)
    /// and could lock the account, and a changed host key must reach a person.
    /// An associated function, since the connector is consumed by then.
    fn retryable(_error: &Self::Error) -> bool {
        true
    }
}

/// A transport that has completed its handshake.
#[async_trait]
pub trait Session: Send {
    type Error: std::error::Error + Send + Sync + 'static;

    async fn write(&mut self, data: &[u8]) -> Result<(), Self::Error>;

    /// Notifies the remote side of a size change (PTY resize, NAWS, or a no-op).
    async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), Self::Error>;

    async fn disconnect(&mut self) -> Result<(), Self::Error>;
}
