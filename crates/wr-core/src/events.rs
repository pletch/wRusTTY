/// Why a connection ended. Auto-reconnect turns on it (reconnecting after a
/// deliberate `exit` would be maddening), and only the transport's read loop
/// can tell the two apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisconnectKind {
    /// The far end finished: an SSH channel EOF or close, a telnet FIN, a serial
    /// loop shut down on request. What typing `exit` looks like.
    Closed,
    /// The transport went away unasked: `channel.wait()` returning nothing, a
    /// read error, an expired keepalive, an unplugged adapter. Worth undoing.
    Lost,
}

/// Lifecycle status shared by every transport. Protocol-specific detail (an
/// SSH host-key prompt) travels in transports' own event types.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionStatus {
    /// Sent a magic packet, waiting for the host. Distinct from `Connecting`
    /// because a minute of "Waking" reads as a booting machine, not a hung client.
    Waking,
    Connecting,
    Connected,
    Disconnected(DisconnectKind),
    /// A [`DisconnectKind::Lost`] connection coming back on its own. `attempt`
    /// counts from 1; `in_seconds` is the wait before the next handshake.
    Reconnecting {
        attempt: u32,
        in_seconds: u64,
    },
    Failed(String),
}

/// Pushed from a running `Session` back to whatever is driving it.
#[derive(Debug, Clone)]
pub enum ConnectionEvent {
    Data(Vec<u8>),
    Status(ConnectionStatus),
}
