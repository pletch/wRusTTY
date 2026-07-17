use serde::{Deserialize, Serialize};
use zeroize::ZeroizeOnDrop;

/// A single stored credential. Kept out of `wr-core`/`wr-ssh` since only the
/// vault needs to know secrets exist at rest; every other crate deals in
/// `AuthMethod` built fresh from a decrypted `VaultSecret` at connect time.
#[derive(Debug, Clone, Serialize, Deserialize, ZeroizeOnDrop)]
#[serde(tag = "type", rename_all = "camelCase")]
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
        key_material: String,
        passphrase: Option<String>,
    },
}
