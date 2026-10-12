use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;

use crate::error::VaultError;
use crate::key::{Kek, KEY_LEN};

pub const SALT_LEN: usize = 16;

/// Bound into the entries blob's AEAD tag, so v2 ciphertext can't be replayed
/// into a future format.
pub(crate) const ENTRIES_AAD: &[u8] = b"wrustty-vault-v2-entries";

/// Stronger than the argon2 crate's `Params::default()` (19 MiB, t=2, p=1, the
/// RFC 9106 low-memory floor). New password wrappers use these; existing ones
/// keep their stored params (`WrapperParams::Password`), so raising these
/// never breaks a vault.
pub fn default_params() -> Params {
    Params::new(65536, 3, 1, None).expect("hardcoded Argon2 params are valid")
}

/// Ceilings on Argon2 costs read from a vault file.
///
/// A sanity bound, not a strength check: a tampered parameter changes the
/// KEK, so the file just fails to unwrap. It bounds allocation: `m_cost` near
/// `u32::MAX` KiB asks for ~4 TiB, and `vault_import` makes the file
/// attacker-reachable. Far above any legitimate vault (current default 64 MiB
/// / t=3 / p=1; legacy v1 19 MiB / t=2 / p=1).
pub const MAX_M_COST: u32 = 1024 * 1024; // 1 GiB, in KiB
pub const MAX_T_COST: u32 = 64;
pub const MAX_P_COST: u32 = 16;

/// Builds [`Params`] from stored values, refusing absurd costs before Argon2
/// allocates (see [`MAX_M_COST`]).
pub fn params_from_stored(m_cost: u32, t_cost: u32, p_cost: u32) -> Result<Params, VaultError> {
    if m_cost > MAX_M_COST || t_cost > MAX_T_COST || p_cost > MAX_P_COST {
        return Err(VaultError::Corrupt(format!(
            "stored KDF params are out of range: m={m_cost} t={t_cost} p={p_cost}"
        )));
    }
    Params::new(m_cost, t_cost, p_cost, None)
        .map_err(|e| VaultError::Corrupt(format!("invalid stored KDF params: {e}")))
}

/// Explicit Argon2id, version 0x13, rather than the crate's unstated
/// `Default`.
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

/// Argon2id over something a human typed. Returns a [`Kek`], zeroized on drop.
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

/// HKDF-SHA256 for already full-entropy input (a TPM signature, say). Never
/// for passphrases: HKDF has no work factor; use
/// [`derive_kek_from_password`].
pub fn derive_kek_from_ikm(ikm: &[u8], salt: &[u8], info: &[u8]) -> Kek {
    let mut key = [0u8; KEY_LEN];
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, &mut key)
        // Fails only past 255 * 32 bytes; ours is 32.
        .expect("32-byte HKDF output is always a valid length");
    Kek::from_bytes(key)
}

/// Returns `(nonce, ciphertext)` with a fresh random nonce each call.
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

/// Returns `None` on a tag mismatch, since its meaning depends on the caller:
/// unwrapping a DEK, it's a wrong key (a mistyped password); decrypting
/// entries with an authenticated DEK, it's a damaged file.
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

    /// A wrapper blob relabeled as another kind, or moved to another id, fails
    /// to open.
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

    /// A wrong-length nonce (from attacker-editable JSON) mustn't panic
    /// `XNonce::from_slice`.
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

    /// Returns rather than allocating ~4 TiB.
    #[test]
    fn an_absurd_memory_cost_is_rejected_rather_than_allocated() {
        assert!(matches!(
            params_from_stored(u32::MAX, 3, 1),
            Err(VaultError::Corrupt(_))
        ));
    }

    #[test]
    fn absurd_time_and_parallelism_costs_are_rejected() {
        assert!(params_from_stored(65536, u32::MAX, 1).is_err());
        assert!(params_from_stored(65536, 3, u32::MAX).is_err());
    }

    /// Current and legacy v1 defaults both still derive.
    #[test]
    fn every_parameter_set_a_real_vault_can_hold_still_passes() {
        let current = default_params();
        assert!(
            params_from_stored(current.m_cost(), current.t_cost(), current.p_cost()).is_ok(),
            "the current defaults must round-trip through the bound"
        );
        // Legacy v1: 19 MiB / t=2 / p=1.
        assert!(params_from_stored(19 * 1024, 2, 1).is_ok());
    }

    /// Exactly at the ceiling is accepted.
    #[test]
    fn the_ceiling_itself_is_accepted() {
        assert!(params_from_stored(MAX_M_COST, MAX_T_COST, MAX_P_COST).is_ok());
        assert!(params_from_stored(MAX_M_COST + 1, 3, 1).is_err());
    }
}
