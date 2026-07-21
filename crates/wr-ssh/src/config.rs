use serde::{Deserialize, Serialize};
use zeroize::ZeroizeOnDrop;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// An SSH hop to connect and authenticate to first, tunneling this
    /// connection's own handshake through a `direct-tcpip` channel opened
    /// on it — the same shape as OpenSSH's `-J`/`ProxyJump`. `None` connects
    /// directly. Boxed since it's the same type one level down.
    #[serde(default)]
    pub jump: Option<Box<SshConfig>>,
    /// The `TERM` value sent with the PTY request. `None` uses
    /// [`DEFAULT_TERM_TYPE`], which is right for essentially every Unix host.
    /// It exists for the ones where it isn't: some network and embedded gear
    /// drives the screen badly (or refuses a PTY outright) unless told
    /// `vt100`, and there is no way to discover that except by asking the
    /// user.
    #[serde(default)]
    pub term_type: Option<String>,
}

/// What we claim to be when no session overrides it. 256-colour xterm is what
/// every modern terminal advertises and what xterm.js actually implements.
pub const DEFAULT_TERM_TYPE: &str = "xterm-256color";

impl SshConfig {
    pub fn term_type(&self) -> &str {
        self.term_type.as_deref().unwrap_or(DEFAULT_TERM_TYPE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn term_type_falls_back_to_the_default() {
        assert_eq!(SshConfig::default().term_type(), DEFAULT_TERM_TYPE);
    }

    #[test]
    fn term_type_override_is_used_verbatim() {
        let config = SshConfig {
            term_type: Some("vt100".into()),
            ..Default::default()
        };
        assert_eq!(config.term_type(), "vt100");
    }

    /// A profile saved before `term_type` existed must still deserialize —
    /// otherwise adding this field silently orphans every saved session.
    #[test]
    fn config_without_term_type_still_parses() {
        let json = r#"{"host":"h","port":22,"username":"u",
                       "auth":{"type":"Password","password":"p"}}"#;
        let config: SshConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.term_type(), DEFAULT_TERM_TYPE);
    }

    /// `Agent` carries no fields, so it has to survive the round trip as a
    /// bare tag — a shape serde handles differently from the struct variants
    /// beside it.
    #[test]
    fn agent_auth_round_trips() {
        let json = serde_json::to_string(&AuthMethod::Agent).unwrap();
        assert_eq!(json, r#"{"type":"Agent"}"#);
        assert!(matches!(
            serde_json::from_str::<AuthMethod>(&json).unwrap(),
            AuthMethod::Agent
        ));
    }
}

impl Default for SshConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 22,
            username: String::new(),
            auth: AuthMethod::Password {
                password: String::new(),
            },
            jump: None,
            term_type: None,
        }
    }
}

/// How to authenticate once the transport (and, for SSH, the host key) is
/// trusted. Kept in `wr-ssh` rather than `wr-core` since telnet/serial have
/// no equivalent concept.
///
/// `ZeroizeOnDrop` because these carry live secrets (passwords,
/// passphrases, whole private keys) cloned out of the vault at connect
/// time — the vault's own copies are zeroized on lock, and these
/// short-lived copies shouldn't be the ones left lingering in freed heap.
#[derive(Debug, Clone, Serialize, Deserialize, ZeroizeOnDrop)]
#[serde(tag = "type")]
pub enum AuthMethod {
    Password {
        password: String,
    },
    PublicKey {
        key_path: String,
        passphrase: Option<String>,
    },
    /// Same as `PublicKey` but the key itself is already in hand (loaded
    /// from the vault) rather than needing to be read from disk — built
    /// only on the Rust side (`resolve_auth`), never sent from or parsed on
    /// the frontend.
    PublicKeyMaterial {
        key_material: String,
        passphrase: Option<String>,
    },
    /// PAM/2FA-style challenge-response auth. The actual prompt/response
    /// round-trip happens through `HostKeyVerifier`'s sibling in the
    /// session layer (Phase 1 follow-up); this variant just selects it.
    KeyboardInteractive,
    /// Delegate to a running SSH agent: Pageant, or the Windows OpenSSH
    /// agent service.
    ///
    /// Carries no secret, and that is the point — the agent holds the
    /// decrypted key and performs the signature, so no key material ever
    /// enters this process. It is also the *only* way to use a key that
    /// physically cannot be exported: FIDO2 security keys, PIV smartcards,
    /// YubiKeys. Those are unreachable through every other variant here, no
    /// matter what the vault stores.
    Agent,
}
