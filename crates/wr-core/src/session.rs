use serde::{Deserialize, Serialize};

/// Opaque session identifier, shared by the session manager (Phase 2), the
/// vault (Phase 3), and the transport commands that key their in-memory
/// connection handles by it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Which transport a session uses. Drives which fields the session-manager
/// UI shows and which crate handles the connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Ssh,
    Telnet,
    Serial,
}
