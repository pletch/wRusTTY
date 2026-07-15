//! Shared by every transport command module (ssh/telnet/serial) since they
//! all push the same `wr_core::ConnectionStatus` through their event enums.

pub fn status_label(status: &wr_core::ConnectionStatus) -> String {
    use wr_core::ConnectionStatus;
    match status {
        ConnectionStatus::Connecting => "connecting".to_string(),
        ConnectionStatus::Connected => "connected".to_string(),
        ConnectionStatus::Disconnected => "disconnected".to_string(),
        ConnectionStatus::Failed(msg) => format!("failed: {msg}"),
    }
}
