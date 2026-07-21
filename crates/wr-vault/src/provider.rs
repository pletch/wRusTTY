//! The unlock-method abstraction.
//!
//! A provider's entire job is to produce a [`Kek`]. It never sees the DEK,
//! never sees ciphertext, and never touches the vault file — so a buggy or
//! hostile provider implementation can fail to unlock, but cannot leak the
//! credentials. Adding an unlock method means implementing this trait and
//! nothing else; the vault side is already generic over it.

use async_trait::async_trait;
use zeroize::Zeroizing;

use crate::crypto;
use crate::error::VaultError;
use crate::key::Kek;
use crate::wrapper::{WrapperKind, WrapperMeta, WrapperParams};

/// Why an unlock method couldn't produce a key. These are separated because
/// the UI has to react differently to each: a cancelled gesture is not an
/// error worth surfacing, a rotated Hello credential needs a re-enrolment
/// prompt, and an unavailable TPM needs the method hidden entirely. Collapsing
/// them into a string — as the current Tauri command layer does — makes all
/// three look like the same failure.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    /// The user dismissed the prompt. Expected; don't alarm anyone.
    #[error("cancelled")]
    Cancelled,

    /// The method has never been set up on this machine (no Hello enrolled,
    /// no keyring entry). Offer enrolment.
    #[error("{0}")]
    NotEnrolled(String),

    /// The method was set up, but its underlying key no longer exists or no
    /// longer produces the same output — a reset PIN, a cleared Hello
    /// container, a moved profile. The wrapper is dead; the user must unlock
    /// another way and re-enrol this one.
    #[error("{0}")]
    Invalidated(String),

    /// The method can't work on this system at all (no TPM, no Hello, wrong
    /// OS). Hide it rather than offering it.
    #[error("{0}")]
    Unavailable(String),

    /// A provider was handed a wrapper belonging to a different method.
    /// Always a programming error on the vault side.
    #[error("expected a {expected} wrapper, got a {found} one")]
    WrongKind {
        expected: WrapperKind,
        found: WrapperKind,
    },

    #[error("{0}")]
    Failed(String),
}

/// Produces the key-encryption key for one unlock method.
///
/// Async because the interesting implementations block on something outside
/// this process: Windows Hello waits on a physical gesture, an external
/// command waits on a child process. Both `kek_for` and `enroll` may prompt
/// the user, so callers must assume each call is user-visible and avoid
/// speculatively invoking them.
#[async_trait]
pub trait KeyProvider: Send + Sync {
    fn kind(&self) -> WrapperKind;

    /// Reproduce the KEK for an existing wrapper. `meta.params` is whatever
    /// this provider wrote at enrolment.
    async fn kek_for(&self, meta: &WrapperMeta) -> Result<Kek, ProviderError>;

    /// Set the method up and mint a fresh KEK, returning the parameters
    /// needed to reproduce it later. The vault assigns the wrapper id.
    async fn enroll(&self) -> Result<(WrapperParams, Kek), ProviderError>;
}

/// Argon2id over a master password.
///
/// Holds the password for the duration of one unlock. `Zeroizing<String>`
/// rather than `String` because this is the one provider whose input the user
/// typed and may well reuse elsewhere.
pub struct PasswordProvider {
    password: Zeroizing<String>,
}

impl PasswordProvider {
    pub fn new(password: &str) -> Self {
        Self {
            password: Zeroizing::new(password.to_string()),
        }
    }

    /// Shared by `kek_for` and by the v1 migration path in `vault.rs`, which
    /// needs to derive a key from the *old* file's salt and cost parameters
    /// before it can re-key onto the new format.
    pub(crate) fn derive(
        &self,
        salt_b64: &str,
        m_cost: u32,
        t_cost: u32,
        p_cost: u32,
    ) -> Result<Kek, VaultError> {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine as _;

        let salt = BASE64
            .decode(salt_b64)
            .map_err(|e| VaultError::Corrupt(format!("invalid password wrapper salt: {e}")))?;
        let params = argon2::Params::new(m_cost, t_cost, p_cost, None)
            .map_err(|e| VaultError::Corrupt(format!("invalid stored KDF params: {e}")))?;
        crypto::derive_kek_from_password(&self.password, &salt, params)
    }

    /// The body of [`KeyProvider::enroll`], minus the async wrapper. Argon2id
    /// needs no I/O, so `Vault::create` and the synchronous unlock path can
    /// use this directly instead of dragging a runtime in behind them.
    pub(crate) fn enroll_sync(&self) -> Result<(WrapperParams, Kek), VaultError> {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine as _;

        let salt = crypto::random_salt();
        let params = crypto::default_params();
        let kek = crypto::derive_kek_from_password(&self.password, &salt, params.clone())?;
        Ok((
            WrapperParams::Password {
                salt: BASE64.encode(salt),
                m_cost: params.m_cost(),
                t_cost: params.t_cost(),
                p_cost: params.p_cost(),
            },
            kek,
        ))
    }
}

#[async_trait]
impl KeyProvider for PasswordProvider {
    fn kind(&self) -> WrapperKind {
        WrapperKind::Password
    }

    async fn kek_for(&self, meta: &WrapperMeta) -> Result<Kek, ProviderError> {
        let WrapperParams::Password {
            salt,
            m_cost,
            t_cost,
            p_cost,
        } = &meta.params
        else {
            return Err(ProviderError::WrongKind {
                expected: WrapperKind::Password,
                found: meta.kind(),
            });
        };
        self.derive(salt, *m_cost, *t_cost, *p_cost)
            .map_err(|e| ProviderError::Failed(e.to_string()))
    }

    async fn enroll(&self) -> Result<(WrapperParams, Kek), ProviderError> {
        self.enroll_sync()
            .map_err(|e| ProviderError::Failed(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn enrolled_params_reproduce_the_same_kek() {
        let provider = PasswordProvider::new("correct horse battery staple");
        let (params, enrolled) = provider.enroll().await.unwrap();
        let meta = WrapperMeta {
            id: "w1".into(),
            params,
        };
        let reproduced = provider.kek_for(&meta).await.unwrap();
        assert_eq!(enrolled.as_bytes(), reproduced.as_bytes());
    }

    #[tokio::test]
    async fn a_different_password_produces_a_different_kek() {
        let (params, enrolled) = PasswordProvider::new("right").enroll().await.unwrap();
        let meta = WrapperMeta {
            id: "w1".into(),
            params,
        };
        let other = PasswordProvider::new("wrong").kek_for(&meta).await.unwrap();
        assert_ne!(enrolled.as_bytes(), other.as_bytes());
    }

    /// Each enrolment draws a fresh salt, so the same password used twice
    /// must not yield the same KEK — otherwise two vaults sharing a password
    /// would share a wrapping key.
    #[tokio::test]
    async fn enrolling_twice_draws_a_fresh_salt() {
        let provider = PasswordProvider::new("same password");
        let (_, first) = provider.enroll().await.unwrap();
        let (_, second) = provider.enroll().await.unwrap();
        assert_ne!(first.as_bytes(), second.as_bytes());
    }

    #[tokio::test]
    async fn rejects_a_wrapper_belonging_to_another_method() {
        let meta = WrapperMeta {
            id: "w1".into(),
            params: WrapperParams::OsKeyring {},
        };
        match PasswordProvider::new("pw").kek_for(&meta).await {
            Err(ProviderError::WrongKind { .. }) => {}
            other => panic!("expected WrongKind, got {other:?}"),
        }
    }
}
