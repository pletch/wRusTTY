//! Encrypted local credential vault.
//!
//! One random **DEK** encrypts the entries (XChaCha20-Poly1305), and one
//! **wrapper** per unlock method holds an encrypted copy of it. Unlocking asks
//! a [`KeyProvider`] for its KEK, unwraps the DEK and decrypts the entries;
//! changing unlock methods never re-encrypts them. Secrets zeroize on drop,
//! and the encrypted file is its own export format.
//!
//! Pre-wrapper files are upgraded the first time they're unlocked with the
//! master password; see `vault.rs`.

mod crypto;
mod error;
mod key;
mod provider;
mod secret;
mod vault;
mod wrapper;

pub use error::VaultError;
pub use key::Kek;
pub use provider::{KeyProvider, PasswordProvider, ProviderError};
pub use secret::VaultSecret;
pub use vault::{exists, unlock_methods_at, validate, wrappers_at, Vault};
pub use wrapper::{WrapperKind, WrapperMeta, WrapperParams};

/// Re-exported so out-of-crate `KeyProvider`s needn't depend on
/// `async-trait` themselves.
pub use async_trait::async_trait;

/// HKDF-SHA256, for providers whose input is already full-entropy (a TPM
/// signature, say). Exposed for providers outside this crate, such as Windows
/// Hello. Not for passphrases; see [`crypto::derive_kek_from_password`].
pub fn derive_kek_from_ikm(ikm: &[u8], salt: &[u8], info: &[u8]) -> Kek {
    crypto::derive_kek_from_ikm(ikm, salt, info)
}

/// Random bytes from the OS CSPRNG, for providers minting a challenge or KEK.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    crypto::random_bytes()
}
