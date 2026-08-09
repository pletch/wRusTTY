/// Why a connection ended.
///
/// Drawn because auto-reconnect turns on it and nothing else could: the two
/// arrive at the same place in every transport's read loop and are otherwise
/// indistinguishable downstream. Auto-reconnecting after a deliberate `exit`
/// would be maddening, so the discriminator has to be carried from the one
/// place that still has it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisconnectKind {
    /// The far end finished. An SSH channel EOF or close, a telnet server
    /// sending FIN, a serial write loop shut down on request — which is what
    /// typing `exit` looks like from here.
    Closed,
    /// The transport went away without being asked to: `channel.wait()`
    /// returning nothing, a read erroring, a keepalive expiring, a USB adapter
    /// unplugged. Nobody chose this, so it is the kind worth undoing.
    Lost,
}

/// Lifecycle status shared by every transport. Protocol-specific detail
/// (e.g. an SSH host-key prompt) is not modeled here — transports surface
/// that through their own richer event types and let the caller (normally
/// a Tauri command layer) translate it into UI-facing events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionStatus {
    /// Sent a magic packet, waiting for the host to answer. Ahead of
    /// `Connecting` because nothing has been dialled yet — and distinct from
    /// it because the two wait for very different lengths of time: a minute
    /// of "Connecting" reads as a hung client, where a minute of "Waking"
    /// reads as a machine booting, which is exactly what it is.
    Waking,
    Connecting,
    Connected,
    Disconnected(DisconnectKind),
    /// A [`DisconnectKind::Lost`] connection that is coming back on its own.
    /// `attempt` counts from 1; `in_seconds` is how long until the next
    /// handshake starts.
    ///
    /// Beside `Waking` and for the same reason that variant documents: the
    /// status line has to say something different for "this will come back on
    /// its own in 8 seconds" than for "this is hung" or "this is over".
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
