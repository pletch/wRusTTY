//! Encrypted local credential vault: Argon2id KDF + XChaCha20-Poly1305 AEAD,
//! zeroize-on-drop secrets, portable-file import/export (the encrypted file
//! itself is the export — copy it anywhere, unlock with the master password).

mod crypto;
mod error;
mod secret;
mod vault;

pub use error::VaultError;
pub use secret::VaultSecret;
pub use vault::{exists, Vault};
