//! Saved session profiles: host/user/auth-shape only, never credentials.
//! Password/passphrase secrets aren't persisted here — that's the vault's
//! job (Phase 3). A password-auth profile just means "ask again on open".

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionProfile {
    pub id: String,
    pub label: String,
    pub folder: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(rename = "authType")]
    pub auth_type: String, // "password" | "public_key"
    #[serde(rename = "keyPath")]
    pub key_path: Option<String>,
    /// Whether a credential for this profile is stored in the vault.
    /// `default` so profiles saved before this field existed still parse.
    #[serde(rename = "hasCredential", default)]
    pub has_credential: bool,
}

#[derive(Default)]
pub struct ProfileState {
    lock: Mutex<()>,
}

pub(crate) fn profiles_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("sessions.json"))
        .map_err(|e| e.to_string())
}

pub(crate) fn read_profiles(path: &PathBuf) -> Result<Vec<SessionProfile>, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Same temp-file + fsync + rename pattern as the vault and known_hosts
/// stores (wr-vault/wr-ssh) — a crash or power loss mid-write must not
/// leave a truncated `sessions.json`, silently losing every saved session.
pub(crate) fn write_profiles(path: &PathBuf, profiles: &[SessionProfile]) -> Result<(), String> {
    use std::io::Write;

    let dir = path
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let contents = serde_json::to_string_pretty(profiles).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
    tmp.write_all(contents.as_bytes())
        .map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_sessions(
    app: AppHandle,
    state: tauri::State<'_, ProfileState>,
) -> Result<Vec<SessionProfile>, String> {
    let _guard = state.lock.lock().await;
    read_profiles(&profiles_path(&app)?)
}

#[tauri::command]
pub async fn save_session(
    app: AppHandle,
    profile: SessionProfile,
    state: tauri::State<'_, ProfileState>,
) -> Result<(), String> {
    let _guard = state.lock.lock().await;
    let path = profiles_path(&app)?;
    let mut profiles = read_profiles(&path)?;
    match profiles.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile,
        None => profiles.push(profile),
    }
    write_profiles(&path, &profiles)
}

/// Not a Tauri command — used internally by `ssh_connect_profile` to look
/// up a profile's connection shape before resolving its vault credential.
pub fn get_profile(app: &AppHandle, id: &str) -> Result<SessionProfile, String> {
    read_profiles(&profiles_path(app)?)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("no such session profile: {id}"))
}

#[tauri::command]
pub async fn delete_session(
    app: AppHandle,
    id: String,
    state: tauri::State<'_, ProfileState>,
) -> Result<(), String> {
    let _guard = state.lock.lock().await;
    let path = profiles_path(&app)?;
    let mut profiles = read_profiles(&path)?;
    profiles.retain(|p| p.id != id);
    write_profiles(&path, &profiles)
}

/// Persists a new display order for the saved-session list, given the full
/// list of ids in their desired order (as sent by the frontend, which
/// already has the complete, up-to-date list in memory). Any id not present
/// — there shouldn't be one, but a stale/incomplete list is preferable to a
/// dropped session — keeps its relative position at the end rather than
/// being deleted.
#[tauri::command]
pub async fn reorder_sessions(
    app: AppHandle,
    ordered_ids: Vec<String>,
    state: tauri::State<'_, ProfileState>,
) -> Result<(), String> {
    let _guard = state.lock.lock().await;
    let path = profiles_path(&app)?;
    let mut profiles = read_profiles(&path)?;
    let position: std::collections::HashMap<&str, usize> = ordered_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    profiles.sort_by_key(|p| position.get(p.id.as_str()).copied().unwrap_or(usize::MAX));
    write_profiles(&path, &profiles)
}
