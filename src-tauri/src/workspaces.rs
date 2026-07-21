//! Saved workspaces: a named set of tabs and their pane arrangement.
//!
//! Distinct from a session profile, which describes *one* endpoint. A
//! workspace describes which endpoints are open together and how the panes
//! are split — the part that is tedious to rebuild by hand and that folders
//! can't express.
//!
//! The pane tree itself is stored opaquely as JSON rather than mirrored into
//! Rust types. Its shape is a frontend concern (split directions, sizes, pane
//! ids) that this layer never inspects, and duplicating it here would mean
//! every layout tweak needing a matching Rust change for no gain. The same
//! reasoning as `vault::ExportBundle` holding the vault file as a nested
//! `Value`.
//!
//! Nothing sensitive reaches this file: the frontend strips any pane whose
//! connection carries a plaintext secret before saving (see
//! `sessionSnapshot.ts`), so a workspace only ever references saved profiles
//! or credential-free endpoints.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// The frontend's `Tab[]`, already sanitised. Opaque here by design.
    pub tabs: serde_json::Value,
}

#[derive(Default)]
pub struct WorkspaceState {
    lock: Mutex<()>,
}

pub(crate) fn workspaces_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("workspaces.json"))
        .map_err(|e| e.to_string())
}

pub(crate) fn read_workspaces(path: &PathBuf) -> Result<Vec<Workspace>, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Same temp-file + fsync + rename pattern as `sessions.json`, the vault, and
/// known_hosts — a crash mid-write must not leave a truncated file and lose
/// every saved workspace.
pub(crate) fn write_workspaces(path: &PathBuf, workspaces: &[Workspace]) -> Result<(), String> {
    use std::io::Write;

    let dir = path
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let contents = serde_json::to_string_pretty(workspaces).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
    tmp.write_all(contents.as_bytes())
        .map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_workspaces(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<Vec<Workspace>, String> {
    let _guard = state.lock.lock().await;
    read_workspaces(&workspaces_path(&app)?)
}

/// Insert or replace by id, so renaming or re-capturing an existing workspace
/// is the same call as creating one.
#[tauri::command]
pub async fn save_workspace(
    app: AppHandle,
    workspace: Workspace,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let _guard = state.lock.lock().await;
    let path = workspaces_path(&app)?;
    let mut workspaces = read_workspaces(&path)?;
    match workspaces.iter_mut().find(|w| w.id == workspace.id) {
        Some(existing) => *existing = workspace,
        None => workspaces.push(workspace),
    }
    write_workspaces(&path, &workspaces)
}

#[tauri::command]
pub async fn delete_workspace(
    app: AppHandle,
    id: String,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let _guard = state.lock.lock().await;
    let path = workspaces_path(&app)?;
    let mut workspaces = read_workspaces(&path)?;
    workspaces.retain(|w| w.id != id);
    write_workspaces(&path, &workspaces)
}
