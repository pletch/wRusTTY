//! Wrappers: one per enabled unlock method, each holding its own encrypted
//! copy of the vault's single DEK.
//!
//! This is the whole reason for the v2 format. In v1 the Argon2id output
//! *was* the file key, so there could only ever be one way in, and the
//! "unlock with Windows sign-in" feature had to work around that by stashing
//! a plaintext copy of that key in the OS credential store. Here the DEK is
//! random and independent, and each unlock method contributes only a KEK that
//! wraps it — so methods can be added, removed, and rotated freely, and no
//! method's failure mode can take the others down with it.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::crypto;
use crate::error::VaultError;
use crate::key::{Dek, Kek, KEY_LEN};

/// Which unlock method a wrapper belongs to. A vault holds at most one
/// wrapper per kind — the UI presents these as a list of toggles, and
/// "two Windows Hello wrappers" has no meaning to a user. Enrolling a kind
/// that's already present replaces it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WrapperKind {
    /// Argon2id over the master password. Always present — see
    /// `Vault::remove_unlock_method`.
    Password,
    /// HKDF over a TPM-backed Windows Hello signature. Nothing recoverable
    /// at rest: opening this wrapper requires a live user gesture.
    Hello,
    /// A random KEK held in the OS credential store (DPAPI on Windows).
    /// Transitional — see the note on [`WrapperParams::OsKeyring`].
    OsKeyring,
    /// Output of a user-configured command, treated as a passphrase.
    External,
}

impl WrapperKind {
    /// Stable wire/AAD spelling. Written out by hand rather than reusing the
    /// serde rename, so a future `rename_all` tweak can't silently change
    /// what got bound into every existing wrapper's AEAD tag.
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
/// None of these fields is secret: a salt, a challenge, and a command name
/// are all public inputs whose secrecy the scheme never relies on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WrapperParams {
    Password {
        salt: String,
        m_cost: u32,
        t_cost: u32,
        p_cost: u32,
    },
    /// `challenge` is the fixed buffer signed on every unlock; `hkdf_salt`
    /// separates this vault's KEK from any other use of the same credential.
    /// `credential_name` is the Windows Hello key-credential container name,
    /// stored so a vault copied between machines can report *which* credential
    /// it wants rather than just failing.
    ///
    /// `attested` records whether the key credential produced a successful
    /// TPM attestation when it was created. `KeyCredentialManager` reports
    /// itself as supported whenever Hello is enrolled, including on machines
    /// with no TPM where it falls back to a software key store — so this is
    /// the only honest way to tell a user which of the two they actually got.
    /// Defaulted so a wrapper written before this field existed reads as
    /// "unknown, assume not attested" rather than failing to parse.
    Hello {
        challenge: String,
        hkdf_salt: String,
        credential_name: String,
        #[serde(default)]
        attested: bool,
    },
    /// Carries no parameters: the KEK lives in the OS credential store under
    /// a fixed service name, and the store is the whole mechanism.
    ///
    /// This exists to preserve today's "unlock with Windows sign-in" feature
    /// through the format change, not because it's good. It is exactly as
    /// strong as v1's arrangement — which is to say any process running as
    /// the user can read the KEK back with no prompt — and the point of the
    /// format is that replacing it with [`WrapperKind::Hello`] is now a
    /// provider swap instead of a rewrite.
    OsKeyring {},
    /// The command's stdout is treated as a *passphrase* and stretched with
    /// Argon2id, never used as raw key material — an external helper that
    /// returns something short or low-entropy must not silently become a
    /// 32-byte key with 20 bits behind it.
    ///
    /// # Security
    ///
    /// **Nothing implements this yet, and whatever does must read this first.**
    /// The variant already exists and looks settled, which is exactly how the
    /// following gets missed.
    ///
    /// `command` is **untrusted input read from a file**, not a user
    /// preference. `vault_import` will happily overwrite the vault with a
    /// bundle someone else wrote, and every field in it — this one included —
    /// arrives from that file. An implementation that simply runs what the
    /// file says turns "the user imported a backup" into arbitrary code
    /// execution as that user. That is a file-write-to-code-execution edge,
    /// and it is the reason `wr_vault::validate` cannot be the thing that
    /// saves you: validation can tell that a string is present, never that
    /// running it is safe.
    ///
    /// So an implementation must:
    ///
    /// - require explicit user confirmation of the exact command **at
    ///   enrolment**, showing what will be run;
    /// - never execute whatever the file happens to say **at unlock** — unlock
    ///   is not a moment where the user is deciding anything, and a prompt
    ///   there gets clicked through;
    /// - re-confirm on any change to the stored command, since a changed
    ///   command is a new decision and not the one already approved.
    ///
    /// Note also that nothing else in this workspace runs a subprocess — there
    /// is no `std::process::Command` anywhere in it — so implementing this
    /// introduces the first one, and with it every question about argument
    /// quoting, `PATH` resolution and inherited environment that the codebase
    /// has so far not had to have an answer for.
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

/// The public, non-secret view of one wrapper, handed to a provider so it can
/// reconstruct its KEK. Notably does *not* include the wrapped DEK: a
/// provider has no business seeing ciphertext it can't open and no reason to
/// see the one it can.
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

/// Binds a wrapper's ciphertext to its identity and its kind.
///
/// Without this, an attacker with write access to the vault file could
/// relabel a password wrapper as `hello` — the app would then hand its bytes
/// to the TPM-signature derivation path instead of Argon2id. Nothing
/// *breaks* if they do (the tag would fail either way, since the KEK
/// wouldn't match), but the failure arrives as a clear kind mismatch rather
/// than as a confusing wrong-key error from the wrong subsystem. Cheap, so
/// it's worth having.
fn aad(id: &str, kind: WrapperKind) -> Vec<u8> {
    // Unit separator: not producible by the hex ids or the fixed kind
    // strings, so no two (id, kind) pairs can collide by concatenation.
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

/// A tag mismatch here is the ordinary "wrong password" path, not corruption
/// — the caller decides how to phrase that, since it depends on the kind.
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
            // Preserved verbatim so the existing frontend copy for a mistyped
            // master password keeps matching.
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

    /// Non-password kinds must not claim "incorrect master password" — for a
    /// Hello wrapper the real cause is almost always a rotated credential.
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

    /// Relabelling the kind must fail even though the KEK is correct.
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

    /// The on-disk spelling is a compatibility surface: changing it silently
    /// orphans every existing wrapper of that kind.
    #[test]
    fn kind_tags_serialize_to_their_documented_names() {
        let json = serde_json::to_value(WrapperParams::OsKeyring {}).unwrap();
        assert_eq!(json["kind"], "os-keyring");
        let json = serde_json::to_value(params()).unwrap();
        assert_eq!(json["kind"], "password");
    }
}
