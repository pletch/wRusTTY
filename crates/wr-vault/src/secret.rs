use serde::{Deserialize, Serialize};
use zeroize::ZeroizeOnDrop;

/// A single stored credential. Kept out of `wr-core`/`wr-ssh` since only the
/// vault needs to know secrets exist at rest; every other crate deals in
/// `AuthMethod` built fresh from a decrypted `VaultSecret` at connect time.
// Deliberately no enum-level `rename_all`: that renames the *tag* values
// too ("Password" -> "password"), not just field names, which breaks the
// frontend's existing `{ type: 'Password', ... }` / `{ type: 'Passphrase',
// ... }` wire format. Only `key_material` needs a rename, done per-field.
#[derive(Clone, Serialize, Deserialize, ZeroizeOnDrop)]
#[serde(tag = "type")]
pub enum VaultSecret {
    Password {
        password: String,
    },
    Passphrase {
        passphrase: String,
    },
    /// A whole private key, stored alongside its own passphrase (if it has
    /// one) rather than as a separate `Passphrase` entry — the two travel
    /// together since neither is useful without the other.
    PrivateKey {
        #[serde(rename = "keyMaterial")]
        key_material: String,
        passphrase: Option<String>,
    },
}

/// Written by hand rather than derived, matching `Dek`/`Kek` in [`crate::key`]
/// — see the reasoning there. Every field on every variant of this type is a
/// secret by definition, so unlike `wr_ssh::AuthMethod` (which shows a key
/// path) there is nothing here worth printing beyond the variant name.
impl std::fmt::Debug for VaultSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Password { .. } => "Password(<redacted>)",
            Self::Passphrase { .. } => "Passphrase(<redacted>)",
            Self::PrivateKey { .. } => "PrivateKey(<redacted>)",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_does_not_leak_password() {
        let secret = VaultSecret::Password {
            password: "hunter2".into(),
        };
        assert_eq!(format!("{secret:?}"), "Password(<redacted>)");
    }

    #[test]
    fn debug_does_not_leak_passphrase() {
        let secret = VaultSecret::Passphrase {
            passphrase: "hunter2".into(),
        };
        assert_eq!(format!("{secret:?}"), "Passphrase(<redacted>)");
    }

    #[test]
    fn debug_does_not_leak_key_material() {
        let secret = VaultSecret::PrivateKey {
            key_material: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n".into(),
            passphrase: Some("hunter2".into()),
        };
        let rendered = format!("{secret:?}");
        assert_eq!(rendered, "PrivateKey(<redacted>)");
        assert!(!rendered.contains("secret"));
        assert!(!rendered.contains("hunter2"));
    }
}
