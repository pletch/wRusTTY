//! Wrappers: one per enabled unlock method, each holding its own encrypted
//! copy of the vault's single DEK. The DEK is random and each method only
//! contributes a KEK that wraps it, so methods can be added, removed and
//! rotated independently.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::crypto;
use crate::error::VaultError;
use crate::key::{Dek, Kek, KEY_LEN};

/// Which unlock method a wrapper belongs to. At most one wrapper per kind;
/// enrolling a kind that's present replaces it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WrapperKind {
    /// Argon2id over the master password. Always present (see
    /// `Vault::remove_unlock_method`).
    Password,
    /// HKDF over a TPM-backed Windows Hello signature; needs a live gesture.
    Hello,
    /// A random KEK in the OS credential store (DPAPI on Windows). Transitional;
    /// see [`WrapperParams::OsKeyring`].
    OsKeyring,
    /// Output of a user-configured command, treated as a passphrase.
    External,
}

impl WrapperKind {
    /// Stable wire/AAD spelling, written by hand so a serde rename can't change
    /// what's bound into existing AEAD tags.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Hello => "hello",
            Self::OsKeyring => "os-keyring",
            Self::External => "external",
        }
    }

    /// How the UI names this method to a human.
    pub fn label(self) -> &'static str {
        match self {
            Self::Password => "master password",
            Self::Hello => "Windows Hello",
            Self::OsKeyring => "Windows sign-in",
            Self::External => "external command",
        }
    }
}

impl std::fmt::Display for WrapperKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.label())
    }
}

/// Everything a provider needs, stored in the clear, to reproduce its KEK.
/// None of it is secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WrapperParams {
    Password {
        salt: String,
        m_cost: u32,
        t_cost: u32,
        p_cost: u32,
    },
    /// `challenge` is signed on every unlock; `hkdf_salt` separates this vault's
    /// KEK from other uses of the credential. `credential_name` lets a vault on
    /// another machine say which credential it wants.
    ///
    /// `attested` records whether the credential passed TPM attestation at
    /// creation, the only way to tell a TPM from a software key store. Defaults
    /// to false for older wrappers.
    Hello {
        challenge: String,
        hkdf_salt: String,
        credential_name: String,
        #[serde(default)]
        attested: bool,
    },
    /// No parameters: the KEK lives in the OS credential store under a fixed
    /// service name. Kept for "unlock with Windows sign-in"; any process running
    /// as the user can read the KEK back without a prompt, so
    /// [`WrapperKind::Hello`] is the stronger replacement.
    OsKeyring {},
    /// The command's stdout is a passphrase stretched with Argon2id, never raw
    /// key material.
    ///
    /// # Security
    ///
    /// Nothing implements this yet; whatever does must read this first.
    ///
    /// `command` is untrusted input from a file: `vault_import` can overwrite the
    /// vault with a bundle someone else wrote. Running what the file says turns
    /// an import into arbitrary code execution, and `wr_vault::validate` can't
    /// tell whether a command is safe. An implementation must:
    ///
    /// - require explicit confirmation of the exact command at enrollment;
    /// - never run whatever the file says at unlock, where prompts get clicked
    ///   through;
    /// - re-confirm on any change to the stored command.
    ///
    /// It would also be the workspace's first `std::process::Command`, with the
    /// quoting, `PATH` and environment questions that brings.
    External {
        command: String,
        salt: String,
        m_cost: u32,
        t_cost: u32,
        p_cost: u32,
    },
}

impl WrapperParams {
    pub fn kind(&self) -> WrapperKind {
        match self {
            Self::Password { .. } => WrapperKind::Password,
            Self::Hello { .. } => WrapperKind::Hello,
            Self::OsKeyring {} => WrapperKind::OsKeyring,
            Self::External { .. } => WrapperKind::External,
        }
    }
}

/// The public view of one wrapper, handed to a provider to reconstruct its
/// KEK. Excludes the wrapped DEK, which a provider has no need to see.
#[derive(Debug, Clone)]
pub struct WrapperMeta {
    pub id: String,
    pub params: WrapperParams,
}

impl WrapperMeta {
    pub fn kind(&self) -> WrapperKind {
        self.params.kind()
    }
}

/// One wrapper as it appears on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StoredWrapper {
    pub(crate) id: String,
    pub(crate) params: WrapperParams,
    pub(crate) nonce: String,
    pub(crate) wrapped_dek: String,
}

impl StoredWrapper {
    pub(crate) fn meta(&self) -> WrapperMeta {
        WrapperMeta {
            id: self.id.clone(),
            params: self.params.clone(),
        }
    }
}

/// Binds a wrapper's ciphertext to its id and kind, so a relabeled wrapper
/// (say, password to `hello`) fails as a clear kind mismatch rather than a
/// confusing wrong-key error from the wrong subsystem.
fn aad(id: &str, kind: WrapperKind) -> Vec<u8> {
    // Unit separator: absent from hex ids and kind strings, so pairs can't
    // collide by concatenation.
    format!("wrustty-wrapper-v2\u{1f}{}\u{1f}{}", kind.as_str(), id).into_bytes()
}

pub(crate) fn wrap_dek(
    kek: &Kek,
    dek: &Dek,
    id: &str,
    kind: WrapperKind,
) -> Result<(String, String), VaultError> {
    let (nonce, ciphertext) = crypto::encrypt(kek.as_bytes(), dek.as_bytes(), &aad(id, kind))?;
    Ok((BASE64.encode(nonce), BASE64.encode(ciphertext)))
}

/// A tag mismatch here is the ordinary wrong-password path, not corruption;
/// the caller phrases it by kind.
pub(crate) fn unwrap_dek(kek: &Kek, stored: &StoredWrapper) -> Result<Dek, VaultError> {
    let kind = stored.params.kind();
    let nonce = BASE64.decode(&stored.nonce).map_err(|e| {
        VaultError::Corrupt(format!("wrapper {} has an invalid nonce: {e}", stored.id))
    })?;
    let ciphertext = BASE64.decode(&stored.wrapped_dek).map_err(|e| {
        VaultError::Corrupt(format!(
            "wrapper {} has an invalid wrapped key: {e}",
            stored.id
        ))
    })?;

    let plaintext = crypto::decrypt(kek.as_bytes(), &nonce, &ciphertext, &aad(&stored.id, kind))
        .ok_or(match kind {
            // Kept verbatim so the frontend's mistyped-password copy still matches.
            WrapperKind::Password => VaultError::WrongPassword,
            other => VaultError::UnlockFailed(other),
        })?;

    let bytes: [u8; KEY_LEN] = plaintext.as_slice().try_into().map_err(|_| {
        VaultError::Corrupt(format!(
            "wrapper {} unwrapped to {} bytes, expected {KEY_LEN}",
            stored.id,
            plaintext.len()
        ))
    })?;
    Ok(Dek::from_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> WrapperParams {
        WrapperParams::Password {
            salt: BASE64.encode([1u8; 16]),
            m_cost: 65536,
            t_cost: 3,
            p_cost: 1,
        }
    }

    fn stored(id: &str, kek: &Kek, dek: &Dek, params: WrapperParams) -> StoredWrapper {
        let (nonce, wrapped_dek) = wrap_dek(kek, dek, id, params.kind()).unwrap();
        StoredWrapper {
            id: id.to_string(),
            params,
            nonce,
            wrapped_dek,
        }
    }

    #[test]
    fn wrap_then_unwrap_recovers_the_dek() {
        let kek = Kek::random();
        let dek = Dek::random();
        let w = stored("abc123", &kek, &dek, params());
        assert_eq!(unwrap_dek(&kek, &w).unwrap().as_bytes(), dek.as_bytes());
    }

    #[test]
    fn wrong_kek_reports_wrong_password_for_a_password_wrapper() {
        let w = stored("abc123", &Kek::random(), &Dek::random(), params());
        match unwrap_dek(&Kek::random(), &w) {
            Err(VaultError::WrongPassword) => {}
            other => panic!("expected WrongPassword, got {other:?}"),
        }
    }

    /// Non-password kinds don't claim "incorrect master password" (for Hello,
    /// the cause is usually a rotated credential).
    #[test]
    fn wrong_kek_reports_unlock_failed_for_other_kinds() {
        let w = stored(
            "abc123",
            &Kek::random(),
            &Dek::random(),
            WrapperParams::OsKeyring {},
        );
        match unwrap_dek(&Kek::random(), &w) {
            Err(VaultError::UnlockFailed(WrapperKind::OsKeyring)) => {}
            other => panic!("expected UnlockFailed(OsKeyring), got {other:?}"),
        }
    }

    #[test]
    fn a_wrapper_moved_to_a_different_id_no_longer_opens() {
        let kek = Kek::random();
        let mut w = stored("abc123", &kek, &Dek::random(), params());
        w.id = "def456".to_string();
        assert!(unwrap_dek(&kek, &w).is_err());
    }

    /// Relabeling the kind must fail even though the KEK is correct.
    #[test]
    fn a_wrapper_relabelled_to_a_different_kind_no_longer_opens() {
        let kek = Kek::random();
        let mut w = stored("abc123", &kek, &Dek::random(), params());
        w.params = WrapperParams::OsKeyring {};
        assert!(unwrap_dek(&kek, &w).is_err());
    }

    #[test]
    fn corrupt_base64_is_reported_as_corruption_not_as_a_wrong_password() {
        let kek = Kek::random();
        let mut w = stored("abc123", &kek, &Dek::random(), params());
        w.wrapped_dek = "not base64!!".to_string();
        match unwrap_dek(&kek, &w) {
            Err(VaultError::Corrupt(_)) => {}
            other => panic!("expected Corrupt, got {other:?}"),
        }
    }

    /// The on-disk spelling is a compatibility surface.
    #[test]
    fn kind_tags_serialize_to_their_documented_names() {
        let json = serde_json::to_value(WrapperParams::OsKeyring {}).unwrap();
        assert_eq!(json["kind"], "os-keyring");
        let json = serde_json::to_value(params()).unwrap();
        assert_eq!(json["kind"], "password");
    }
}
