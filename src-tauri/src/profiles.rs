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
}

#[derive(Default)]
pub struct ProfileState {
    lock: Mutex<()>,
}

fn profiles_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("sessions.json"))
        .map_err(|e| e.to_string())
}

fn read_profiles(path: &PathBuf) -> Result<Vec<SessionProfile>, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn write_profiles(path: &PathBuf, profiles: &[SessionProfile]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let contents = serde_json::to_string_pretty(profiles).map_err(|e| e.to_string())?;
    std::fs::write(path, contents).map_err(|e| e.to_string())
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
