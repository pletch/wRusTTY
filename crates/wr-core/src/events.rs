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
    Disconnected,
    Failed(String),
}

/// Pushed from a running `Session` back to whatever is driving it.
#[derive(Debug, Clone)]
pub enum ConnectionEvent {
    Data(Vec<u8>),
    Status(ConnectionStatus),
}
