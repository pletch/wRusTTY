use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;

use crate::error::VaultError;
use crate::key::{Kek, KEY_LEN};

pub const SALT_LEN: usize = 16;

/// Bound into the entries blob's AEAD tag so a v2 ciphertext can't be
/// replayed into some future format revision that means something different
/// by the same bytes.
pub(crate) const ENTRIES_AAD: &[u8] = b"wrustty-vault-v2-entries";

/// Stronger than the argon2 crate's own `Params::default()` (19 MiB, t=2,
/// p=1 — the RFC 9106 low-memory floor), which is a bit light for a desktop
/// vault guarding private keys. New password wrappers use this; existing
/// wrappers keep whatever params they were created with (stored per-wrapper
/// in the vault file — see `WrapperParams::Password`), so bumping these
/// later never breaks anyone's ability to decrypt their existing vault.
pub fn default_params() -> Params {
    Params::new(65536, 3, 1, None).expect("hardcoded Argon2 params are valid")
}

/// Explicit Argon2id + version 0x13 rather than relying on the crate's
/// unstated `Default` — this is the one place a silent algorithm change
/// upstream would matter most.
fn kdf(params: Params) -> Argon2<'static> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

pub fn random_salt() -> [u8; SALT_LEN] {
    random_bytes()
}

/// Argon2id over something a human typed. Deliberately returns a [`Kek`]
/// rather than a bare array so the derived bytes are zeroized on drop and
/// can't be silently copied.
pub fn derive_kek_from_password(
    password: &str,
    salt: &[u8],
    params: Params,
) -> Result<Kek, VaultError> {
    let mut key = [0u8; KEY_LEN];
    kdf(params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| VaultError::Kdf(e.to_string()))?;
    Ok(Kek::from_bytes(key))
}

/// HKDF-SHA256 for inputs that are *already* full-entropy — a TPM signature
/// over a stored challenge, say. Do not reach for this to process a
/// passphrase: HKDF is a key-derivation function, not a password hash, and
/// applies no work factor whatsoever. Human-typed input goes through
/// [`derive_kek_from_password`].
pub fn derive_kek_from_ikm(ikm: &[u8], salt: &[u8], info: &[u8]) -> Kek {
    let mut key = [0u8; KEY_LEN];
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, &mut key)
        // Only fails for output longer than 255 * 32 bytes; ours is 32.
        .expect("32-byte HKDF output is always a valid length");
    Kek::from_bytes(key)
}

/// Returns `(nonce, ciphertext)`. A fresh random nonce is generated on
/// every call — required for AEAD safety when re-encrypting after each edit.
pub fn encrypt(
    key: &[u8; KEY_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), VaultError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| VaultError::Corrupt("encryption failed".into()))?;
    Ok((nonce.to_vec(), ciphertext))
}

/// Returns `None` on an AEAD tag mismatch rather than an error, because the
/// *meaning* of a mismatch depends entirely on the caller: unwrapping a DEK
/// it means the wrong key was supplied (an ordinary, expected outcome —
/// mistyped password), whereas decrypting the entries blob with a DEK that
/// already authenticated correctly it means the file is damaged. Folding
/// both into one error variant here is how you end up telling someone their
/// password is wrong when their disk is actually failing.
pub fn decrypt(
    key: &[u8; KEY_LEN],
    nonce: &[u8],
    ciphertext: &[u8],
    aad: &[u8],
) -> Option<Vec<u8>> {
    if nonce.len() != 24 {
        return None;
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_with_matching_aad() {
        let key = [7u8; KEY_LEN];
        let (nonce, ct) = encrypt(&key, b"hello", b"context").unwrap();
        assert_eq!(
            decrypt(&key, &nonce, &ct, b"context").as_deref(),
            Some(&b"hello"[..])
        );
    }

    /// The whole point of threading AAD through: a wrapper blob relabelled
    /// as a different kind, or moved to a different wrapper id, must fail to
    /// open rather than being fed to the wrong derivation path.
    #[test]
    fn mismatched_aad_fails_to_decrypt() {
        let key = [7u8; KEY_LEN];
        let (nonce, ct) = encrypt(&key, b"hello", b"context").unwrap();
        assert_eq!(decrypt(&key, &nonce, &ct, b"other context"), None);
    }

    #[test]
    fn wrong_key_fails_to_decrypt() {
        let (nonce, ct) = encrypt(&[7u8; KEY_LEN], b"hello", b"").unwrap();
        assert_eq!(decrypt(&[8u8; KEY_LEN], &nonce, &ct, b""), None);
    }

    /// `XNonce::from_slice` panics on a wrong-length slice, and nonce length
    /// comes straight out of an attacker-editable JSON file.
    #[test]
    fn truncated_nonce_is_rejected_without_panicking() {
        let key = [7u8; KEY_LEN];
        let (_, ct) = encrypt(&key, b"hello", b"").unwrap();
        assert_eq!(decrypt(&key, &[0u8; 4], &ct, b""), None);
    }

    #[test]
    fn hkdf_is_deterministic_and_salt_separated() {
        let a = derive_kek_from_ikm(b"signature", b"salt-a", b"info");
        let b = derive_kek_from_ikm(b"signature", b"salt-a", b"info");
        let c = derive_kek_from_ikm(b"signature", b"salt-b", b"info");
        assert_eq!(a.as_bytes(), b.as_bytes());
        assert_ne!(a.as_bytes(), c.as_bytes());
    }
}
