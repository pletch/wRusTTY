use serde::{Deserialize, Serialize};
use zeroize::ZeroizeOnDrop;

/// A single stored credential. Kept out of `wr-core`/`wr-ssh` since only the
/// vault needs to know secrets exist at rest; every other crate deals in
/// `AuthMethod` built fresh from a decrypted `VaultSecret` at connect time.
#[derive(Debug, Clone, Serialize, Deserialize, ZeroizeOnDrop)]
#[serde(tag = "type")]
pub enum VaultSecret {
    Password { password: String },
    Passphrase { passphrase: String },
}
