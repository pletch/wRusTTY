//! Tauri command layer for the credential vault. The decrypted `Vault` lives
//! only in this process's memory while unlocked; locking drops it (and
//! `wr_vault` zeroizes on drop). Saved credentials never return to the
//! webview; `ssh_connect_profile` (in `ssh.rs`) resolves them on the Rust side.

use std::path::PathBuf;
use std::time::{Duration, Instant};

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

// One fixed entry: the app manages a single vault.
const KEYRING_SERVICE: &str = "sh.wrustty.app";
const KEYRING_USER: &str = "vault-key";
// The pre-rebrand keyring service name; see `migrate_os_unlock_key`.
const PREVIOUS_KEYRING_SERVICE: &str = "sh.wrshell.app";

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

/// Drops the OS-keyring KEK. Idempotent.
fn forget_os_unlock_kek() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Moves an OS-unlock key stored under the pre-rebrand service name
/// (`sh.wrshell.app`) to the current one, so Windows sign-in unlock keeps
/// working. Safe on every launch. For a pre-v2 vault the bytes are still the
/// old data key; `vault_unlock` disposes of them after upgrading.
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

/// Why a consent check failed: a dismissed prompt is silent, while
/// `Unavailable` means the unlock method should be hidden. Only constructed on
/// Windows.
#[derive(Debug)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
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

/// Gates OS unlock on a fresh Windows Hello (or PIN/password) challenge;
/// without it DPAPI would hand the key to any process in the same session. Uses
/// `IUserConsentVerifierInterop::RequestVerificationForWindowAsync` (activated
/// via `RoGetActivationFactory`, not `CoCreateInstance`) so the prompt is
/// parented to our window and appears in front.
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

    // A blocking-pool thread has no COM apartment, and WinRT activation needs
    // one. Harmless if already initialized.
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
    // Generic over the returned interface type, so the turbofish names
    // `IAsyncOperation<...>`, not the result value.
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
        // Dismissed: silent, not an error.
        UserConsentVerificationResult::Canceled => Err(ConsentError::Cancelled),
        // Structural: retrying won't help until Hello is configured.
        r @ (UserConsentVerificationResult::DeviceNotPresent
        | UserConsentVerificationResult::NotConfiguredForUser
        | UserConsentVerificationResult::DisabledByPolicy) => Err(ConsentError::Unavailable(
            format!("Windows Hello isn't usable on this machine ({r:?})"),
        )),
        // Transient (busy sensor, too many attempts): retryable.
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
    // HWND may not be Send; pass it as an isize. `WebviewWindow` is Send.
    let hwnd_value = hwnd.0 as isize;
    let message = message.to_string();
    // `.join()` blocks until the prompt is answered; keep it off the runtime.
    tokio::task::spawn_blocking(move || {
        let hwnd = windows::Win32::Foundation::HWND(hwnd_value as _);
        verify_windows_hello_blocking(&window, hwnd, message)
    })
    .await
    .map_err(|e| ConsentError::Failed(e.to_string()))?
}

#[cfg(not(target_os = "windows"))]
async fn verify_windows_hello(_app: &AppHandle, _message: &str) -> Result<(), ConsentError> {
    // OS unlock is Windows-only (see vault_enable_os_unlock).
    Ok(())
}

/// Unlock method backed by the OS credential store, behind a Windows Hello
/// consent prompt.
///
/// **The weak option.** It stores a random KEK (not the data key) in
/// DPAPI-protected Credential Manager, readable by any process running as this
/// user with no prompt; the Hello check only gates this app's own code path.
/// The stronger `WrapperKind::Hello` provider (see hello.rs) derives its KEK
/// from a TPM-held key instead.
struct OsKeyringProvider {
    app: AppHandle,
}

/// Reads the stored KEK, zeroizing the intermediate text and bytes.
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
        // A fresh random KEK, so the data key never enters the credential store and
        // disabling the method leaves nothing that opens the vault.
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
    /// When ownership was last proven for a master password reset.
    reset_granted: std::sync::Mutex<Option<Instant>>,
    /// A picked bundle waiting for its master password.
    pending_import: std::sync::Mutex<Option<PendingImport>>,
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
    crate::session_registry::vault_unlocked();
    Ok(())
}

/// Also the upgrade path: unlocking a pre-v2 file migrates it and re-keys onto
/// a fresh data key. A pre-v2 vault with Windows sign-in enabled had its data
/// key in Credential Manager; after migration it opens nothing, so it's
/// deleted and the user re-enables the setting.
#[tauri::command]
pub async fn vault_unlock(
    app: AppHandle,
    master_password: String,
    state: State<'_, VaultState>,
    profile_state: State<'_, crate::profiles::ProfileState>,
) -> Result<(), String> {
    unlock_with_password(&app, &master_password, &state, &profile_state).await
}

async fn unlock_with_password(
    app: &AppHandle,
    master_password: &str,
    state: &VaultState,
    profile_state: &crate::profiles::ProfileState,
) -> Result<(), String> {
    let mut vault = Vault::unlock(vault_path(app)?, master_password).map_err(|e| e.to_string())?;
    if !vault.has_unlock_method(WrapperKind::OsKeyring) {
        let _ = forget_os_unlock_kek();
    }
    prune_orphaned_credentials(app, profile_state, &mut vault).await;
    *state.vault.lock().await = Some(vault);
    crate::session_registry::vault_unlocked();
    Ok(())
}

/// Removes credentials whose session profile no longer exists. Deleting a
/// profile can't remove its credential while the vault is locked, so unlock
/// cleans up.
///
/// Skips pruning when unsure: a missing `sessions.json` reads as an empty list
/// (which would destroy every credential), and an unreadable one likewise.
/// Persistence failures are logged, not reported; the next unlock retries.
async fn prune_orphaned_credentials(
    app: &AppHandle,
    profile_state: &crate::profiles::ProfileState,
    vault: &mut Vault,
) {
    // Under the profile lock: a read mid-rewrite would decide irreversibly what
    // to delete.
    let read = profile_state
        .with_profiles(app, |path| {
            if !path.exists() {
                // Absent means unknown, not empty.
                return Err("no session profile store yet".to_string());
            }
            crate::profiles::read_profiles(path)
        })
        .await;
    let Ok(profiles) = read else {
        return;
    };
    let ids: std::collections::HashSet<&str> = profiles.iter().map(|p| p.id.as_str()).collect();
    match vault.retain(|id| ids.contains(id)) {
        Ok(0) => {}
        Ok(n) => log::info!("vault: dropped {n} credential(s) with no matching session profile"),
        Err(e) => log::warn!("vault: could not drop orphaned credentials: {e}"),
    }
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, VaultState>) -> Result<(), String> {
    *state.vault.lock().await = None;
    *reset_grant(&state) = None;
    Ok(())
}

/// Permanently deletes the vault file and every credential. Also clears the
/// OS-unlock keys and every profile's `hasCredential` flag, so the UI doesn't
/// offer to unlock credentials that no longer exist.
#[tauri::command]
pub async fn vault_delete(
    app: AppHandle,
    state: State<'_, VaultState>,
    profile_state: State<'_, crate::profiles::ProfileState>,
) -> Result<(), String> {
    *state.vault.lock().await = None;
    // Both unlock keys become orphans (nothing else would clean up the TPM
    // credential).
    #[cfg(target_os = "windows")]
    crate::hello::forget_credential().await;
    forget_os_unlock_kek()?;
    match std::fs::remove_file(vault_path(&app)?) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }

    // Read-modify-write under the profile lock.
    profile_state
        .with_profiles(&app, |path| {
            let mut profiles = crate::profiles::read_profiles(path)?;
            for profile in &mut profiles {
                profile.has_credential = false;
            }
            crate::profiles::write_profiles(path, &profiles)
        })
        .await?;

    Ok(())
}

/// The passwordless unlock methods, strongest first. Only one is enrolled at a
/// time, but a vault from a machine with only the keyring method still opens,
/// and one upgraded to Hello never falls back.
const PASSWORDLESS_METHODS: [WrapperKind; 3] = [
    WrapperKind::AndroidBiometric,
    WrapperKind::Hello,
    WrapperKind::OsKeyring,
];

/// Whether this build can drive a method (a Hello wrapper can't be opened on a
/// non-Windows build).
// A match rather than `matches!`, which clippy suggests only for the
// platform it expanded on.
#[allow(clippy::match_like_matches_macro)]
fn usable_on_this_platform(kind: WrapperKind) -> bool {
    match kind {
        WrapperKind::Hello => cfg!(target_os = "windows"),
        // `keyring` has no store on mobile and falls back to its mock, which
        // forgets the key: enrolling would look fine until the next launch.
        WrapperKind::OsKeyring => cfg!(desktop),
        WrapperKind::AndroidBiometric => cfg!(target_os = "android"),
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

/// Whether the vault has a usable passwordless unlock method enrolled, read
/// from the vault file (not the credential store, which may hold stale keys).
#[tauri::command]
pub async fn vault_os_unlock_available(app: AppHandle) -> Result<bool, String> {
    let Some(kind) = enrolled_passwordless_method(&app)? else {
        return Ok(false);
    };
    // A Hello wrapper travels with the file but its key lives in one machine's
    // TPM. Checking doesn't prompt (`OpenAsync`; pinned by a test in hello.rs).
    #[cfg(target_os = "windows")]
    if kind == WrapperKind::Hello && !crate::hello::credential_exists().await {
        return Ok(false);
    }
    // Likewise: an imported vault's wrapper may name a key on another phone.
    #[cfg(target_os = "android")]
    if kind == WrapperKind::AndroidBiometric && !crate::android_biometric::key_present(&app).await {
        return Ok(false);
    }
    let _ = kind;
    Ok(true)
}

/// How the enrolled passwordless method is protected. Three states because a
/// Hello credential without attestation is still non-exportable and needs a
/// gesture; calling it weak would steer users away from the stronger option.
#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OsUnlockProtection {
    /// Key credential in the TPM, attestation confirmed.
    TpmAttested,
    /// Key credential held by Windows Hello, attestation unavailable.
    /// Key credential held by Windows Hello, attestation unavailable (often not
    /// yet provisioned, or `TemporarilyUnavailable` on healthy hardware).
    HelloUnattested,
    /// A random KEK in DPAPI-backed Credential Manager, readable by any process
    /// running as this user.
    CredentialManager,
    /// A Keystore key that needs a strong biometric for every use.
    AndroidKeystore,
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
    // The wrapper actually in use, not merely any Hello wrapper.
    let protection = match wrappers
        .iter()
        .find(|w| w.kind() == kind)
        .map(|w| &w.params)
    {
        Some(WrapperParams::Hello { attested: true, .. }) => OsUnlockProtection::TpmAttested,
        Some(WrapperParams::Hello { .. }) => OsUnlockProtection::HelloUnattested,
        Some(WrapperParams::AndroidBiometric { .. }) => OsUnlockProtection::AndroidKeystore,
        _ => OsUnlockProtection::CredentialManager,
    };
    Ok(Some(OsUnlockMethod {
        label: kind.label().to_string(),
        protection,
    }))
}

/// Enrolls the strongest passwordless unlock method available (TPM-backed
/// Windows Hello, else the OS keyring), wrapping its own copy of the data key.
/// Enrolling Hello removes any keyring wrapper, which would otherwise keep a
/// DPAPI-readable path into the vault.
// Android returns from its own branch, leaving the rest for the other platforms.
#[cfg_attr(target_os = "android", allow(unreachable_code, unused_variables))]
#[tauri::command]
pub async fn vault_enable_os_unlock(
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    // Enrolled with no lock held, as below: the prompt can take a while.
    #[cfg(target_os = "android")]
    {
        use wr_vault::KeyProvider as _;
        let (params, kek) = crate::android_biometric::AndroidBiometricProvider { app }
            .enroll()
            .await
            .map_err(|e| e.to_string())?;
        let mut guard = state.vault.lock().await;
        let vault = guard.as_mut().ok_or("vault is locked")?;
        return vault
            .add_enrolled_unlock_method(params, &kek)
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    if !usable_on_this_platform(WrapperKind::OsKeyring) {
        return Err("passwordless unlock isn't available on this platform yet".to_string());
    }
    // Enroll with no lock held: a Hello prompt can take a while, and holding
    // the vault mutex would block every other vault command (and queue up a
    // prompt per impatient click).
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
        // Only after the Hello wrapper is on disk.
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

/// Removes the passwordless methods (needs an unlocked vault) and the stored
/// key material.
#[tauri::command]
pub async fn vault_disable_os_unlock(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let mut guard = state.vault.lock().await;
    let vault = guard.as_mut().ok_or("vault is locked")?;
    for kind in PASSWORDLESS_METHODS {
        match vault.remove_unlock_method(kind) {
            Ok(()) | Err(VaultError::NoSuchUnlockMethod(_)) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    // Release the vault before talking to Windows.
    drop(guard);

    // Best-effort cleanup; the user's request already succeeded.
    #[cfg(target_os = "windows")]
    crate::hello::forget_credential().await;
    #[cfg(target_os = "android")]
    crate::android_biometric::forget(&app).await;
    forget_os_unlock_kek()
}

#[tauri::command]
pub async fn vault_unlock_with_os(
    app: AppHandle,
    state: State<'_, VaultState>,
    profile_state: State<'_, crate::profiles::ProfileState>,
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
        let for_prune = app.clone();
        let provider = crate::hello::HelloProvider::new(app);

        let mut vault = match Vault::unlock_with(path, &provider).await {
            Ok(vault) => vault,
            // The derived KEK was rejected. Diagnose why here (the advice differs
            // by cause), rather than on every enrollment.
            Err(VaultError::UnlockFailed(_)) => {
                return Err(provider.explain_unlock_failure(&meta).await)
            }
            Err(e) => return Err(e.to_string()),
        };
        prune_orphaned_credentials(&for_prune, &profile_state, &mut vault).await;
        *state.vault.lock().await = Some(vault);
        crate::session_registry::vault_unlocked();
        return Ok(());
    }
    #[cfg(target_os = "android")]
    if kind == WrapperKind::AndroidBiometric {
        let for_prune = app.clone();
        let provider = crate::android_biometric::AndroidBiometricProvider { app };
        let mut vault = Vault::unlock_with(path, &provider)
            .await
            .map_err(|e| e.to_string())?;
        prune_orphaned_credentials(&for_prune, &profile_state, &mut vault).await;
        *state.vault.lock().await = Some(vault);
        crate::session_registry::vault_unlocked();
        return Ok(());
    }
    let _ = kind;

    let for_prune = app.clone();
    let mut vault = Vault::unlock_with(path, &OsKeyringProvider { app })
        .await
        .map_err(|e| e.to_string())?;
    prune_orphaned_credentials(&for_prune, &profile_state, &mut vault).await;
    *state.vault.lock().await = Some(vault);
    crate::session_registry::vault_unlocked();
    Ok(())
}

/// Proves whoever's asking owns the vault, by the current password or a fresh
/// passwordless prompt. An unlocked app isn't enough: someone at one could otherwise
/// set a password of their own, export, and decrypt every secret offline.
async fn confirm_vault_owner(
    app: &AppHandle,
    current_password: Option<&str>,
) -> Result<(), String> {
    let path = vault_path(app)?;
    if let Some(password) = current_password {
        return Vault::unlock(path, password)
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    let kind = enrolled_passwordless_method(app)?
        .ok_or("enter your current master password to change it")?;
    #[cfg(target_os = "windows")]
    if kind == WrapperKind::Hello {
        let provider = crate::hello::HelloProvider::new(app.clone());
        return Vault::unlock_with(path, &provider)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    #[cfg(target_os = "android")]
    if kind == WrapperKind::AndroidBiometric {
        let provider = crate::android_biometric::AndroidBiometricProvider { app: app.clone() };
        return Vault::unlock_with(path, &provider)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    let _ = kind;
    Vault::unlock_with(path, &OsKeyringProvider { app: app.clone() })
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// How long proving ownership lets a reset go ahead: long enough to think of and type
/// a new password, short enough that a walked-away-from app doesn't stay open to one.
const RESET_WINDOW: Duration = Duration::from_secs(5 * 60);

fn reset_grant_valid(granted: Option<Instant>, now: Instant) -> bool {
    granted.is_some_and(|at| now.duration_since(at) < RESET_WINDOW)
}

fn reset_grant(state: &VaultState) -> std::sync::MutexGuard<'_, Option<Instant>> {
    state
        .reset_granted
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The first step of a reset: proves ownership, which `vault_reset_master_password`
/// then requires, so the order is enforced here and not only by the screen.
/// `current_password` of `None` asks for the passwordless prompt instead.
#[tauri::command]
pub async fn vault_begin_master_password_reset(
    app: AppHandle,
    current_password: Option<String>,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    if state.vault.lock().await.is_none() {
        return Err("vault is locked".to_string());
    }
    // With no lock held: the prompt can take a while.
    confirm_vault_owner(&app, current_password.as_deref()).await?;
    *reset_grant(&state) = Some(Instant::now());
    Ok(())
}

/// Replaces the master password. It only wraps the vault's key, so saved credentials
/// and any passwordless method carry on as they were. Copies of the vault exported
/// earlier still open with the old password.
#[tauri::command]
pub async fn vault_reset_master_password(
    new_password: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    if new_password.is_empty() {
        return Err("the new password can't be empty".to_string());
    }
    // Used up either way: one proof, one reset.
    let granted = reset_grant(&state).take();
    if !reset_grant_valid(granted, Instant::now()) {
        return Err("confirm it's you again to reset the master password".to_string());
    }
    let mut guard = state.vault.lock().await;
    let vault = guard.as_mut().ok_or("vault is locked")?;
    vault
        .change_master_password(&new_password)
        .await
        .map_err(|e| e.to_string())
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

/// Reads a key file, checks it parses (and that the passphrase decrypts it),
/// then vaults the whole key without it ever reaching the webview.
#[tauri::command]
pub async fn vault_import_key(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: AppHandle,
    profile_id: String,
    key_path: String,
    passphrase: Option<String>,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    let contents = if crate::android_files::is_content_uri(&key_path) {
        String::from_utf8(crate::android_files::read(&app, &key_path).await?)
            .map_err(|_| "that file isn't a text SSH key".to_string())?
    } else {
        std::fs::read_to_string(wr_ssh::expand_tilde(&key_path))
            .map_err(|_| format!("could not read key file: {key_path}"))?
    };
    #[cfg(not(target_os = "android"))]
    let contents = std::fs::read_to_string(wr_ssh::expand_tilde(&key_path))
        .map_err(|_| format!("could not read key file: {key_path}"))?;
    let mut key_material = contents.replace("\r\n", "\n");

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

/// What a bundle holds besides the vault: session profiles and workspaces, which
/// reference it and each other and are useless apart.
#[derive(Serialize, serde::Deserialize)]
struct BundleDetails {
    sessions: Vec<crate::profiles::SessionProfile>,
    /// Defaulted so bundles from before workspaces existed still import.
    #[serde(default)]
    workspaces: Vec<crate::workspaces::Workspace>,
}

/// The export bundle. The already-encrypted vault file is nested as JSON, and everything
/// else is sealed with that vault's key, so opening the file takes its master password.
#[derive(Serialize, serde::Deserialize)]
struct ExportBundle {
    format: String,
    vault: serde_json::Value,
    details: wr_vault::Sealed,
}

/// The format from before the details were encrypted, still readable so old backups
/// can be restored.
#[derive(serde::Deserialize)]
struct PlainExportBundle {
    vault: serde_json::Value,
    #[serde(flatten)]
    details: BundleDetails,
}

const EXPORT_FORMAT: &str = "wr-shell-export-v2";
const PLAIN_EXPORT_FORMAT: &str = "wr-shell-export-v1";

/// A parsed bundle whose vault is known to be usable, before its password is known.
enum PendingImport {
    Sealed {
        vault: serde_json::Value,
        details: wr_vault::Sealed,
    },
    Plain(PlainExportBundle),
}

fn parse_bundle(contents: &str) -> Result<PendingImport, String> {
    let invalid = || "not a valid vault export file".to_string();
    let value: serde_json::Value = serde_json::from_str(contents).map_err(|_| invalid())?;
    let format = value
        .get("format")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    let pending = match format {
        EXPORT_FORMAT => {
            let bundle: ExportBundle = serde_json::from_value(value).map_err(|_| invalid())?;
            PendingImport::Sealed {
                vault: bundle.vault,
                details: bundle.details,
            }
        }
        PLAIN_EXPORT_FORMAT => {
            let bundle: PlainExportBundle = serde_json::from_value(value).map_err(|_| invalid())?;
            validate_sessions(&bundle.details.sessions)?;
            PendingImport::Plain(bundle)
        }
        other => return Err(format!("unsupported export format: {other}")),
    };
    // Before anything is torn down: an invalid vault, or one without a master-password
    // wrapper, would lock the user out.
    let vault = match &pending {
        PendingImport::Sealed { vault, .. } => vault,
        PendingImport::Plain(bundle) => &bundle.vault,
    };
    wr_vault::validate(vault).map_err(|e| format!("not a valid vault file: {e}"))?;
    Ok(pending)
}

/// The bundle's vault and details, if `password` opens it.
fn open_bundle(
    pending: &PendingImport,
    password: &str,
) -> Result<(serde_json::Value, BundleDetails), wr_vault::VaultError> {
    match pending {
        PendingImport::Sealed { vault, details } => {
            let plaintext = wr_vault::open_sealed(vault, password, details)?;
            let details = serde_json::from_slice(&plaintext)
                .map_err(|e| wr_vault::VaultError::Corrupt(e.to_string()))?;
            Ok((vault.clone(), details))
        }
        PendingImport::Plain(bundle) => {
            wr_vault::verify_master_password(&bundle.vault, password)?;
            let details = BundleDetails {
                sessions: bundle.details.sessions.clone(),
                workspaces: bundle.details.workspaces.clone(),
            };
            Ok((bundle.vault.clone(), details))
        }
    }
}

/// Seals the details with the unlocked vault. `vault_file` is the same vault on disk.
fn seal_bundle(
    vault: &Vault,
    vault_file: serde_json::Value,
    details: &BundleDetails,
) -> Result<ExportBundle, String> {
    let plaintext = serde_json::to_vec(details).map_err(|e| e.to_string())?;
    Ok(ExportBundle {
        format: EXPORT_FORMAT.to_string(),
        vault: vault_file,
        details: vault.seal(&plaintext).map_err(|e| e.to_string())?,
    })
}

/// Runs the file dialog here rather than accepting a path from the webview,
/// since import replaces the live vault and a forged path could plant one.
/// Uses the callback form: the blocking variants are unsafe on the event-loop
/// thread.
async fn pick_bundle(app: &AppHandle, saving: bool) -> Option<tauri_plugin_dialog::FilePath> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    let builder = app
        .dialog()
        .file()
        .add_filter("wRusTTY export bundle", &["wrb"]);
    if saving {
        builder
            .set_file_name("wrustty-export.wrb")
            .save_file(|path| {
                let _ = tx.send(path);
            });
    } else {
        builder.pick_file(|path| {
            let _ = tx.send(path);
        });
    }

    // A dropped sender is a cancel.
    rx.await.ok().flatten()
}

/// A picked file's text. On Android the picker returns a `content://` link, which
/// can't become a path, so it has to be told apart here. Treating it as a cancel made
/// an import silently do nothing.
async fn read_picked(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: &AppHandle,
    picked: tauri_plugin_dialog::FilePath,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let uri = picked.to_string();
        if crate::android_files::is_content_uri(&uri) {
            let bytes = crate::android_files::read(app, &uri).await?;
            return String::from_utf8(bytes)
                .map_err(|_| "not a valid vault export file".to_string());
        }
    }
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

async fn write_picked<T: Serialize>(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: &AppHandle,
    picked: tauri_plugin_dialog::FilePath,
    value: &T,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let uri = picked.to_string();
        if crate::android_files::is_content_uri(&uri) {
            let contents = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
            return crate::android_files::write(app, &uri, contents.as_bytes()).await;
        }
    }
    // Atomic, so a crash can't destroy the previous backup.
    let path = picked.into_path().map_err(|e| e.to_string())?;
    crate::atomic_file::write_json_atomic(&path, value)
}

/// Exports the bundle. The vault has to be unlocked, since its key seals the sessions
/// and workspaces. Returns `false` if the dialog was dismissed.
#[tauri::command]
pub async fn vault_export(
    app: AppHandle,
    state: State<'_, VaultState>,
    profile_state: State<'_, crate::profiles::ProfileState>,
) -> Result<bool, String> {
    const LOCKED: &str = "unlock the vault before exporting";
    if state.vault.lock().await.is_none() {
        return Err(LOCKED.to_string());
    }
    let Some(dest) = pick_bundle(&app, true).await else {
        return Ok(false);
    };
    let vault_contents = std::fs::read_to_string(vault_path(&app)?).map_err(|e| e.to_string())?;
    let vault: serde_json::Value =
        serde_json::from_str(&vault_contents).map_err(|e| e.to_string())?;
    // Under the lock, so the backup isn't of a half-written file.
    let sessions = profile_state
        .with_profiles(&app, crate::profiles::read_profiles)
        .await?;
    let workspaces =
        crate::workspaces::read_workspaces(&crate::workspaces::workspaces_path(&app)?)?;
    let details = BundleDetails {
        sessions,
        workspaces,
    };
    let bundle = {
        let guard = state.vault.lock().await;
        // It may have locked during the dialog.
        let unlocked = guard.as_ref().ok_or(LOCKED)?;
        seal_bundle(unlocked, vault, &details)?
    };
    write_picked(&app, dest, &bundle).await?;
    Ok(true)
}

/// Validates the parts of the bundle's sessions the app would act on
/// by itself, currently `wake_on_lan` (outbound UDP on connect). The whole
/// bundle is refused rather than repaired, before anything is torn down. New
/// self-acting profile fields should be checked here too.
fn validate_sessions(sessions: &[crate::profiles::SessionProfile]) -> Result<(), String> {
    for session in sessions {
        if let Some(wake) = &session.wake_on_lan {
            wake.validate().map_err(|e| {
                format!(
                    "the session \"{}\" in this bundle has an unusable wake setting: {e}",
                    session.label
                )
            })?;
        }
    }
    Ok(())
}

fn pending_import(state: &VaultState) -> std::sync::MutexGuard<'_, Option<PendingImport>> {
    state
        .pending_import
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// First half of an import: picks a bundle and checks its form. Nothing changes until
/// [`vault_import_finish`]. Returns `false` if the dialog was dismissed.
#[tauri::command]
pub async fn vault_import_pick(
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<bool, String> {
    *pending_import(&state) = None;
    let Some(picked) = pick_bundle(&app, false).await else {
        return Ok(false);
    };
    let contents = read_picked(&app, picked).await?;
    *pending_import(&state) = Some(parse_bundle(&contents)?);
    Ok(true)
}

#[tauri::command]
pub async fn vault_import_cancel(state: State<'_, VaultState>) -> Result<(), String> {
    *pending_import(&state) = None;
    Ok(())
}

/// Replaces the vault file, session profiles and workspaces with the picked bundle's,
/// then unlocks with the password that opened it. The stored OS-unlock key is cleared,
/// since it wrapped the old data key.
///
/// Everything is opened and validated before anything is torn down, so a bad or
/// abandoned import leaves the current unlock intact, and a wrong password can be tried
/// again. Each write is atomic, but not all three together; after a crash, re-run the
/// import.
///
/// Sessions are untrusted: a planted bundle, sealed under its author's own password,
/// could point a `key_path` at any host. The import UI makes the replacement obvious so
/// the user notices unfamiliar entries; signing can't help, since only the master
/// password travels with a backup.
#[tauri::command]
pub async fn vault_import_finish(
    app: AppHandle,
    master_password: String,
    state: State<'_, VaultState>,
    workspace_state: State<'_, crate::workspaces::WorkspaceState>,
    profile_state: State<'_, crate::profiles::ProfileState>,
) -> Result<(), String> {
    let pending = pending_import(&state)
        .take()
        .ok_or("no backup is waiting to be imported")?;
    let opened = open_bundle(&pending, &master_password);
    let (vault_file, details) = match opened {
        Ok(opened) => opened,
        Err(wrong @ wr_vault::VaultError::WrongPassword) => {
            *pending_import(&state) = Some(pending);
            return Err(wrong.to_string());
        }
        Err(e) => return Err(e.to_string()),
    };
    validate_sessions(&details.sessions)?;

    // Now drop the current unlock and the old OS-unlock key.
    *state.vault.lock().await = None;
    forget_os_unlock_kek()?;
    #[cfg(target_os = "android")]
    crate::android_biometric::forget(&app).await;

    // Atomic: the vault has no other copy.
    crate::atomic_file::write_json_atomic(&vault_path(&app)?, &vault_file)?;

    profile_state
        .with_profiles(&app, |path| {
            crate::profiles::write_profiles(path, &details.sessions)
        })
        .await?;

    crate::workspaces::replace_all(&app, &workspace_state, &details.workspaces).await?;

    unlock_with_password(&app, &master_password, &state, &profile_state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reset_needs_a_recent_proof_of_ownership() {
        let now = Instant::now();
        assert!(!reset_grant_valid(None, now));
        assert!(reset_grant_valid(Some(now), now));
        let just_inside = now + RESET_WINDOW - Duration::from_secs(1);
        assert!(reset_grant_valid(Some(now), just_inside));
        assert!(!reset_grant_valid(Some(now), now + RESET_WINDOW));
    }

    #[test]
    fn a_proof_of_ownership_is_good_for_one_reset() {
        let state = VaultState::default();
        *reset_grant(&state) = Some(Instant::now());
        assert!(reset_grant_valid(
            reset_grant(&state).take(),
            Instant::now()
        ));
        assert!(!reset_grant_valid(
            reset_grant(&state).take(),
            Instant::now()
        ));
    }

    /// Built by deserializing, as a bundle's sessions are, so `serde(default)`
    /// applies.
    fn session_with_wake(wake: &str) -> crate::profiles::SessionProfile {
        serde_json::from_str(&format!(
            r#"{{
                "id": "abc",
                "label": "the one in the study",
                "folder": null,
                "host": "desktop.lan",
                "port": 22,
                "protocol": "ssh",
                "username": "tim",
                "authType": "agent",
                "keyPath": null,
                "wakeOnLan": {wake}
            }}"#
        ))
        .unwrap()
    }

    /// An unlocked vault with `password`, and the same vault as a file holds it.
    fn vault_and_file(
        dir: &tempfile::TempDir,
        password: &str,
    ) -> (wr_vault::Vault, serde_json::Value) {
        let path = dir.path().join("vault.wrv");
        let vault = wr_vault::Vault::create(&path, password).unwrap();
        let file = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        (vault, file)
    }

    fn details() -> BundleDetails {
        BundleDetails {
            sessions: vec![session_with_wake("null")],
            workspaces: Vec::new(),
        }
    }

    #[test]
    fn an_export_reveals_no_session_details_without_the_password() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, file) = vault_and_file(&dir, "correct horse");
        let bundle = seal_bundle(&vault, file, &details()).unwrap();
        let written = serde_json::to_string(&bundle).unwrap();
        for detail in ["desktop.lan", "tim", "the one in the study"] {
            assert!(!written.contains(detail), "{detail} is readable");
        }

        let pending = parse_bundle(&written).unwrap();
        let wrong = open_bundle(&pending, "wrong");
        assert!(matches!(wrong, Err(wr_vault::VaultError::WrongPassword)));
        let (_, opened) = open_bundle(&pending, "correct horse").unwrap();
        assert_eq!(opened.sessions[0].host, "desktop.lan");
        assert_eq!(opened.sessions[0].username, "tim");
    }

    #[test]
    fn an_old_plain_backup_still_restores_with_its_password() {
        let dir = tempfile::tempdir().unwrap();
        let (_vault, file) = vault_and_file(&dir, "correct horse");
        let old = serde_json::json!({
            "format": PLAIN_EXPORT_FORMAT,
            "vault": file,
            "sessions": [serde_json::to_value(session_with_wake("null")).unwrap()],
        });

        let pending = parse_bundle(&old.to_string()).unwrap();
        assert!(open_bundle(&pending, "wrong").is_err());
        let (_, opened) = open_bundle(&pending, "correct horse").unwrap();
        assert_eq!(opened.sessions[0].host, "desktop.lan");
        assert!(opened.workspaces.is_empty());
    }

    #[test]
    fn an_unknown_or_malformed_bundle_is_refused() {
        let unknown = parse_bundle(r#"{"format": "wr-shell-export-v9"}"#)
            .err()
            .unwrap();
        assert!(unknown.contains("wr-shell-export-v9"), "{unknown}");
        assert!(parse_bundle("not json").is_err());
        assert!(parse_bundle(r#"{"format": "wr-shell-export-v2"}"#).is_err());
    }

    #[test]
    fn a_bundle_with_an_ordinary_wake_setting_imports() {
        let sessions = [
            session_with_wake(r#"null"#),
            session_with_wake(r#"{"mac": "aa:bb:cc:dd:ee:ff"}"#),
            session_with_wake(r#"{"mac": "aa:bb:cc:dd:ee:ff", "broadcast": "192.168.1.255"}"#),
        ];
        assert!(validate_sessions(&sessions).is_ok());
    }

    /// Refused with the session's name, before anything is torn down.
    #[test]
    fn a_bundle_pointing_a_wake_somewhere_it_doesnt_belong_is_refused() {
        let sessions = [session_with_wake(
            r#"{"mac": "aa:bb:cc:dd:ee:ff", "broadcast": "8.8.8.8", "port": 53}"#,
        )];
        let error = validate_sessions(&sessions).unwrap_err();
        assert!(error.contains("the one in the study"), "{error}");
    }

    #[test]
    fn a_bundle_asking_for_an_absurd_wait_is_refused() {
        let sessions = [session_with_wake(
            r#"{"mac": "aa:bb:cc:dd:ee:ff", "waitSeconds": 31536000}"#,
        )];
        assert!(validate_sessions(&sessions).is_err());
    }
}
