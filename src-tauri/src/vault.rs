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
/// whatever gates that keychain entry (Windows sign-in / Windows Hello via
/// DPAPI), not on Argon2 — an explicit, opt-in trade of the vault's own KDF
/// strength for convenience.
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

/// Exporting just copies the encrypted file — it's already safe to move
/// anywhere without decrypting, and doesn't require the vault to be
/// unlocked in this process.
#[tauri::command]
pub async fn vault_export(app: AppHandle, dest_path: String) -> Result<(), String> {
    std::fs::copy(vault_path(&app)?, dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Importing replaces the vault file outright and forces a re-lock (the
/// in-memory vault, if any, belonged to the old file and its key no longer
/// applies) — the caller must unlock again with the imported file's password.
/// Any stored OS-unlock key is cleared too, since it wrapped the *old*
/// file's key and can't unlock the replacement.
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
    let dest = vault_path(&app)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(src_path, dest).map_err(|e| e.to_string())?;
    Ok(())
}
