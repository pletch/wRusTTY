use serde::{Deserialize, Serialize};
use zeroize::ZeroizeOnDrop;

use crate::proxy::ProxyConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// An SSH hop to connect through first, tunneling this handshake through a
    /// `direct-tcpip` channel (OpenSSH's `ProxyJump`). `None` connects directly.
    #[serde(default)]
    pub jump: Option<Box<SshConfig>>,
    /// The `TERM` sent with the PTY request; `None` uses [`DEFAULT_TERM_TYPE`].
    /// Some network and embedded gear needs `vt100`, and only the user knows.
    #[serde(default)]
    pub term_type: Option<String>,
    /// Seconds between keepalives, or `None` for
    /// [`DEFAULT_KEEPALIVE_INTERVAL`]. Firewalls and NAT often drop idle flows
    /// after 5-10 minutes silently. `0` disables them, as in PuTTY (a few devices
    /// respond badly).
    #[serde(default)]
    pub keepalive_seconds: Option<u64>,
    /// Open the first socket through an outbound proxy (HTTP `CONNECT` or
    /// SOCKS5). With a jump host, the proxy reaches the jump host. `None`
    /// connects directly.
    #[serde(default)]
    pub proxy: Option<ProxyConfig>,
}

/// The default `TERM`. A terminfo name, not a claim about the engine.
pub const DEFAULT_TERM_TYPE: &str = "xterm-256color";

/// Inside every common NAT/firewall idle timeout, at one message a minute.
pub const DEFAULT_KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// Missed keepalives before the link is dead: about three minutes at the
/// default interval.
pub const KEEPALIVE_MAX: usize = 3;

impl SshConfig {
    pub fn term_type(&self) -> &str {
        self.term_type.as_deref().unwrap_or(DEFAULT_TERM_TYPE)
    }

    /// The interval for russh; `None` (from an explicit `0`) disables
    /// keepalives.
    pub fn keepalive_interval(&self) -> Option<std::time::Duration> {
        match self.keepalive_seconds {
            None => Some(DEFAULT_KEEPALIVE_INTERVAL),
            Some(0) => None,
            Some(secs) => Some(std::time::Duration::from_secs(secs)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn term_type_falls_back_to_the_default() {
        assert_eq!(SshConfig::default().term_type(), DEFAULT_TERM_TYPE);
    }

    /// Profiles without the field keep the default keepalive.
    #[test]
    fn an_unset_keepalive_uses_the_default_interval() {
        assert_eq!(
            SshConfig::default().keepalive_interval(),
            Some(DEFAULT_KEEPALIVE_INTERVAL)
        );
    }

    /// `0` means off, as in PuTTY.
    #[test]
    fn zero_disables_keepalives_entirely() {
        let config = SshConfig {
            keepalive_seconds: Some(0),
            ..Default::default()
        };
        assert_eq!(config.keepalive_interval(), None);
    }

    #[test]
    fn an_explicit_interval_is_used_verbatim() {
        let config = SshConfig {
            keepalive_seconds: Some(15),
            ..Default::default()
        };
        assert_eq!(
            config.keepalive_interval(),
            Some(std::time::Duration::from_secs(15))
        );
    }

    #[test]
    fn term_type_override_is_used_verbatim() {
        let config = SshConfig {
            term_type: Some("vt100".into()),
            ..Default::default()
        };
        assert_eq!(config.term_type(), "vt100");
    }

    /// A profile without `term_type` still deserializes.
    #[test]
    fn config_without_term_type_still_parses() {
        let json = r#"{"host":"h","port":22,"username":"u",
                       "auth":{"type":"Password","password":"p"}}"#;
        let config: SshConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.term_type(), DEFAULT_TERM_TYPE);
    }

    /// `Agent` round-trips as a bare tag, unlike the struct variants beside it.
    #[test]
    fn agent_auth_round_trips() {
        let json = serde_json::to_string(&AuthMethod::Agent).unwrap();
        assert_eq!(json, r#"{"type":"Agent"}"#);
        assert!(matches!(
            serde_json::from_str::<AuthMethod>(&json).unwrap(),
            AuthMethod::Agent
        ));
    }

    #[test]
    fn debug_does_not_leak_password() {
        let auth = AuthMethod::Password {
            password: "hunter2".into(),
        };
        assert_eq!(format!("{auth:?}"), "Password(<redacted>)");
    }

    #[test]
    fn debug_does_not_leak_key_material() {
        let auth = AuthMethod::PublicKeyMaterial {
            key_material: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n".into(),
            passphrase: Some("hunter2".into()),
        };
        let rendered = format!("{auth:?}");
        assert_eq!(rendered, "PublicKeyMaterial(<redacted>)");
        assert!(!rendered.contains("secret"));
        assert!(!rendered.contains("hunter2"));
    }

    /// The path is shown; the passphrase isn't.
    #[test]
    fn debug_shows_key_path_but_not_its_passphrase() {
        let auth = AuthMethod::PublicKey {
            key_path: "~/.ssh/id_ed25519".into(),
            passphrase: Some("hunter2".into()),
        };
        let rendered = format!("{auth:?}");
        assert!(rendered.contains("~/.ssh/id_ed25519"));
        assert!(!rendered.contains("hunter2"));
    }

    /// `SshConfig`'s derived `Debug` (what actually gets logged) inherits
    /// `AuthMethod`'s redaction.
    #[test]
    fn ssh_config_debug_does_not_leak_its_auth() {
        let config = SshConfig {
            host: "example.com".into(),
            username: "root".into(),
            auth: AuthMethod::Password {
                password: "hunter2".into(),
            },
            ..Default::default()
        };
        let rendered = format!("{config:?}");
        assert!(!rendered.contains("hunter2"));
        // Non-secret fields remain, or the diagnostic is useless.
        assert!(rendered.contains("example.com"));
    }

    /// A jump host's nested `auth` is redacted too.
    #[test]
    fn ssh_config_debug_does_not_leak_a_jump_hosts_auth() {
        let config = SshConfig {
            host: "target".into(),
            jump: Some(Box::new(SshConfig {
                host: "bastion".into(),
                auth: AuthMethod::Password {
                    password: "jumppw".into(),
                },
                ..Default::default()
            })),
            ..Default::default()
        };
        let rendered = format!("{config:?}");
        assert!(!rendered.contains("jumppw"));
        assert!(rendered.contains("bastion"));
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
            keepalive_seconds: None,
            proxy: None,
        }
    }
}

/// How to authenticate once the transport and host key are trusted.
///
/// `ZeroizeOnDrop`: these carry secrets cloned out of the vault at connect.
/// `Deserialize` is needed inbound (`ssh_connect` receives an `SshConfig` from
/// the webview), but nothing here may be serialized outbound, to disk or logs;
/// session snapshots drop ad hoc SSH panes for this reason.
#[derive(Clone, Serialize, Deserialize, ZeroizeOnDrop)]
#[serde(tag = "type")]
pub enum AuthMethod {
    Password {
        password: String,
    },
    PublicKey {
        key_path: String,
        passphrase: Option<String>,
    },
    /// `PublicKey` with the key already loaded from the vault. Built only by
    /// `resolve_auth`, never sent from the frontend.
    PublicKeyMaterial {
        key_material: String,
        passphrase: Option<String>,
    },
    /// PAM/2FA-style challenge-response; the prompts round-trip through the
    /// session layer.
    KeyboardInteractive,
    /// Delegate to a running SSH agent (Pageant, or the Windows OpenSSH agent).
    /// No key material enters this process, and it's the only way to use
    /// unexportable keys (FIDO2, PIV smartcards, YubiKeys).
    Agent,
}

/// Hand-written, like `Dek`/`Kek` in `wr-vault`'s `key.rs`: a derived `Debug`
/// is one `tracing::debug!` away from writing a password or private key into
/// the unencrypted logs folder. `key_path` is printed, since it tells "wrong
/// key" from "wrong passphrase"; anything secret isn't.
impl std::fmt::Debug for AuthMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Password { .. } => f.write_str("Password(<redacted>)"),
            Self::PublicKey { key_path, .. } => f
                .debug_struct("PublicKey")
                .field("key_path", key_path)
                .field("passphrase", &"<redacted>")
                .finish(),
            Self::PublicKeyMaterial { .. } => f.write_str("PublicKeyMaterial(<redacted>)"),
            Self::KeyboardInteractive => f.write_str("KeyboardInteractive"),
            Self::Agent => f.write_str("Agent"),
        }
    }
}
