use serde::{Deserialize, Serialize};

/// What we answer with when a server asks for our terminal type and the
/// session doesn't override it. Matches the SSH default (`wr_ssh`'s
/// `DEFAULT_TERM_TYPE`) deliberately — the two are separate protocols but the
/// same terminal, and a user has no reason to expect different behaviour from
/// the same host reached two ways.
pub const DEFAULT_TERM_TYPE: &str = "xterm-256color";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelnetConfig {
    pub host: String,
    pub port: u16,
    /// Sent in reply to the server's TERMINAL-TYPE subnegotiation (RFC 1091).
    /// `None` sends [`DEFAULT_TERM_TYPE`].
    ///
    /// This matters more here than it does over SSH. Telnet's remaining
    /// users are overwhelmingly network gear, console servers, and legacy
    /// systems — exactly the population whose screen handling wants `vt100`
    /// and misbehaves when told anything newer.
    #[serde(default)]
    pub term_type: Option<String>,
}

impl TelnetConfig {
    pub fn term_type(&self) -> &str {
        self.term_type.as_deref().unwrap_or(DEFAULT_TERM_TYPE)
    }
}

impl Default for TelnetConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 23,
            term_type: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn term_type_falls_back_to_the_default() {
        assert_eq!(TelnetConfig::default().term_type(), DEFAULT_TERM_TYPE);
    }

    #[test]
    fn term_type_override_is_used_verbatim() {
        let config = TelnetConfig {
            term_type: Some("vt100".into()),
            ..Default::default()
        };
        assert_eq!(config.term_type(), "vt100");
    }

    /// A config serialized before this field existed must still parse — the
    /// frontend sends this struct straight from a saved session snapshot.
    #[test]
    fn config_without_term_type_still_parses() {
        let config: TelnetConfig = serde_json::from_str(r#"{"host":"h","port":23}"#).unwrap();
        assert_eq!(config.term_type(), DEFAULT_TERM_TYPE);
    }
}
