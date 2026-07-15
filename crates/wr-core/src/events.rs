/// Lifecycle status shared by every transport. Protocol-specific detail
/// (e.g. an SSH host-key prompt) is not modeled here — transports surface
/// that through their own richer event types and let the caller (normally
/// a Tauri command layer) translate it into UI-facing events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    Disconnected,
    Failed(String),
}

/// Pushed from a running `Connection` back to whatever is driving it.
#[derive(Debug, Clone)]
pub enum ConnectionEvent {
    Data(Vec<u8>),
    Status(ConnectionStatus),
}
