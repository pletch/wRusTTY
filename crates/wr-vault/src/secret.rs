use serde::{Deserialize, Serialize};
use zeroize::ZeroizeOnDrop;

/// A single stored credential. Kept out of `wr-core`/`wr-ssh` since only the
/// vault needs to know secrets exist at rest; every other crate deals in
/// `AuthMethod` built fresh from a decrypted `VaultSecret` at connect time.
// Deliberately no enum-level `rename_all`: that renames the *tag* values
// too ("Password" -> "password"), not just field names, which breaks the
// frontend's existing `{ type: 'Password', ... }` / `{ type: 'Passphrase',
// ... }` wire format. Only `key_material` needs a rename, done per-field.
#[derive(Debug, Clone, Serialize, Deserialize, ZeroizeOnDrop)]
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
