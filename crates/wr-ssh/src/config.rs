use serde::{Deserialize, Serialize};
use zeroize::ZeroizeOnDrop;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
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
}
