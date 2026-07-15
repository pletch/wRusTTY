//! Tauri command layer for the credential vault. The decrypted `Vault`
//! (and every secret inside it) lives only in this process's memory for as
//! long as it's unlocked — locking drops it, triggering `wr_vault`'s
//! zeroize-on-drop. Credentials themselves never round-trip back into the
//! webview after being saved; `ssh_connect_profile` (in `ssh.rs`) resolves
//! them entirely on the Rust side.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex as TokioMutex;
use wr_vault::{Vault, VaultSecret};

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
#[tauri::command]
pub async fn vault_import(
    app: AppHandle,
    src_path: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    *state.vault.lock().await = None;
    let dest = vault_path(&app)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(src_path, dest).map_err(|e| e.to_string())?;
    Ok(())
}
