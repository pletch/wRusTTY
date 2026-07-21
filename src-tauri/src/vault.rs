//! Tauri command layer for the credential vault. The decrypted `Vault`
//! (and every secret inside it) lives only in this process's memory for as
//! long as it's unlocked — locking drops it, triggering `wr_vault`'s
//! zeroize-on-drop. Credentials themselves never round-trip back into the
//! webview after being saved; `ssh_connect_profile` (in `ssh.rs`) resolves
//! them entirely on the Rust side.

use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex as TokioMutex;
use wr_vault::{
    Kek, KeyProvider, ProviderError, Vault, VaultError, VaultSecret, WrapperKind, WrapperMeta,
    WrapperParams,
};
use zeroize::Zeroize;

// A single fixed entry, not one per vault file — this app only ever manages
// one vault at a time (at `vault_path`), so there's nothing to key it by.
const KEYRING_SERVICE: &str = "sh.wrustty.app";
const KEYRING_USER: &str = "vault-key";
// Previous bundle identifier's keyring service name, from before the
// wRusTTY rebrand — see `migrate_os_unlock_key`.
const PREVIOUS_KEYRING_SERVICE: &str = "sh.wrshell.app";

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

/// Drops the OS-keyring KEK. Idempotent — a missing entry is the desired
/// end state, not an error.
fn forget_os_unlock_kek() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// One-time migration for the `sh.wrshell.app` → `sh.wrustty.app` rebrand:
/// an OS-unlock key stored under the old service name is invisible to
/// `keyring_entry()` now that it looks under the new one — without this,
/// "Unlock with Windows sign-in" would silently stop working for anyone who
/// already had it enabled. Safe to call on every launch: a no-op once the
/// old entry is gone (or was never set).
///
/// Moves the bytes without caring what they mean — for a vault that hasn't
/// been through the v2 upgrade yet they're still the old data key, and
/// `vault_unlock` disposes of them once that upgrade happens.
pub(crate) fn migrate_os_unlock_key() {
    let Ok(old_entry) = keyring::Entry::new(PREVIOUS_KEYRING_SERVICE, KEYRING_USER) else {
        return;
    };
    let Ok(password) = old_entry.get_password() else {
        return;
    };
    let Ok(new_entry) = keyring_entry() else {
        return;
    };
    if new_entry.get_password().is_ok() {
        return;
    }
    if new_entry.set_password(&password).is_ok() {
        let _ = old_entry.delete_credential();
    }
}

/// Why a consent check failed, kept apart from a plain string because the
/// caller reacts differently to each: a dismissed prompt is not worth
/// surfacing at all, whereas "no Hello configured on this machine" means the
/// unlock method should be hidden rather than retried.
#[derive(Debug)]
enum ConsentError {
    Cancelled,
    Unavailable(String),
    Failed(String),
}

impl From<ConsentError> for ProviderError {
    fn from(e: ConsentError) -> Self {
        match e {
            ConsentError::Cancelled => ProviderError::Cancelled,
            ConsentError::Unavailable(m) => ProviderError::Unavailable(m),
            ConsentError::Failed(m) => ProviderError::Failed(m),
        }
    }
}

/// Gates OS-unlock on a fresh, per-use Windows Hello (or PIN/password,
/// whatever's configured) challenge — without this, DPAPI alone would
/// silently hand back the stored key to *any* process running under the
/// same already-authenticated Windows session, with no fresh check at all.
///
/// Uses `IUserConsentVerifierInterop::RequestVerificationForWindowAsync`
/// (via `RoGetActivationFactory`, the WinRT activation path — not
/// `CoCreateInstance`, which is classic-COM activation and doesn't apply
/// to a WinRT interop factory; that mismatch is exactly what produced a
/// "Class not registered" error in another non-UWP app's attempt at this)
/// so the prompt is parented to our window and opens in the foreground,
/// rather than the window-less `RequestVerificationAsync`, whose prompt
/// can open behind the app with no indication it's even there.
#[cfg(target_os = "windows")]
fn verify_windows_hello_blocking(
    window: &tauri::WebviewWindow,
    hwnd: windows::Win32::Foundation::HWND,
    message: String,
) -> Result<(), ConsentError> {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::System::WinRT::{IUserConsentVerifierInterop, RoGetActivationFactory};
    use windows_future::IAsyncOperation;

    // This runs on a fresh tokio blocking-pool thread with no COM apartment
    // of its own — WinRT activation needs one. Safe to call unconditionally:
    // it no-ops (S_FALSE) if something already initialized this thread, and
    // this thread never touches COM again after returning it to the pool.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let availability = UserConsentVerifier::CheckAvailabilityAsync()
        .and_then(|op| op.join())
        .map_err(|e| ConsentError::Failed(e.to_string()))?;
    if availability != UserConsentVerifierAvailability::Available {
        return Err(ConsentError::Unavailable(format!(
            "Windows Hello isn't available ({availability:?})"
        )));
    }

    let class_id = HSTRING::from("Windows.Security.Credentials.UI.UserConsentVerifier");
    let interop: IUserConsentVerifierInterop = unsafe { RoGetActivationFactory(&class_id) }
        .map_err(|e| ConsentError::Failed(e.to_string()))?;
    // RequestVerificationForWindowAsync is generic over its *return*
    // interface type (bounded by `windows_core::Interface`), not over the
    // result value — so the turbofish target is
    // IAsyncOperation<UserConsentVerificationResult>, not
    // UserConsentVerificationResult itself. Confirmed directly from the
    // windows-rs source (generated fn signature in
    // Win32/System/WinRT/mod.rs): `fn RequestVerificationForWindowAsync<T:
    // Interface>(...) -> Result<T>`.
    let result = unsafe {
        interop.RequestVerificationForWindowAsync::<IAsyncOperation<UserConsentVerificationResult>>(
            hwnd,
            &HSTRING::from(message),
        )
    }
    .and_then(|op| op.join())
    .map_err(|e| ConsentError::Failed(e.to_string()))?;
    crate::win_focus::restore_after_broker_prompt(window, hwnd);
    match result {
        UserConsentVerificationResult::Verified => Ok(()),
        // The user dismissed the prompt. Not a failure worth reporting — the
        // caller turns this into a silent no-op rather than an error toast.
        UserConsentVerificationResult::Canceled => Err(ConsentError::Cancelled),
        // Structural: nothing about retrying will help until the machine's
        // Hello configuration changes.
        r @ (UserConsentVerificationResult::DeviceNotPresent
        | UserConsentVerificationResult::NotConfiguredForUser
        | UserConsentVerificationResult::DisabledByPolicy) => Err(ConsentError::Unavailable(
            format!("Windows Hello isn't usable on this machine ({r:?})"),
        )),
        // Transient: a busy sensor or too many bad attempts. Worth retrying.
        other => Err(ConsentError::Failed(format!(
            "Windows Hello verification didn't succeed ({other:?})"
        ))),
    }
}

#[cfg(target_os = "windows")]
async fn verify_windows_hello(app: &AppHandle, message: &str) -> Result<(), ConsentError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| ConsentError::Failed("no main window".to_string()))?;
    let hwnd = window
        .hwnd()
        .map_err(|e| ConsentError::Failed(e.to_string()))?;
    // HWND isn't necessarily Send, and this needs to run on a different
    // thread (spawn_blocking, below) — round-trip through a plain isize
    // instead of moving the HWND value itself across that boundary.
    // `WebviewWindow` itself is Send (it's just handles/ids under the
    // hood), so it moves into the closure directly.
    let hwnd_value = hwnd.0 as isize;
    let message = message.to_string();
    // RequestVerificationForWindowAsync's `.join()` blocks the calling
    // thread until the prompt is answered — spawn_blocking keeps that off
    // the async runtime's worker threads instead of stalling them for
    // however long the user takes to respond.
    tokio::task::spawn_blocking(move || {
        let hwnd = windows::Win32::Foundation::HWND(hwnd_value as _);
        verify_windows_hello_blocking(&window, hwnd, message)
    })
    .await
    .map_err(|e| ConsentError::Failed(e.to_string()))?
}

#[cfg(not(target_os = "windows"))]
async fn verify_windows_hello(_app: &AppHandle, _message: &str) -> Result<(), ConsentError> {
    // No equivalent local challenge exists on other platforms — the
    // OS-unlock feature this gates is Windows-only to begin with (see
    // vault_enable_os_unlock).
    Ok(())
}

/// Unlock method backed by the OS credential store, with a Windows Hello
/// consent prompt in front of it.
///
/// **This is the weak one, and it is deliberately structured so it can be
/// replaced without touching anything else.** What it stores is a random KEK,
/// not the vault's data key — but that KEK still sits in DPAPI-protected
/// Credential Manager, which means any process running as this user can read
/// it back with a plain `CredRead` and no prompt whatsoever. The Hello check
/// below is a *consent* gate on this application's own code path; an attacker
/// simply doesn't call it. It is exactly as strong as the arrangement it
/// replaces, and no stronger.
///
/// The point of routing it through `KeyProvider` is that closing that gap is
/// now a matter of writing a sibling provider — one that derives its KEK from
/// `KeyCredential::RequestSignAsync` over the challenge in
/// `WrapperParams::Hello`, so that nothing recoverable at rest exists at all —
/// and enrolling it as `WrapperKind::Hello`. The vault, the file format, and
/// the UI all already accommodate that; only this struct is missing.
struct OsKeyringProvider {
    app: AppHandle,
}

/// Reads the stored KEK, zeroizing both the base64 text and the decoded
/// bytes on the way out — `Kek` owns the only copy that survives this call.
fn read_os_unlock_kek() -> Result<Kek, ProviderError> {
    let entry = keyring_entry().map_err(ProviderError::Failed)?;
    let mut encoded = match entry.get_password() {
        Ok(v) => v,
        Err(keyring::Error::NoEntry) => {
            return Err(ProviderError::Invalidated(
                "the Windows sign-in key for this vault is gone from the credential store"
                    .to_string(),
            ))
        }
        Err(e) => return Err(ProviderError::Failed(e.to_string())),
    };
    let decoded = BASE64.decode(&encoded);
    encoded.zeroize();

    let mut bytes = decoded.map_err(|e| ProviderError::Failed(e.to_string()))?;
    let key: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
        ProviderError::Invalidated("the stored key has an unexpected length".to_string())
    })?;
    bytes.zeroize();
    Ok(Kek::from_bytes(key))
}

#[wr_vault::async_trait]
impl KeyProvider for OsKeyringProvider {
    fn kind(&self) -> WrapperKind {
        WrapperKind::OsKeyring
    }

    async fn kek_for(&self, meta: &WrapperMeta) -> Result<Kek, ProviderError> {
        if meta.kind() != WrapperKind::OsKeyring {
            return Err(ProviderError::WrongKind {
                expected: WrapperKind::OsKeyring,
                found: meta.kind(),
            });
        }
        verify_windows_hello(&self.app, "Unlock wRusTTY's credential vault").await?;
        read_os_unlock_kek()
    }

    async fn enroll(&self) -> Result<(WrapperParams, Kek), ProviderError> {
        // A fresh random KEK, not the vault's data key: enabling and later
        // disabling this method leaves nothing behind that could open the
        // vault, and the DEK never enters the credential store at all.
        let bytes: [u8; 32] = wr_vault::random_bytes();
        let mut encoded = BASE64.encode(bytes);
        let stored = keyring_entry()
            .map_err(ProviderError::Failed)?
            .set_password(&encoded);
        encoded.zeroize();
        stored.map_err(|e| ProviderError::Failed(e.to_string()))?;
        Ok((WrapperParams::OsKeyring {}, Kek::from_bytes(bytes)))
    }
}

#[derive(Default)]
pub struct VaultState {
    pub(crate) vault: TokioMutex<Option<Vault>>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultStatus {
    Uninitialized,
    Locked,
    Unlocked,
}

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("vault.wrv"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vault_status(
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<VaultStatus, String> {
    if state.vault.lock().await.is_some() {
        return Ok(VaultStatus::Unlocked);
    }
    Ok(if wr_vault::exists(&vault_path(&app)?) {
        VaultStatus::Locked
    } else {
        VaultStatus::Uninitialized
    })
}

#[tauri::command]
pub async fn vault_create(
    app: AppHandle,
    master_password: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let vault = Vault::create(vault_path(&app)?, &master_password).map_err(|e| e.to_string())?;
    *state.vault.lock().await = Some(vault);
    Ok(())
}

/// Also the upgrade path: unlocking a pre-v2 file here migrates it in place
/// and re-keys the credentials onto a fresh data key.
///
/// That last part is why the cleanup below matters. A pre-v2 vault with
/// "unlock with Windows sign-in" enabled had a plaintext copy of its *data
/// key* sitting in Credential Manager — the weakness this format change
/// exists to close. After migration that copy opens nothing, but it is still
/// key material on disk with no owner, so it goes. The user re-enables the
/// setting once, and gets a wrapper holding a random KEK instead.
#[tauri::command]
pub async fn vault_unlock(
    app: AppHandle,
    master_password: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let vault = Vault::unlock(vault_path(&app)?, &master_password).map_err(|e| e.to_string())?;
    if !vault.has_unlock_method(WrapperKind::OsKeyring) {
        let _ = forget_os_unlock_kek();
    }
    *state.vault.lock().await = Some(vault);
    Ok(())
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, VaultState>) -> Result<(), String> {
    *state.vault.lock().await = None;
    Ok(())
}

/// Permanently deletes the vault file — every stored credential goes with
/// it. Also clears the OS-unlock keyring entry (it wrapped this vault's
/// key specifically) and every session profile's `hasCredential` flag,
/// since none of them point at anything real anymore once the file is
/// gone — left set, the sidebar would keep offering to "unlock the vault"
/// for credentials that no longer exist.
#[tauri::command]
pub async fn vault_delete(app: AppHandle, state: State<'_, VaultState>) -> Result<(), String> {
    *state.vault.lock().await = None;
    // The vault these protected is about to cease to exist, so both become
    // orphans — the TPM credential especially, which nothing else would ever
    // clean up.
    #[cfg(target_os = "windows")]
    crate::hello::forget_credential().await;
    forget_os_unlock_kek()?;
    match std::fs::remove_file(vault_path(&app)?) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }

    let profiles_path = crate::profiles::profiles_path(&app)?;
    let mut profiles = crate::profiles::read_profiles(&profiles_path)?;
    for profile in &mut profiles {
        profile.has_credential = false;
    }
    crate::profiles::write_profiles(&profiles_path, &profiles)?;

    Ok(())
}

/// The passwordless unlock methods, strongest first. A vault can only ever
/// have one of them enrolled at a time (see `vault_enable_os_unlock`), but
/// the order matters when deciding which to *use*: a vault carried from a
/// machine where only the keyring method was available should still open
/// here, and a vault upgraded to Hello should never fall back.
const PASSWORDLESS_METHODS: [WrapperKind; 2] = [WrapperKind::Hello, WrapperKind::OsKeyring];

/// Whether *this build* can drive a method, as distinct from whether the
/// vault has it enrolled. A vault created on Windows and then opened on a
/// Linux build carries a Hello wrapper that nothing here can open; treating
/// it as available would put a button on screen that always fails, when the
/// honest answer is to fall back to the master password.
fn usable_on_this_platform(kind: WrapperKind) -> bool {
    match kind {
        WrapperKind::Hello => cfg!(target_os = "windows"),
        _ => true,
    }
}

fn enrolled_passwordless_method(app: &AppHandle) -> Result<Option<WrapperKind>, String> {
    let path = vault_path(app)?;
    if !wr_vault::exists(&path) {
        return Ok(None);
    }
    let enrolled = wr_vault::unlock_methods_at(&path).map_err(|e| e.to_string())?;
    Ok(PASSWORDLESS_METHODS
        .into_iter()
        .find(|kind| enrolled.contains(kind) && usable_on_this_platform(*kind)))
}

/// Whether this vault has a passwordless unlock method enrolled — lets the
/// UI offer it instead of the master password, and shows the current on/off
/// state of the setting once unlocked.
///
/// Answers from the vault file rather than from the credential store, which
/// matters for a vault that hasn't been migrated yet: a pre-v2 file has no
/// unlock methods besides the master password, however many stale keys are
/// left lying around under our service name.
#[tauri::command]
pub async fn vault_os_unlock_available(app: AppHandle) -> Result<bool, String> {
    let Some(kind) = enrolled_passwordless_method(&app)? else {
        return Ok(false);
    };
    // A Hello wrapper travels with the vault file but its key credential does
    // not — it lives in one machine's TPM. On any other machine the wrapper is
    // present and permanently unopenable, so offering the button would only
    // produce a confident click and a failure. Checking costs nothing:
    // `OpenAsync` doesn't prompt (pinned by a test in `hello.rs`).
    #[cfg(target_os = "windows")]
    if kind == WrapperKind::Hello && !crate::hello::credential_exists().await {
        return Ok(false);
    }
    let _ = kind;
    Ok(true)
}

/// How the enrolled passwordless method is protected.
///
/// Three states, not two, because "is it Windows Hello" and "did the TPM
/// attest it" are independent questions and conflating them produces an
/// actively false claim. A Hello credential that failed attestation still
/// lives in the Hello container, is still non-exportable, and still needs a
/// gesture — it is nothing like a key sitting in Credential Manager, and
/// telling a user otherwise would push them away from the stronger option.
#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OsUnlockProtection {
    /// Key credential in the TPM, attestation confirmed.
    TpmAttested,
    /// Key credential held by Windows Hello, attestation unavailable.
    /// Usually means Windows hasn't provisioned an attestation identity key
    /// yet, not that the key is unprotected — attestation is lazily set up
    /// and frequently reports `TemporarilyUnavailable` on healthy hardware.
    HelloUnattested,
    /// A random KEK in DPAPI-backed Credential Manager, readable by any
    /// process running as this user. The genuinely weak option.
    CredentialManager,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsUnlockMethod {
    /// Short human-readable name, e.g. "Windows Hello".
    label: String,
    protection: OsUnlockProtection,
}

#[tauri::command]
pub async fn vault_os_unlock_method(app: AppHandle) -> Result<Option<OsUnlockMethod>, String> {
    let Some(kind) = enrolled_passwordless_method(&app)? else {
        return Ok(None);
    };
    let wrappers = wr_vault::wrappers_at(&vault_path(&app)?).map_err(|e| e.to_string())?;
    // Match the wrapper actually being used, not merely any Hello wrapper
    // present — with both methods enrolled the previous version could report
    // one method's protection while unlocking with the other's.
    let protection = match wrappers
        .iter()
        .find(|w| w.kind() == kind)
        .map(|w| &w.params)
    {
        Some(WrapperParams::Hello { attested: true, .. }) => OsUnlockProtection::TpmAttested,
        Some(WrapperParams::Hello { .. }) => OsUnlockProtection::HelloUnattested,
        _ => OsUnlockProtection::CredentialManager,
    };
    Ok(Some(OsUnlockMethod {
        label: kind.label().to_string(),
        protection,
    }))
}

/// Enrols the strongest passwordless unlock method this machine supports, so
/// future launches can skip the master password. Adds a wrapper holding its
/// own encrypted copy of the vault's data key — the data key itself never
/// leaves this process.
///
/// Prefers the TPM-backed Windows Hello method and falls back to the OS
/// keyring only where `KeyCredentialManager` is unavailable. Enrolling Hello
/// also tears down any previously enrolled keyring wrapper: leaving it in
/// place would keep a DPAPI-readable path into the vault open, silently
/// capping the vault's security at the weaker method no matter what the UI
/// says is enabled.
#[tauri::command]
pub async fn vault_enable_os_unlock(
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    // Enrolment runs with no lock held. It can block for as long as the user
    // takes to answer a Hello prompt, and holding the vault mutex across that
    // wedges every other vault command — including the ones the UI polls to
    // show progress. It also turned a slow prompt into a prompt *storm*:
    // impatient clicks piled up on the mutex and each fired its own dialog as
    // its predecessor finished. Fail fast instead.
    #[cfg(target_os = "windows")]
    if crate::hello::is_supported().await {
        use wr_vault::KeyProvider as _;

        let (params, kek) = crate::hello::HelloProvider::new(app)
            .enroll()
            .await
            .map_err(|e| e.to_string())?;

        let mut guard = state.vault.lock().await;
        let vault = guard.as_mut().ok_or("vault is locked")?;
        vault
            .add_enrolled_unlock_method(params, &kek)
            .map_err(|e| e.to_string())?;
        // Only after the Hello wrapper is safely on disk — dropping the old
        // method first would leave the user with neither if enrolment failed.
        match vault.remove_unlock_method(WrapperKind::OsKeyring) {
            Ok(()) | Err(VaultError::NoSuchUnlockMethod(_)) => {}
            Err(e) => return Err(e.to_string()),
        }
        let _ = forget_os_unlock_kek();
        return Ok(());
    }

    let (params, kek) = OsKeyringProvider { app }
        .enroll()
        .await
        .map_err(|e| e.to_string())?;
    let mut guard = state.vault.lock().await;
    let vault = guard.as_mut().ok_or("vault is locked")?;
    vault
        .add_enrolled_unlock_method(params, &kek)
        .map_err(|e| e.to_string())
}

/// Requires an unlocked vault, because removing the wrapper is a change to
/// the vault file. The stored KEK is dropped as well — either half alone is
/// useless, but leaving key material behind for a feature the user just
/// turned off would be careless.
#[tauri::command]
pub async fn vault_disable_os_unlock(state: State<'_, VaultState>) -> Result<(), String> {
    let mut guard = state.vault.lock().await;
    let vault = guard.as_mut().ok_or("vault is locked")?;
    for kind in PASSWORDLESS_METHODS {
        match vault.remove_unlock_method(kind) {
            Ok(()) | Err(VaultError::NoSuchUnlockMethod(_)) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    // Release the vault before the credential teardown below, which talks to
    // Windows and has no business holding this lock.
    drop(guard);

    // The wrapper is gone, so these are now unreferenced key material. Both
    // are best-effort: failing to tidy up shouldn't fail the operation the
    // user actually asked for, which has already succeeded on disk.
    #[cfg(target_os = "windows")]
    crate::hello::forget_credential().await;
    forget_os_unlock_kek()
}

#[tauri::command]
pub async fn vault_unlock_with_os(
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let kind = enrolled_passwordless_method(&app)?
        .ok_or("no passwordless unlock method is set up for this vault")?;
    let path = vault_path(&app)?;

    #[cfg(target_os = "windows")]
    if kind == WrapperKind::Hello {
        let meta = wr_vault::wrappers_at(&path)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| w.kind() == WrapperKind::Hello)
            .ok_or("the Windows Hello unlock method is no longer set up for this vault")?;
        let provider = crate::hello::HelloProvider::new(app);

        let vault = match Vault::unlock_with(path, &provider).await {
            Ok(vault) => vault,
            // The wrapped key's AEAD tag rejected the KEK we derived. That
            // says the signature was wrong but not why, and the two causes
            // call for opposite advice — so pay for a diagnosis here, where
            // the user is already stuck, rather than taxing every enrolment.
            Err(VaultError::UnlockFailed(_)) => {
                return Err(provider.explain_unlock_failure(&meta).await)
            }
            Err(e) => return Err(e.to_string()),
        };
        *state.vault.lock().await = Some(vault);
        return Ok(());
    }
    let _ = kind;

    let vault = Vault::unlock_with(path, &OsKeyringProvider { app })
        .await
        .map_err(|e| e.to_string())?;
    *state.vault.lock().await = Some(vault);
    Ok(())
}

#[tauri::command]
pub async fn vault_set_credential(
    session_id: String,
    secret: VaultSecret,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let mut guard = state.vault.lock().await;
    let vault = guard.as_mut().ok_or("vault is locked")?;
    vault.set(session_id, secret).map_err(|e| e.to_string())
}

/// Reads a key file from disk, validates it parses (and, if it's encrypted,
/// that the passphrase actually decrypts it) before storing anything, and
/// vaults the whole key — never round-tripping the plaintext key material
/// back into the webview process.
#[tauri::command]
pub async fn vault_import_key(
    profile_id: String,
    key_path: String,
    passphrase: Option<String>,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let expanded = wr_ssh::expand_tilde(&key_path);
    let mut key_material = std::fs::read_to_string(&expanded)
        .map_err(|_| format!("could not read key file: {key_path}"))?
        .replace("\r\n", "\n");

    if let Err(e) = wr_ssh::parse_private_key(&key_material, passphrase.as_deref()) {
        key_material.zeroize();
        return Err(e.to_string());
    }

    let mut guard = state.vault.lock().await;
    let vault = guard.as_mut().ok_or("vault is locked")?;
    let result = vault
        .set(
            profile_id,
            VaultSecret::PrivateKey {
                key_material: key_material.clone(),
                passphrase,
            },
        )
        .map_err(|e| e.to_string());
    key_material.zeroize();
    result
}

#[tauri::command]
pub async fn vault_delete_credential(
    session_id: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let mut guard = state.vault.lock().await;
    let vault = guard.as_mut().ok_or("vault is locked")?;
    vault.remove(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vault_has_credential(
    session_id: String,
    state: State<'_, VaultState>,
) -> Result<bool, String> {
    let guard = state.vault.lock().await;
    Ok(guard.as_ref().is_some_and(|v| v.has(&session_id)))
}

/// The three files are meaningless apart: session profiles reference vault
/// entries by id via `hasCredential`, workspaces reference session profiles
/// by id, and a vault full of credentials with no profiles naming the hosts
/// they're for isn't useful either. Exporting just the vault (the old
/// behavior) left you stranded on a new machine — so the export bundles all
/// three, encoding the already-encrypted vault file's contents as a nested
/// JSON value (it's already a small JSON document, nesting it avoids a
/// redundant base64 layer).
#[derive(Serialize, serde::Deserialize)]
struct ExportBundle {
    format: String,
    vault: serde_json::Value,
    sessions: Vec<crate::profiles::SessionProfile>,
    /// Added after the format was already in the wild. Defaulted rather than
    /// version-bumped so bundles written before workspaces existed still
    /// import (as "no workspaces") instead of being rejected outright.
    #[serde(default)]
    workspaces: Vec<crate::workspaces::Workspace>,
}

const EXPORT_FORMAT: &str = "wr-shell-export-v1";

/// Doesn't require the vault to be unlocked in this process — the vault
/// half of the bundle is copied across still encrypted.
#[tauri::command]
pub async fn vault_export(app: AppHandle, dest_path: String) -> Result<(), String> {
    let vault_contents = std::fs::read_to_string(vault_path(&app)?).map_err(|e| e.to_string())?;
    let vault: serde_json::Value =
        serde_json::from_str(&vault_contents).map_err(|e| e.to_string())?;
    let sessions = crate::profiles::read_profiles(&crate::profiles::profiles_path(&app)?)?;
    let workspaces = crate::workspaces::read_workspaces(&crate::workspaces::workspaces_path(&app)?)?;
    let bundle = ExportBundle {
        format: EXPORT_FORMAT.to_string(),
        vault,
        sessions,
        workspaces,
    };
    let contents = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
    std::fs::write(dest_path, contents).map_err(|e| e.to_string())
}

/// Importing replaces the vault file, the session profile list, and the
/// saved workspaces outright, and forces a re-lock (the in-memory vault, if
/// any, belonged to the old file and its key no longer applies) — the caller
/// must unlock again with the imported file's password. Any stored OS-unlock
/// key is cleared too, since it wrapped the *old* file's key and can't unlock
/// the replacement.
#[tauri::command]
pub async fn vault_import(
    app: AppHandle,
    src_path: String,
    state: State<'_, VaultState>,
    workspace_state: State<'_, crate::workspaces::WorkspaceState>,
) -> Result<(), String> {
    *state.vault.lock().await = None;
    forget_os_unlock_kek()?;
    let contents = std::fs::read_to_string(&src_path).map_err(|e| e.to_string())?;
    let bundle: ExportBundle =
        serde_json::from_str(&contents).map_err(|_| "not a valid vault export file".to_string())?;
    if bundle.format != EXPORT_FORMAT {
        return Err(format!("unsupported export format: {}", bundle.format));
    }

    let vault_contents = serde_json::to_string_pretty(&bundle.vault).map_err(|e| e.to_string())?;
    let vault_dest = vault_path(&app)?;
    if let Some(parent) = vault_dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&vault_dest, vault_contents).map_err(|e| e.to_string())?;

    let profiles_dest = crate::profiles::profiles_path(&app)?;
    crate::profiles::write_profiles(&profiles_dest, &bundle.sessions)?;

    crate::workspaces::replace_all(&app, &workspace_state, &bundle.workspaces).await?;

    Ok(())
}
