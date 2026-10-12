//! Saved session profiles: host, user and auth shape, never credentials
//! (those live in the vault). A password-auth profile means "ask on open".

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

/// Profiles saved before telnet was saveable are SSH, so a missing `protocol`
/// means SSH.
fn default_protocol() -> String {
    "ssh".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionProfile {
    pub id: String,
    pub label: String,
    pub folder: Option<String>,
    pub host: String,
    pub port: u16,
    /// `"ssh"`, `"telnet"`, `"serial"` or `"local"`. A discriminator rather than
    /// an enum per protocol, since they share most fields.
    #[serde(default = "default_protocol")]
    pub protocol: String,
    /// SSH only; empty for telnet.
    #[serde(default)]
    pub username: String,
    /// SSH only. `"password" | "public_key" | "agent"`, empty for telnet.
    #[serde(rename = "authType", default)]
    pub auth_type: String,
    #[serde(rename = "keyPath")]
    pub key_path: Option<String>,
    /// Whether the vault holds a credential for this profile.
    #[serde(rename = "hasCredential", default)]
    pub has_credential: bool,
    /// Another saved profile to jump through (SSH ProxyJump); `None` connects
    /// directly.
    #[serde(rename = "jumpProfileId", default)]
    pub jump_profile_id: Option<String>,
    /// Overrides the `TERM` sent with the PTY request (see
    /// `wr_ssh::DEFAULT_TERM_TYPE`).
    #[serde(rename = "termType", default)]
    pub term_type: Option<String>,
    /// Backspace byte: `Some(true)` = ^H, otherwise ^?. Frontend-only, stored so
    /// it travels with the profile.
    #[serde(rename = "backspaceSendsCtrlH", default)]
    pub backspace_sends_ctrl_h: Option<bool>,
    /// SSH only: seconds between keepalives, `None` for the default, `0` to
    /// disable. Per profile because the idle timeout belongs to the network path
    /// to one host. See `wr_ssh::SshConfig::keepalive_seconds`.
    #[serde(rename = "keepaliveSeconds", default)]
    pub keepalive_seconds: Option<u64>,
    /// How to wake this host before connecting, or `None` to just connect.
    #[serde(rename = "wakeOnLan", default)]
    pub wake_on_lan: Option<crate::wake::WakeOnLan>,
    /// Whether this profile may reconnect itself when its transport drops. `None`
    /// follows the global setting; `Some(false)` opts out.
    ///
    /// Never read here: connect commands get an already resolved
    /// [`crate::session_registry::ReconnectPolicy`], since the global half is a
    /// frontend setting. Declared so `save_session` doesn't drop it.
    #[serde(rename = "autoReconnect", default)]
    pub auto_reconnect: Option<bool>,
    /// Whether this host's shell history may be imported once for autocomplete.
    /// `None` follows the global setting; `Some(false)` opts out. Like
    /// `auto_reconnect`, resolved by the frontend and only stored here.
    #[serde(rename = "importRemoteHistory", default)]
    pub import_remote_history: Option<bool>,
    /// SSH only: `Some(false)` connects directly even when a global proxy is
    /// configured. `None` follows the global setting.
    #[serde(rename = "useProxy", default)]
    pub use_proxy: Option<bool>,
    /// Start a transcript on connect. `None`/`Some(false)` defer to the global
    /// switch. Stored only so it survives a save.
    #[serde(rename = "logSession", default)]
    pub log_session: Option<bool>,
    /// Serial only. Stores the adapter's USB identity rather than a COM number,
    /// which changes when the adapter moves socket; the port is resolved at
    /// connect time.
    #[serde(default)]
    pub serial: Option<SerialProfile>,
    /// Local shells only.
    #[serde(default)]
    pub local: Option<LocalProfile>,
}

/// A saved local shell: which shell, and how to start it.
///
/// Carries an id as well as a path: paths change on upgrade (PowerShell 7 and
/// 8 install side by side), so a connect re-resolves `shell_id`, falling back
/// to the stored path for a hand-typed or moved shell.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProfile {
    /// `pwsh`, `cmd`, `wsl:Ubuntu` (see `local_shells::ShellInfo`). Empty for a
    /// hand-typed path, used as written.
    #[serde(default)]
    pub shell_id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Open as administrator through the elevated host
    /// (docs/ELEVATED_TABS_PLAN.md). Honored only for
    /// `elevation::ELEVATABLE_SHELLS`.
    #[serde(default)]
    pub elevated: bool,
}

/// A saved serial session: which adapter, and how to talk to it. Line
/// settings are flat rather than a `wr_serial::SerialConfig`, so no stored
/// `portName` can contradict the one resolved from `identity`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialProfile {
    /// How to find the adapter again (see `wr_serial::resolve`).
    pub identity: wr_serial::PortIdentity,
    pub baud_rate: u32,
    pub data_bits: wr_serial::DataBits,
    pub parity: wr_serial::Parity,
    pub stop_bits: wr_serial::StopBits,
    pub flow_control: wr_serial::FlowControl,
    pub local_echo: bool,
    pub line_ending: wr_serial::LineEnding,
    /// The frontend's input mode (`Normal`, `LocalEcho`, `Readline`,
    /// `ReadlineHex`). Opaque here; stored so it travels with the profile.
    #[serde(default)]
    pub input_mode: Option<String>,
}

impl SerialProfile {
    /// Builds the connect-time config with the port the identity just resolved
    /// to.
    pub fn to_config(&self, port_name: String) -> wr_serial::SerialConfig {
        wr_serial::SerialConfig {
            port_name,
            baud_rate: self.baud_rate,
            data_bits: self.data_bits,
            parity: self.parity,
            stop_bits: self.stop_bits,
            flow_control: self.flow_control,
            local_echo: self.local_echo,
            line_ending: self.line_ending,
        }
    }
}

#[derive(Default)]
pub struct ProfileState {
    lock: Mutex<()>,
}

impl ProfileState {
    /// Runs `f` with `sessions.json` held against every other writer.
    ///
    /// The commands below take the mutex directly; this is the door for
    /// everything outside the module that reads, modifies and writes the file
    /// (PuTTY import, the vault's `hasCredential` sweep, vault export and import),
    /// so concurrent writes aren't lost. `f` gets the path, since the read must be
    /// inside the lock too.
    ///
    /// Not re-entrant: calling a `#[tauri::command]` from this module inside `f`
    /// deadlocks.
    pub(crate) async fn with_profiles<R>(
        &self,
        app: &AppHandle,
        f: impl FnOnce(&PathBuf) -> Result<R, String>,
    ) -> Result<R, String> {
        let _guard = self.lock.lock().await;
        f(&profiles_path(app)?)
    }
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

/// Atomic (see `atomic_file`), so a crash mid-write can't truncate
/// `sessions.json`.
pub(crate) fn write_profiles(
    path: &std::path::Path,
    profiles: &[SessionProfile],
) -> Result<(), String> {
    crate::atomic_file::write_json_atomic(path, &profiles)
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
    // Validated on save, while there's still someone to tell.
    if let Some(wake) = &profile.wake_on_lan {
        wake.validate()?;
    }
    let _guard = state.lock.lock().await;
    let path = profiles_path(&app)?;
    let mut profiles = read_profiles(&path)?;
    match profiles.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile,
        None => profiles.push(profile),
    }
    write_profiles(&path, &profiles)
}

/// Not a command: `ssh_connect_profile` uses it to look up a profile before
/// resolving its credential.
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

/// Persists a new display order from the full list of ids. Any id missing
/// from the list keeps its relative position at the end rather than being
/// deleted.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `sessions.json` is read by the next version, so every field added since
    /// v1 is `#[serde(default)]`; this parses a profile written without them.
    #[test]
    fn a_profile_saved_before_waking_existed_still_parses() {
        let json = r#"{
            "id": "abc",
            "label": "desktop",
            "folder": null,
            "host": "192.168.1.10",
            "port": 22,
            "protocol": "ssh",
            "username": "tim",
            "authType": "agent",
            "keyPath": null
        }"#;
        let profile: SessionProfile = serde_json::from_str(json).unwrap();
        assert!(profile.wake_on_lan.is_none());
        assert!(profile.keepalive_seconds.is_none());
    }

    /// What the form saves comes back as saved, under the frontend's camelCase
    /// names.
    #[test]
    fn a_wake_config_round_trips_through_the_stored_shape() {
        let json = r#"{
            "id": "abc",
            "label": "desktop",
            "folder": null,
            "host": "192.168.1.10",
            "port": 22,
            "protocol": "ssh",
            "username": "tim",
            "authType": "agent",
            "keyPath": null,
            "wakeOnLan": { "mac": "aa:bb:cc:dd:ee:ff", "broadcast": "192.168.1.255" }
        }"#;
        let profile: SessionProfile = serde_json::from_str(json).unwrap();
        let wake = profile.wake_on_lan.clone().unwrap();
        assert_eq!(wake.mac, "aa:bb:cc:dd:ee:ff");
        assert_eq!(wake.broadcast.as_deref(), Some("192.168.1.255"));
        // Unwritten when left at the default, in both directions.
        assert!(wake.port.is_none());

        let reparsed: SessionProfile =
            serde_json::from_str(&serde_json::to_string(&profile).unwrap()).unwrap();
        assert_eq!(reparsed.wake_on_lan, profile.wake_on_lan);
    }
}
