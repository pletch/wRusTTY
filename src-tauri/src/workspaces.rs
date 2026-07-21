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

/// Atomic (see `atomic_file`) — a crash mid-write must not leave a truncated
/// file and lose every saved workspace.
pub(crate) fn write_workspaces(
    path: &std::path::Path,
    workspaces: &[Workspace],
) -> Result<(), String> {
    crate::atomic_file::write_json_atomic(path, &workspaces)
}

/// Names are how the user tells workspaces apart — the menu and the connect
/// dialog show nothing else but a tab count — so two sharing one name leaves
/// no way to know which is which. Compared case-insensitively and trimmed,
/// since "Prod" and "prod " being distinct entries would be just as confusing
/// as an exact duplicate.
fn name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Insert or replace by id, rejecting a name another workspace already holds.
/// Split out from the command so the rule is testable without an AppHandle.
///
/// Only enforced on write: a file that already contains duplicates (written
/// before this existed) still loads, and stays loadable until one of them is
/// saved over.
fn upsert(mut workspaces: Vec<Workspace>, workspace: Workspace) -> Result<Vec<Workspace>, String> {
    let name = workspace.name.trim().to_string();
    if name.is_empty() {
        return Err("workspace name cannot be empty".to_string());
    }
    if workspaces
        .iter()
        .any(|w| w.id != workspace.id && name_key(&w.name) == name_key(&name))
    {
        return Err(format!("a workspace named \"{name}\" already exists"));
    }

    let workspace = Workspace { name, ..workspace };
    match workspaces.iter_mut().find(|w| w.id == workspace.id) {
        Some(existing) => *existing = workspace,
        None => workspaces.push(workspace),
    }
    Ok(workspaces)
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
/// is the same call as creating one. Errors if the name is blank or belongs
/// to a different workspace (see `upsert`).
#[tauri::command]
pub async fn save_workspace(
    app: AppHandle,
    workspace: Workspace,
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let _guard = state.lock.lock().await;
    let path = workspaces_path(&app)?;
    let workspaces = upsert(read_workspaces(&path)?, workspace)?;
    write_workspaces(&path, &workspaces)
}

/// Overwrite the whole list, taking the same lock the commands do. Used by
/// vault import, which replaces every file in the set at once; going through
/// here rather than calling `write_workspaces` directly keeps it from racing
/// a concurrent `save_workspace`.
pub(crate) async fn replace_all(
    app: &AppHandle,
    state: &tauri::State<'_, WorkspaceState>,
    workspaces: &[Workspace],
) -> Result<(), String> {
    let _guard = state.lock.lock().await;
    write_workspaces(&workspaces_path(app)?, workspaces)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(id: &str, name: &str) -> Workspace {
        Workspace {
            id: id.to_string(),
            name: name.to_string(),
            tabs: serde_json::json!([]),
        }
    }

    #[test]
    fn adds_a_new_workspace() {
        let out = upsert(vec![], ws("a", "Prod")).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "Prod");
    }

    /// The whole point of the replace affordance: same id, new tabs, no
    /// "already exists" complaint about its own name.
    #[test]
    fn replaces_in_place_by_id() {
        let existing = vec![ws("a", "Prod"), ws("b", "Lab")];
        let mut updated = ws("a", "Prod");
        updated.tabs = serde_json::json!([{ "id": "t1" }]);
        let out = upsert(existing, updated).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].tabs, serde_json::json!([{ "id": "t1" }]));
        // Order is the menu's display order — replacing must not reshuffle it.
        assert_eq!(out[1].id, "b");
    }

    #[test]
    fn rejects_a_name_another_workspace_holds() {
        let existing = vec![ws("a", "Prod")];
        let err = upsert(existing, ws("b", "Prod")).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
    }

    #[test]
    fn name_comparison_ignores_case_and_surrounding_space() {
        let existing = vec![ws("a", "Prod")];
        assert!(upsert(existing.clone(), ws("b", "  prod ")).is_err());
        assert!(upsert(existing, ws("b", "Prod 2")).is_ok());
    }

    /// Renaming a workspace to something free is still just an upsert.
    #[test]
    fn allows_renaming_to_an_unused_name() {
        let existing = vec![ws("a", "Prod"), ws("b", "Lab")];
        let out = upsert(existing, ws("a", "Staging")).unwrap();
        assert_eq!(out[0].name, "Staging");
    }

    #[test]
    fn stores_the_trimmed_name() {
        let out = upsert(vec![], ws("a", "  Prod  ")).unwrap();
        assert_eq!(out[0].name, "Prod");
    }

    #[test]
    fn rejects_a_blank_name() {
        assert!(upsert(vec![], ws("a", "   ")).is_err());
    }
}
