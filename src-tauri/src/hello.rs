//! TPM-backed vault unlock via `Windows.Security.Credentials.KeyCredentialManager`.
//!
//! # Why this exists
//!
//! The OS-keyring unlock method (`OsKeyringProvider` in `vault.rs`) stores a
//! key encryption key in DPAPI-protected Credential Manager. That key is
//! readable by *any* process running as the signed-in user, with a plain
//! `CredRead` and no prompt — the Windows Hello check in front of it is a
//! consent gate on our own code path, which an attacker simply doesn't call.
//! It is also recoverable offline from a stolen disk given the account
//! password, since that's what protects the DPAPI master key.
//!
//! This provider stores **nothing recoverable at rest**. It enrols an
//! asymmetric key credential whose private key lives in the TPM and is gated
//! by the Hello gesture, keeps a random challenge in the clear next to the
//! vault, and derives the KEK by signing that challenge:
//!
//! ```text
//! KEK = HKDF-SHA256(RequestSignAsync(challenge), hkdf_salt, "wrustty vault kek v1")
//! ```
//!
//! Recovering the KEK therefore requires a live gesture from the person at
//! the machine, and the TPM's own anti-hammering bounds guessing. Malware
//! running as the user cannot extract it, and a stolen disk yields nothing.
//!
//! # The assumption this rests on
//!
//! Signature *determinism*: signing the same challenge twice must produce
//! identical bytes. Today it does — the credential is RSA and the signature
//! is PKCS#1 v1.5, which has no random component. **Microsoft has never
//! documented this as a guarantee.** If a future Windows build moves to
//! RSA-PSS (randomized salt) or to ECDSA without RFC 6979, every Hello
//! wrapper stops opening on the same day.
//!
//! That is survivable rather than catastrophic only because the master
//! password wrapper always exists and cannot be removed (see
//! `Vault::remove_unlock_method`). Do not let anyone talk you into making
//! this the sole unlock method for a vault.
//!
//! Detecting a determinism failure matters because the naive handling is a
//! *loop*, not an error: enrolment succeeds (one signature is trivially
//! self-consistent), the next unlock fails, its message sensibly says
//! "re-enrol", and that succeeds and fails again, forever, with nothing
//! naming the cause.
//!
//! The check is deferred to the failure path rather than run at enrolment,
//! because the wrapped key's AEAD tag *already* detects a wrong signature at
//! unlock — a second enrolment signature would only be re-deriving something
//! the tag tells us anyway. What the tag can't say is *why* the KEK was
//! wrong, and the two causes need opposite advice: a rotated credential is
//! fixed by re-enrolling, a non-deterministic signature is made worse by it.
//! So `explain_unlock_failure` does the twice-and-compare, on a path that has
//! already failed, and every user who never hits it pays one prompt fewer.
//!
//! Every signing operation requires a fresh gesture — that's the design of a
//! Hello key credential, not an artefact here. Enrolment therefore costs two
//! prompts (create, then sign) and unlock costs exactly one.

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
/// too, so a vault carried to another machine can say which credential it
/// wants rather than just failing.
const CREDENTIAL_NAME: &str = "wrustty-vault-unlock";

/// HKDF `info` string. Versioned: changing the derivation without changing
/// this would produce a different KEK from the same signature and silently
/// orphan every existing wrapper.
const HKDF_INFO: &[u8] = b"wrustty vault kek v1";

const CHALLENGE_LEN: usize = 32;
const HKDF_SALT_LEN: usize = 16;

/// Maps a `KeyCredentialStatus` onto the taxonomy the UI acts on. `Success`
/// is handled by the caller; everything reaching here is a failure.
fn status_error(status: KeyCredentialStatus) -> ProviderError {
    match status {
        // Both mean the user declined at the prompt. `UserPrefersPassword` is
        // the "use a different sign-in option" escape hatch, which for our
        // purposes is the same answer: they're not doing this right now.
        KeyCredentialStatus::UserCanceled | KeyCredentialStatus::UserPrefersPassword => {
            ProviderError::Cancelled
        }
        // On open: the credential is gone — a reset PIN, a cleared Hello
        // container, a migrated profile. The wrapper is dead and the user
        // must unlock another way and re-enrol.
        KeyCredentialStatus::NotFound => ProviderError::Invalidated(
            "the Windows Hello credential for this vault no longer exists — \
             unlock with your master password and set it up again"
                .to_string(),
        ),
        // Too many failed gestures. Transient: Windows unlocks it again after
        // a successful sign-in, so this is worth retrying later.
        KeyCredentialStatus::SecurityDeviceLocked => ProviderError::Failed(
            "Windows Hello is locked out after too many attempts — sign in to Windows again first"
                .to_string(),
        ),
        other => ProviderError::Failed(format!("Windows Hello returned {other:?}")),
    }
}

/// WinRT activation needs a COM apartment, and every one of these runs on a
/// fresh `spawn_blocking` thread that has none. Safe to call unconditionally:
/// it no-ops (S_FALSE) if something already initialized this thread, and
/// these threads never touch COM again after returning to the pool.
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

/// Whether `KeyCredentialManager` can be used at all on this machine.
///
/// Note carefully what this does *not* tell you: it returns true whenever
/// Hello is enrolled for the user, including on machines with no TPM, where
/// key credentials fall back to a software key store and the whole
/// "nothing recoverable at rest" property is lost. Attestation, checked at
/// enrolment, is what distinguishes the two.
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

/// Whether this machine still holds the vault's key credential.
///
/// Called on every vault-menu open and at startup, so it must not prompt —
/// `OpenAsync` only retrieves a handle, with the gesture deferred to
/// `RequestSignAsync`. `credential_open_does_not_prompt` in the tests below
/// pins that down, because getting it wrong would mean a Hello dialog every
/// time the menu opens.
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

/// Removes the vault's key credential from the Hello container.
///
/// Best-effort and idempotent: a credential that isn't there is the desired
/// end state. Without this, turning the toggle off — or deleting the vault
/// outright — leaves an orphaned TPM credential behind forever, litter that
/// nothing will ever reference again.
pub(crate) async fn forget_credential() {
    let _ = tokio::task::spawn_blocking(|| {
        init_com();
        KeyCredentialManager::DeleteAsync(&HSTRING::from(CREDENTIAL_NAME)).and_then(|op| op.join())
    })
    .await;
}

/// Signs `challenge` with the vault's key credential, prompting for the Hello
/// gesture. Returns the raw signature — the caller derives the KEK from it
/// and is responsible for zeroizing it.
fn sign_challenge_blocking(
    credential_name: &str,
    challenge: &[u8],
) -> Result<Vec<u8>, ProviderError> {
    init_com();

    // Open, never create: `RequestCreateAsync` with `ReplaceExisting` here
    // would destroy the very key we're trying to sign with and hand back a
    // fresh one, whose signature derives a different KEK — turning "the
    // credential rotated" into "the vault silently stopped opening, and the
    // wrapper is now unrecoverable". Enrolment is the only place a credential
    // is created.
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

/// Creates (or replaces) the key credential. Returns whether the TPM
/// successfully attested it.
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

    // `ReplaceExisting` rather than `FailIfExists`: enrolment always mints a
    // fresh challenge and rewraps the DEK anyway, so there is nothing to
    // preserve, and reusing a credential left over from a previous enrolment
    // would mean depending on a key whose provenance we no longer know.
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

    // Best-effort: a machine with no TPM still gets a working (software-
    // backed) credential, and refusing to enrol there would be worse than
    // enrolling and saying so. `TemporarilyUnavailable` is also common on
    // perfectly good hardware — attestation needs a provisioned AIK, which
    // Windows fetches lazily — so a false here means "not proven", not
    // "proven absent".
    let attestation = credential
        .GetAttestationAsync()
        .and_then(|op| op.join())
        .and_then(|result| result.Status());
    // Logged rather than merely reduced to a bool: `TemporarilyUnavailable`
    // (no attestation identity key provisioned yet) and `NotSupported` (no
    // TPM at all) mean very different things, and collapsing them leaves
    // nobody able to tell which happened.
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

    /// Works out *why* an unlock failed, after it already has.
    ///
    /// The AEAD tag on the wrapped key established that the derived KEK was
    /// wrong; it cannot say which of two very different things went wrong,
    /// and the remedies are opposite — re-enrolling fixes a rotated
    /// credential and is futile for a non-deterministic one. Costs up to two
    /// prompts, spent only here, on a path that has already failed.
    pub(crate) async fn explain_unlock_failure(&self, meta: &WrapperMeta) -> String {
        const ROTATED: &str = "the Windows Hello credential for this vault was replaced or \
                               removed — unlock with your master password, then switch \
                               passwordless unlock off and on again to re-enrol it";

        let Ok(stored) = StoredHello::from_meta(meta) else {
            return "this vault's Windows Hello settings are unreadable — \
                    unlock with your master password"
                .to_string();
        };

        // Costs nothing and catches the common case (a reset PIN destroys the
        // credential outright), so try it before spending any gestures.
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
            // Stable, but not the signature this vault was wrapped with: the
            // keypair behind the credential changed.
            (Ok(a), Ok(b)) if a == b => ROTATED.to_string(),
            // The assumption this whole method rests on no longer holds here.
            // Say so plainly, and steer away from the re-enrol loop.
            (Ok(_), Ok(_)) => "Windows Hello on this machine no longer produces a stable \
                               signature, so it can't derive this vault's key. Use your master \
                               password — re-enrolling will not help."
                .to_string(),
            (Err(e), _) | (_, Err(e)) => format!("Windows Hello couldn't be checked: {e}"),
        }
    }

    /// Runs `f` on a blocking thread, then hands keyboard focus back to the
    /// webview — the gesture prompt is broker-hosted and strands focus
    /// whichever way it resolves, so this wraps *every* prompting call rather
    /// than only the successful ones.
    async fn prompting<T, F>(&self, f: F) -> Result<T, ProviderError>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, ProviderError> + Send + 'static,
    {
        let window = self
            .app
            .get_webview_window("main")
            .ok_or_else(|| ProviderError::Failed("no main window".to_string()))?;
        // HWND isn't Send; round-trip through a plain isize rather than
        // moving the value itself across the thread boundary. `WebviewWindow`
        // is Send (it's handles and ids under the hood), so it moves in
        // directly.
        let hwnd_value = window
            .hwnd()
            .map_err(|e| ProviderError::Failed(e.to_string()))?
            .0 as isize;

        tokio::task::spawn_blocking(move || {
            let hwnd = HWND(hwnd_value as _);
            // Must happen before the call, not after: the prompt is modal and
            // blocks this thread until answered, so there is no "after" until
            // the user has already found the invisible dialog.
            crate::win_focus::allow_broker_foreground(hwnd);
            // The prompt's window is unowned and so earns a taskbar button of
            // its own, wearing a generic icon and grouped under the broker
            // rather than under us. Dropped once `f` returns, which is also
            // when the prompt has closed.
            let button = crate::win_focus::hide_broker_taskbar_button();
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

        // Neither of these is secret: the challenge is stored in the clear
        // beside the vault, and the scheme never relies on its secrecy — only
        // on the TPM's refusal to sign it without a gesture.
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

    /// Exercises the WinRT activation path for real, without prompting.
    ///
    /// Worth its own test because this is precisely the failure mode that
    /// bit the `UserConsentVerifier` work (see the note in `vault.rs`): a
    /// wrong activation route compiles perfectly and then fails at *runtime*
    /// with "Class not registered". Asserts only that activation succeeded —
    /// whether Hello is actually enrolled is a property of the machine, not
    /// of this code.
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

    /// Runs `f` on the blocking pool but gives up after `secs`, so a WinRT
    /// call that never returns is reported as such instead of hanging the
    /// test run. The blocking thread is abandoned rather than cancelled —
    /// there is no way to interrupt a stuck WinRT call, which is precisely
    /// the property being investigated.
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

    /// `credential_exists` runs on every vault-menu open, so a prompt hiding
    /// inside `OpenAsync` would mean a Hello dialog every time — and, as this
    /// project learned the hard way, an *invisible* one when the process
    /// isn't foreground. Headless here, so a prompt would manifest as a call
    /// that never returns: finishing at all is the assertion.
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

    /// Drives the real enrolment sequence step by step, with a timeout on
    /// each, and reports whether the two signatures actually match on this
    /// hardware. Uses its own credential name so it can't disturb a real
    /// vault, and deletes it afterwards.
    ///
    /// **A timeout here does not mean the call hung.** `cargo test` has no
    /// window and is not the foreground process, so the Hello prompt opens
    /// invisibly behind everything and waits forever for an answer nobody
    /// can see — and `allow_broker_foreground` can't help, since the grant
    /// requires the granting process to hold foreground. Read a timeout as
    /// "nobody answered the prompt", and check the taskbar before concluding
    /// anything about the code. Only the running app exercises this path
    /// realistically.
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
