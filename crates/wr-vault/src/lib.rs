//! Encrypted local credential vault.
//!
//! A vault holds one random **DEK** that encrypts the credential entries
//! (XChaCha20-Poly1305), plus one **wrapper** per enabled unlock method, each
//! holding its own encrypted copy of that DEK. Unlocking means asking a
//! [`KeyProvider`] for its KEK, unwrapping the DEK, and decrypting the
//! entries; the entries themselves are never re-encrypted when unlock methods
//! or the master password change.
//!
//! Secrets are zeroize-on-drop throughout, and the encrypted file is its own
//! export format — copy it anywhere and open it with any method enrolled on
//! it (in practice, the master password, which is always present).
//!
//! Files written by the pre-wrapper format are upgraded in place the first
//! time they're unlocked with the master password; see `vault.rs`.

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

/// Re-exported so out-of-crate `KeyProvider` implementations don't need to
/// depend on `async-trait` themselves, or to match its exact version.
pub use async_trait::async_trait;

/// HKDF-SHA256, for providers whose input is already full-entropy key
/// material — a TPM signature over a stored challenge being the motivating
/// case. Exposed because those providers live outside this crate (the
/// Windows Hello one needs a window handle and the WinRT stack) but must
/// derive their KEK the same way this crate would.
///
/// Not for passphrases: see [`crypto::derive_kek_from_password`]'s note.
pub fn derive_kek_from_ikm(ikm: &[u8], salt: &[u8], info: &[u8]) -> Kek {
    crypto::derive_kek_from_ikm(ikm, salt, info)
}

/// Fresh random bytes from the OS CSPRNG, for providers that need to mint a
/// challenge or a KEK of their own at enrolment time.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    crypto::random_bytes()
}
