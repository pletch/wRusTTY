//! Shared by every transport command module (ssh/telnet/serial) since they
//! all push the same `wr_core::ConnectionStatus` through their event enums.

pub fn status_label(status: &wr_core::ConnectionStatus) -> String {
    use wr_core::{ConnectionStatus, DisconnectKind};
    match status {
        ConnectionStatus::Waking => "waking".to_string(),
        ConnectionStatus::Connecting => "connecting".to_string(),
        ConnectionStatus::Connected => "connected".to_string(),
        // Two words for two different events, because the UI has to treat them
        // differently: a shell that exited is over and `closeOnDisconnect`
        // should act on it, where a transport that vanished may be seconds away
        // from coming back on its own. Keeping `disconnected` for the clean
        // case leaves every existing frontend check meaning what it meant.
        ConnectionStatus::Disconnected(DisconnectKind::Closed) => "disconnected".to_string(),
        ConnectionStatus::Disconnected(DisconnectKind::Lost) => "lost".to_string(),
        // Parsed by `parseReconnecting` in src/lib/connection.ts — keep the two
        // in step.
        ConnectionStatus::Reconnecting {
            attempt,
            in_seconds,
        } => format!("reconnecting: {attempt} in {in_seconds}"),
        ConnectionStatus::Failed(msg) => format!("failed: {msg}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wr_core::{ConnectionStatus, DisconnectKind};

    /// The frontend keys off these exact strings, and two of them have to stay
    /// distinguishable from each other for auto-reconnect to be expressible at
    /// all.
    #[test]
    fn a_clean_close_and_a_lost_transport_are_not_the_same_word() {
        assert_eq!(
            status_label(&ConnectionStatus::Disconnected(DisconnectKind::Closed)),
            "disconnected"
        );
        assert_eq!(
            status_label(&ConnectionStatus::Disconnected(DisconnectKind::Lost)),
            "lost"
        );
    }

    /// The shape `parseReconnecting` splits on.
    #[test]
    fn reconnecting_carries_its_attempt_and_countdown() {
        assert_eq!(
            status_label(&ConnectionStatus::Reconnecting {
                attempt: 3,
                in_seconds: 8,
            }),
            "reconnecting: 3 in 8"
        );
    }
}
