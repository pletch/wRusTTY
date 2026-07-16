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
use wr_vault::{Vault, VaultSecret};
use zeroize::Zeroize;

// A single fixed entry, not one per vault file — this app only ever manages
// one vault at a time (at `vault_path`), so there's nothing to key it by.
const KEYRING_SERVICE: &str = "sh.wrshell.app";
const KEYRING_USER: &str = "vault-key";

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
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
    hwnd: windows::Win32::Foundation::HWND,
    message: String,
) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::System::WinRT::{IUserConsentVerifierInterop, RoGetActivationFactory};

    // This runs on a fresh tokio blocking-pool thread with no COM apartment
    // of its own — WinRT activation needs one. Safe to call unconditionally:
    // it no-ops (S_FALSE) if something already initialized this thread, and
    // this thread never touches COM again after returning it to the pool.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let availability = UserConsentVerifier::CheckAvailabilityAsync()
        .and_then(|op| op.join())
        .map_err(|e| e.to_string())?;
    if availability != UserConsentVerifierAvailability::Available {
        return Err(format!("Windows Hello isn't available ({availability:?})"));
    }

    let class_id = HSTRING::from("Windows.Security.Credentials.UI.UserConsentVerifier");
    let interop: IUserConsentVerifierInterop =
        unsafe { RoGetActivationFactory(&class_id) }.map_err(|e| e.to_string())?;
    // The compiler confirmed this method is generic here (its error
    // message on a prior attempt literally said the closure parameter's
    // type "must be known at this point," with no amount of downstream
    // annotation able to reach back far enough to fix it) — a turbofish
    // pins the type down at the call site directly, without needing to
    // name or import IAsyncOperation at all.
    let result = unsafe {
        interop.RequestVerificationForWindowAsync::<UserConsentVerificationResult>(
            hwnd,
            &HSTRING::from(message),
        )
    }
    .and_then(|op| op.join())
    .map_err(|e| e.to_string())?;
    if result != UserConsentVerificationResult::Verified {
        return Err(format!(
            "Windows Hello verification didn't succeed ({result:?})"
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
async fn verify_windows_hello(app: &AppHandle, message: &str) -> Result<(), String> {
    let hwnd = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?
        .hwnd()
        .map_err(|e| e.to_string())?;
    // HWND isn't necessarily Send, and this needs to run on a different
    // thread (spawn_blocking, below) — round-trip through a plain isize
    // instead of moving the HWND value itself across that boundary.
    let hwnd_value = hwnd.0 as isize;
    let message = message.to_string();
    // RequestVerificationForWindowAsync's `.join()` blocks the calling
    // thread until the prompt is answered — spawn_blocking keeps that off
    // the async runtime's worker threads instead of stalling them for
    // however long the user takes to respond.
    tokio::task::spawn_blocking(move || {
        let hwnd = windows::Win32::Foundation::HWND(hwnd_value as _);
        verify_windows_hello_blocking(hwnd, message)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "windows"))]
async fn verify_windows_hello(_app: &AppHandle, _message: &str) -> Result<(), String> {
    // No equivalent local challenge exists on other platforms — the
    // OS-unlock feature this gates is Windows-only to begin with (see
    // vault_enable_os_unlock).
    Ok(())
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

#[tauri::command]
pub async fn vault_unlock(
    app: AppHandle,
    master_password: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let vault = Vault::unlock(vault_path(&app)?, &master_password).map_err(|e| e.to_string())?;
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
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }
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

/// Whether a convenience-unlock key is currently stored in the OS keychain
/// (DPAPI-backed Credential Manager on Windows) — lets the UI offer
/// "unlock with Windows sign-in" instead of the master password, and shows
/// the current on/off state of the setting once unlocked.
#[tauri::command]
pub async fn vault_os_unlock_available() -> Result<bool, String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// Stores a copy of the already-unlocked vault's key in the OS keychain, so
/// future launches can skip the master password. Security now rests on
/// Argon2 only indirectly — retrieving the key (vault_unlock_with_os) is
/// gated on a fresh Windows Hello/PIN challenge each time
/// (verify_windows_hello), not just on DPAPI's own "same logged-in Windows
/// session" check, which by itself would hand the key to anything already
/// running as that user with no further challenge at all.
#[tauri::command]
pub async fn vault_enable_os_unlock(state: State<'_, VaultState>) -> Result<(), String> {
    let guard = state.vault.lock().await;
    let vault = guard.as_ref().ok_or("vault is locked")?;
    let mut key = vault.key_bytes();
    let result = keyring_entry()?.set_password(&BASE64.encode(key));
    key.zeroize();
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vault_disable_os_unlock() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn vault_unlock_with_os(
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    verify_windows_hello(&app, "Unlock wr-shell's credential vault").await?;
    let encoded = keyring_entry()?.get_password().map_err(|e| e.to_string())?;
    let mut key_vec = BASE64.decode(&encoded).map_err(|e| e.to_string())?;
    let key: [u8; 32] = key_vec
        .as_slice()
        .try_into()
        .map_err(|_| "stored key has unexpected length".to_string())?;
    key_vec.zeroize();
    let vault = Vault::unlock_with_key(vault_path(&app)?, key).map_err(|e| e.to_string())?;
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

/// The two files are meaningless apart: session profiles reference vault
/// entries by id via `hasCredential`, and a vault full of credentials with
/// no profiles naming the hosts they're for isn't useful either. Exporting
/// just the vault (the old behavior) left you stranded on a new machine —
/// so the export bundles both, encoding the already-encrypted vault file's
/// contents as a nested JSON value (it's already a small JSON document,
/// nesting it avoids a redundant base64 layer).
#[derive(Serialize, serde::Deserialize)]
struct ExportBundle {
    format: String,
    vault: serde_json::Value,
    sessions: Vec<crate::profiles::SessionProfile>,
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
    let bundle = ExportBundle {
        format: EXPORT_FORMAT.to_string(),
        vault,
        sessions,
    };
    let contents = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
    std::fs::write(dest_path, contents).map_err(|e| e.to_string())
}

/// Importing replaces both the vault file and the session profile list
/// outright, and forces a re-lock (the in-memory vault, if any, belonged to
/// the old file and its key no longer applies) — the caller must unlock
/// again with the imported file's password. Any stored OS-unlock key is
/// cleared too, since it wrapped the *old* file's key and can't unlock the
/// replacement.
#[tauri::command]
pub async fn vault_import(
    app: AppHandle,
    src_path: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    *state.vault.lock().await = None;
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }
    let contents = std::fs::read_to_string(&src_path).map_err(|e| e.to_string())?;
    let bundle: ExportBundle =
        serde_json::from_str(&contents).map_err(|_| "not a wr-shell export file".to_string())?;
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

    Ok(())
}
