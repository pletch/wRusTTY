//! TPM-backed vault unlock via `Windows.Security.Credentials.KeyCredentialManager`.
//!
//! The OS-keyring method (`OsKeyringProvider` in `vault.rs`) keeps a KEK in
//! DPAPI-protected Credential Manager, readable by any process running as the
//! user and recoverable offline with the account password. This provider
//! stores nothing recoverable at rest: it enrolls a key credential whose
//! private key lives in the TPM behind the Hello gesture, keeps a random
//! challenge beside the vault, and derives the KEK by signing it:
//!
//! ```text
//! KEK = HKDF-SHA256(RequestSignAsync(challenge), hkdf_salt, "wrustty vault kek v1")
//! ```
//!
//! # The assumption this rests on
//!
//! Signing the same challenge twice must produce identical bytes. It does
//! today (RSA, PKCS#1 v1.5), but Microsoft has never documented it. A move to
//! RSA-PSS or randomized ECDSA would break every Hello wrapper at once, which
//! is survivable only because the master password wrapper can't be removed
//! (`Vault::remove_unlock_method`). Never make this the sole unlock method.
//!
//! The AEAD tag already detects a wrong KEK at unlock, so determinism is only
//! checked on the failure path (`explain_unlock_failure`), where it tells a
//! rotated credential (re-enroll) from a non-deterministic one (re-enrolling
//! would loop forever).
//!
//! Each signing needs a fresh gesture: enrollment costs two prompts (create,
//! sign) and unlock one.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use tauri::{AppHandle, Manager};
use windows::core::HSTRING;
use windows::Security::Credentials::{
    KeyCredential, KeyCredentialAttestationStatus, KeyCredentialCreationOption,
    KeyCredentialManager, KeyCredentialStatus,
};
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Storage::Streams::{DataReader, IBuffer};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use wr_vault::{Kek, KeyProvider, ProviderError, WrapperKind, WrapperMeta, WrapperParams};
use zeroize::Zeroize;

/// Name of the key credential in the Hello container. Stored in each wrapper
/// so a vault on another machine can say which credential it wants.
const CREDENTIAL_NAME: &str = "wrustty-vault-unlock";

/// HKDF `info` string. Versioned: changing the derivation without changing
/// this would silently orphan every existing wrapper.
const HKDF_INFO: &[u8] = b"wrustty vault kek v1";

const CHALLENGE_LEN: usize = 32;
const HKDF_SALT_LEN: usize = 16;

/// Maps a `KeyCredentialStatus` onto the UI's taxonomy. `Success` is handled
/// by the caller.
fn status_error(status: KeyCredentialStatus) -> ProviderError {
    match status {
        // Both mean the user declined; `UserPrefersPassword` is "use a different
        // sign-in option".
        KeyCredentialStatus::UserCanceled | KeyCredentialStatus::UserPrefersPassword => {
            ProviderError::Cancelled
        }
        // The credential is gone (reset PIN, cleared container, migrated profile):
        // unlock another way and re-enroll.
        KeyCredentialStatus::NotFound => ProviderError::Invalidated(
            "the Windows Hello credential for this vault no longer exists — \
             unlock with your master password and set it up again"
                .to_string(),
        ),
        // Too many failed gestures. Transient: cleared by a successful sign-in.
        KeyCredentialStatus::SecurityDeviceLocked => ProviderError::Failed(
            "Windows Hello is locked out after too many attempts — sign in to Windows again first"
                .to_string(),
        ),
        other => ProviderError::Failed(format!("Windows Hello returned {other:?}")),
    }
}

/// WinRT activation needs a COM apartment, which a fresh `spawn_blocking`
/// thread lacks. A no-op (S_FALSE) if already initialized.
fn init_com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn to_ibuffer(bytes: &[u8]) -> Result<IBuffer, ProviderError> {
    CryptographicBuffer::CreateFromByteArray(bytes)
        .map_err(|e| ProviderError::Failed(e.to_string()))
}

fn from_ibuffer(buffer: &IBuffer) -> Result<Vec<u8>, ProviderError> {
    let len = buffer
        .Length()
        .map_err(|e| ProviderError::Failed(e.to_string()))? as usize;
    let mut bytes = vec![0u8; len];
    let reader =
        DataReader::FromBuffer(buffer).map_err(|e| ProviderError::Failed(e.to_string()))?;
    reader
        .ReadBytes(&mut bytes)
        .map_err(|e| ProviderError::Failed(e.to_string()))?;
    Ok(bytes)
}

/// Whether `KeyCredentialManager` can be used at all. True whenever Hello is
/// enrolled, including without a TPM (a software key store, which loses the
/// "nothing at rest" property); attestation at enrollment tells them apart.
pub(crate) async fn is_supported() -> bool {
    tokio::task::spawn_blocking(|| {
        init_com();
        KeyCredentialManager::IsSupportedAsync()
            .and_then(|op| op.join())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// Whether this machine still holds the vault's key credential. Called on
/// every vault-menu open, so it must not prompt: `OpenAsync` only retrieves a
/// handle (pinned by `credential_open_does_not_prompt`).
pub(crate) async fn credential_exists() -> bool {
    tokio::task::spawn_blocking(|| {
        init_com();
        KeyCredentialManager::OpenAsync(&HSTRING::from(CREDENTIAL_NAME))
            .and_then(|op| op.join())
            .and_then(|opened| opened.Status())
            .map(|status| status == KeyCredentialStatus::Success)
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// Removes the vault's key credential from the Hello container, so turning
/// the method off or deleting the vault leaves no orphan. Best-effort and
/// idempotent.
pub(crate) async fn forget_credential() {
    let _ = tokio::task::spawn_blocking(|| {
        init_com();
        KeyCredentialManager::DeleteAsync(&HSTRING::from(CREDENTIAL_NAME)).and_then(|op| op.join())
    })
    .await;
}

/// Signs `challenge` with the vault's key credential, prompting for the
/// gesture. The caller derives the KEK and zeroizes the signature.
fn sign_challenge_blocking(
    credential_name: &str,
    challenge: &[u8],
) -> Result<Vec<u8>, ProviderError> {
    init_com();

    // Open, never create: `ReplaceExisting` here would destroy the key and make
    // the wrapper unrecoverable. Only enrollment creates a credential.
    let opened = KeyCredentialManager::OpenAsync(&HSTRING::from(credential_name))
        .and_then(|op| op.join())
        .map_err(|e| ProviderError::Failed(e.to_string()))?;
    let status = opened
        .Status()
        .map_err(|e| ProviderError::Failed(e.to_string()))?;
    if status != KeyCredentialStatus::Success {
        return Err(status_error(status));
    }
    let credential: KeyCredential = opened
        .Credential()
        .map_err(|e| ProviderError::Failed(e.to_string()))?;

    let buffer = to_ibuffer(challenge)?;
    let signed = credential
        .RequestSignAsync(&buffer)
        .and_then(|op| op.join())
        .map_err(|e| ProviderError::Failed(e.to_string()))?;
    let status = signed
        .Status()
        .map_err(|e| ProviderError::Failed(e.to_string()))?;
    if status != KeyCredentialStatus::Success {
        return Err(status_error(status));
    }

    let signature = signed
        .Result()
        .map_err(|e| ProviderError::Failed(e.to_string()))?;
    from_ibuffer(&signature)
}

/// Creates (or replaces) the key credential. Returns whether the TPM attested
/// it.
fn create_credential_blocking(credential_name: &str) -> Result<bool, ProviderError> {
    init_com();

    let supported = KeyCredentialManager::IsSupportedAsync()
        .and_then(|op| op.join())
        .map_err(|e| ProviderError::Failed(e.to_string()))?;
    if !supported {
        return Err(ProviderError::Unavailable(
            "Windows Hello isn't set up on this machine".to_string(),
        ));
    }

    // `ReplaceExisting`: enrollment mints a fresh challenge and rewraps anyway,
    // and a leftover credential's provenance is unknown.
    let created = KeyCredentialManager::RequestCreateAsync(
        &HSTRING::from(credential_name),
        KeyCredentialCreationOption::ReplaceExisting,
    )
    .and_then(|op| op.join())
    .map_err(|e| ProviderError::Failed(e.to_string()))?;
    let status = created
        .Status()
        .map_err(|e| ProviderError::Failed(e.to_string()))?;
    if status != KeyCredentialStatus::Success {
        return Err(status_error(status));
    }
    let credential: KeyCredential = created
        .Credential()
        .map_err(|e| ProviderError::Failed(e.to_string()))?;

    // Best-effort: a software-backed credential still works and refusing would be
    // worse. `TemporarilyUnavailable` is common on good hardware (the AIK is
    // provisioned lazily), so false means "not proven", not "absent".
    let attestation = credential
        .GetAttestationAsync()
        .and_then(|op| op.join())
        .and_then(|result| result.Status());
    // Logged: `TemporarilyUnavailable` (no AIK yet) and `NotSupported` (no TPM)
    // mean very different things.
    match &attestation {
        Ok(status) => log::info!("Windows Hello key credential attestation: {status:?}"),
        Err(e) => log::info!("Windows Hello key credential attestation failed: {e}"),
    }

    Ok(matches!(attestation, Ok(s) if s == KeyCredentialAttestationStatus::Success))
}

/// A `WrapperParams::Hello` decoded into usable form.
struct StoredHello {
    challenge: Vec<u8>,
    hkdf_salt: Vec<u8>,
    credential_name: String,
}

impl StoredHello {
    fn from_meta(meta: &WrapperMeta) -> Result<Self, ProviderError> {
        let WrapperParams::Hello {
            challenge,
            hkdf_salt,
            credential_name,
            ..
        } = &meta.params
        else {
            return Err(ProviderError::WrongKind {
                expected: WrapperKind::Hello,
                found: meta.kind(),
            });
        };
        Ok(Self {
            challenge: BASE64.decode(challenge).map_err(|e| {
                ProviderError::Failed(format!("stored challenge is unreadable: {e}"))
            })?,
            hkdf_salt: BASE64
                .decode(hkdf_salt)
                .map_err(|e| ProviderError::Failed(format!("stored salt is unreadable: {e}")))?,
            credential_name: credential_name.clone(),
        })
    }
}

/// Unlock backed by a TPM-resident key credential gated on a Hello gesture.
pub struct HelloProvider {
    app: AppHandle,
}

impl HelloProvider {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    /// Works out why an unlock failed. The AEAD tag says the KEK was wrong but
    /// not why, and the remedies are opposite: re-enrolling fixes a rotated
    /// credential and loops for a non-deterministic one. Costs up to two prompts.
    pub(crate) async fn explain_unlock_failure(&self, meta: &WrapperMeta) -> String {
        const ROTATED: &str = "the Windows Hello credential for this vault was replaced or \
                               removed — unlock with your master password, then switch \
                               passwordless unlock off and on again to re-enroll it";

        let Ok(stored) = StoredHello::from_meta(meta) else {
            return "this vault's Windows Hello settings are unreadable — \
                    unlock with your master password"
                .to_string();
        };

        // Free, and catches the common case (a reset PIN), so try it first.
        if !credential_exists().await {
            return ROTATED.to_string();
        }

        let name = stored.credential_name.clone();
        let challenge = stored.challenge.clone();
        let first = self
            .prompting(move || sign_challenge_blocking(&name, &challenge))
            .await;
        let name = stored.credential_name.clone();
        let challenge = stored.challenge.clone();
        let second = self
            .prompting(move || sign_challenge_blocking(&name, &challenge))
            .await;

        match (first, second) {
            // Stable, but not the signature the vault was wrapped with: the keypair
            // changed.
            (Ok(a), Ok(b)) if a == b => ROTATED.to_string(),
            // Determinism no longer holds. Say so, and steer away from re-enrolling.
            (Ok(_), Ok(_)) => "Windows Hello on this machine no longer produces a stable \
                               signature, so it can't derive this vault's key. Use your master \
                               password — re-enrolling will not help."
                .to_string(),
            (Err(e), _) | (_, Err(e)) => format!("Windows Hello couldn't be checked: {e}"),
        }
    }

    /// Runs `f` on a blocking thread, then hands focus back to the webview. The
    /// broker-hosted prompt strands focus however it resolves.
    async fn prompting<T, F>(&self, f: F) -> Result<T, ProviderError>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, ProviderError> + Send + 'static,
    {
        let window = self
            .app
            .get_webview_window("main")
            .ok_or_else(|| ProviderError::Failed("no main window".to_string()))?;
        // HWND isn't Send, so pass it as an isize. `WebviewWindow` is Send.
        let hwnd_value = window
            .hwnd()
            .map_err(|e| ProviderError::Failed(e.to_string()))?
            .0 as isize;

        tokio::task::spawn_blocking(move || {
            let hwnd = HWND(hwnd_value as _);
            // Before the call: the prompt is modal and blocks this thread.
            let foreground = crate::win_focus::allow_broker_foreground(hwnd);
            // The prompt's unowned window gets its own generic taskbar button; hide it
            // until `f` returns. Only when foreground was granted: otherwise that button
            // is how the user finds a prompt that opened behind something.
            let button = foreground.then(crate::win_focus::hide_broker_taskbar_button);
            let result = f();
            drop(button);
            crate::win_focus::restore_after_broker_prompt(&window, hwnd);
            result
        })
        .await
        .map_err(|e| ProviderError::Failed(e.to_string()))?
    }
}

#[wr_vault::async_trait]
impl KeyProvider for HelloProvider {
    fn kind(&self) -> WrapperKind {
        WrapperKind::Hello
    }

    async fn kek_for(&self, meta: &WrapperMeta) -> Result<Kek, ProviderError> {
        let StoredHello {
            challenge,
            hkdf_salt,
            credential_name,
        } = StoredHello::from_meta(meta)?;

        let mut signature = self
            .prompting(move || sign_challenge_blocking(&credential_name, &challenge))
            .await?;
        let kek = wr_vault::derive_kek_from_ikm(&signature, &hkdf_salt, HKDF_INFO);
        signature.zeroize();
        Ok(kek)
    }

    async fn enroll(&self) -> Result<(WrapperParams, Kek), ProviderError> {
        let attested = self
            .prompting(|| create_credential_blocking(CREDENTIAL_NAME))
            .await?;

        // Not secret: the scheme relies on the TPM refusing to sign without a
        // gesture, not on the challenge.
        let challenge: [u8; CHALLENGE_LEN] = wr_vault::random_bytes();
        let hkdf_salt: [u8; HKDF_SALT_LEN] = wr_vault::random_bytes();

        let challenge_for_signing = challenge.to_vec();
        let mut signature = self
            .prompting(move || sign_challenge_blocking(CREDENTIAL_NAME, &challenge_for_signing))
            .await?;
        let kek = wr_vault::derive_kek_from_ikm(&signature, &hkdf_salt, HKDF_INFO);
        signature.zeroize();

        Ok((
            WrapperParams::Hello {
                challenge: BASE64.encode(challenge),
                hkdf_salt: BASE64.encode(hkdf_salt),
                credential_name: CREDENTIAL_NAME.to_string(),
                attested,
            },
            kek,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercises WinRT activation for real, without prompting. A wrong activation
    /// route compiles and then fails at runtime with "Class not registered".
    /// Asserts only activation; whether Hello is enrolled depends on the machine.
    #[tokio::test]
    async fn key_credential_manager_activates() {
        let result = tokio::task::spawn_blocking(|| {
            init_com();
            KeyCredentialManager::IsSupportedAsync().and_then(|op| op.join())
        })
        .await
        .expect("blocking task panicked");

        assert!(
            result.is_ok(),
            "KeyCredentialManager failed to activate: {result:?}"
        );
        eprintln!("Windows Hello key credentials supported here: {result:?}");
    }

    /// Runs `f` on the blocking pool with a timeout, so a WinRT call that never
    /// returns is reported rather than hanging the run. The thread is abandoned,
    /// since a stuck WinRT call can't be interrupted.
    async fn with_timeout<T: Send + 'static>(
        label: &str,
        secs: u64,
        f: impl FnOnce() -> Result<T, ProviderError> + Send + 'static,
    ) -> Option<Result<T, ProviderError>> {
        let task = tokio::task::spawn_blocking(f);
        match tokio::time::timeout(std::time::Duration::from_secs(secs), task).await {
            Ok(joined) => Some(joined.expect("blocking task panicked")),
            Err(_) => {
                eprintln!("  {label}: NO RESPONSE after {secs}s — the call never returned");
                None
            }
        }
    }

    /// A prompt inside `OpenAsync` would mean a Hello dialog on every vault-menu
    /// open. Headless, a prompt shows as a call that never returns, so finishing
    /// is the assertion.
    #[tokio::test(flavor = "multi_thread")]
    async fn credential_open_does_not_prompt() {
        let opened = with_timeout("OpenAsync", 15, || {
            init_com();
            KeyCredentialManager::OpenAsync(&HSTRING::from(CREDENTIAL_NAME))
                .and_then(|op| op.join())
                .and_then(|opened| opened.Status())
                .map_err(|e| ProviderError::Failed(format!("{e:?}")))
        })
        .await;

        assert!(
            opened.is_some(),
            "OpenAsync did not return — it is prompting, and must not be called from a hot path"
        );
        eprintln!("OpenAsync status: {opened:?}");
    }

    /// Drives the real enrollment sequence step by step with timeouts, and
    /// reports whether the two signatures match on this hardware. Uses its own
    /// credential name and deletes it afterward.
    ///
    /// A timeout doesn't mean a hang: `cargo test` isn't foreground, so the Hello
    /// prompt opens invisibly and waits. Check the taskbar before concluding
    /// anything; only the running app exercises this path realistically.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "prompts for a Windows Hello gesture; run with --ignored --nocapture"]
    async fn enrolment_diagnostic() {
        const NAME: &str = "wrustty-vault-diagnostic";
        let challenge = [7u8; CHALLENGE_LEN];

        eprintln!("\n[1/3] RequestCreateAsync — expect a Hello prompt now");
        let created = with_timeout("RequestCreateAsync", 30, || {
            create_credential_blocking(NAME)
        })
        .await;
        eprintln!("  -> {created:?}");
        if !matches!(created, Some(Ok(_))) {
            eprintln!("\nStopped: the credential was never created.");
            return;
        }

        eprintln!("\n[2/3] RequestSignAsync, first call");
        let first = with_timeout("sign #1", 30, move || {
            sign_challenge_blocking(NAME, &challenge)
        })
        .await;
        eprintln!(
            "  -> {:?}",
            first.as_ref().map(|r| r.as_ref().map(Vec::len))
        );

        eprintln!("\n[3/3] RequestSignAsync, second call (determinism check)");
        let second = with_timeout("sign #2", 30, move || {
            sign_challenge_blocking(NAME, &challenge)
        })
        .await;
        eprintln!(
            "  -> {:?}",
            second.as_ref().map(|r| r.as_ref().map(Vec::len))
        );

        if let (Some(Ok(a)), Some(Ok(b))) = (first, second) {
            eprintln!(
                "\nSignatures identical: {} — {}",
                a == b,
                if a == b {
                    "determinism holds, this scheme works on this hardware"
                } else {
                    "DETERMINISM BROKEN, Hello cannot derive a stable key here"
                }
            );
        }

        let _ = tokio::task::spawn_blocking(|| {
            init_com();
            KeyCredentialManager::DeleteAsync(&HSTRING::from(NAME)).and_then(|op| op.join())
        })
        .await;
    }
}
