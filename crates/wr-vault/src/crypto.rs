use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use zeroize::Zeroize;

use crate::error::VaultError;

pub const SALT_LEN: usize = 16;
const KEY_LEN: usize = 32;

/// Explicit Argon2id + version 0x13 rather than relying on the crate's
/// unstated `Default` — this is the one place a silent algorithm change
/// upstream would matter most.
fn kdf() -> Argon2<'static> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::default())
}

pub fn random_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    salt
}

pub fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], VaultError> {
    let mut key = [0u8; KEY_LEN];
    kdf()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| VaultError::Kdf(e.to_string()))?;
    Ok(key)
}

/// Returns `(nonce, ciphertext)`. A fresh random nonce is generated on
/// every call — required for AEAD safety when re-encrypting after each edit.
pub fn encrypt(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), VaultError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|_| VaultError::Corrupt("encryption failed".into()))?;
    Ok((nonce.to_vec(), ciphertext))
}

/// A decryption failure (AEAD tag mismatch) is how a wrong master password
/// is detected — no separate password-verification step exists or is needed.
pub fn decrypt(
    key: &[u8; KEY_LEN],
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, VaultError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = XNonce::from_slice(nonce);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| VaultError::WrongPassword)
}

pub fn zeroize_key(key: &mut [u8; KEY_LEN]) {
    key.zeroize();
}
