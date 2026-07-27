//! Saved session profiles: host/user/auth-shape only, never credentials.
//! Password/passphrase secrets aren't persisted here — that's the vault's
//! job (Phase 3). A password-auth profile just means "ask again on open".

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

/// Every profile written before telnet became saveable is an SSH one, so
/// this is what a missing `protocol` field means.
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
    /// `"ssh"`, `"telnet"` or `"serial"`. A discriminator rather than a tagged
    /// enum per protocol: they share everything that matters here (label,
    /// folder, terminal behaviour) and differ only in which of the fields
    /// below mean anything, so splitting the type would duplicate far more
    /// than it separated.
    #[serde(default = "default_protocol")]
    pub protocol: String,
    /// SSH only — empty for telnet, which has no user concept of its own.
    #[serde(default)]
    pub username: String,
    /// SSH only. `"password" | "public_key" | "agent"`, empty for telnet.
    #[serde(rename = "authType", default)]
    pub auth_type: String,
    #[serde(rename = "keyPath")]
    pub key_path: Option<String>,
    /// Whether a credential for this profile is stored in the vault.
    /// `default` so profiles saved before this field existed still parse.
    #[serde(rename = "hasCredential", default)]
    pub has_credential: bool,
    /// Id of another saved profile to jump through (SSH ProxyJump) before
    /// reaching this one — `None` connects directly. `default` so profiles
    /// saved before this field existed still parse.
    #[serde(rename = "jumpProfileId", default)]
    pub jump_profile_id: Option<String>,
    /// Overrides the `TERM` sent with the PTY request — see
    /// `wr_ssh::DEFAULT_TERM_TYPE`. `default` so profiles saved before this
    /// field existed still parse.
    #[serde(rename = "termType", default)]
    pub term_type: Option<String>,
    /// Which byte Backspace sends: `Some(true)` = ^H, `Some(false)`/`None`
    /// = ^?. Purely a frontend concern — stored here only so it travels with
    /// the session profile.
    #[serde(rename = "backspaceSendsCtrlH", default)]
    pub backspace_sends_ctrl_h: Option<bool>,
    /// SSH only — seconds between keepalives, `None` for the default and `0`
    /// to disable. Per-profile rather than global because the timeout that
    /// makes it necessary belongs to the network path to one host, not to this
    /// machine: the box behind the aggressive corporate NAT needs it, the one
    /// on the LAN doesn't. See `wr_ssh::SshConfig::keepalive_seconds`.
    #[serde(rename = "keepaliveSeconds", default)]
    pub keepalive_seconds: Option<u64>,
    /// Serial only — `None` for SSH and telnet, which use `host`/`port`.
    ///
    /// Serial used to be ad-hoc precisely because a COM number stops being
    /// meaningful the moment an adapter moves socket. `SerialProfile` stores
    /// the adapter's USB identity alongside the line settings, and the port is
    /// resolved from that at connect time — so the thing being saved is "the
    /// FTDI cable with serial A50285BI", which survives a replug, rather than
    /// "COM4", which doesn't.
    #[serde(default)]
    pub serial: Option<SerialProfile>,
}

/// A saved serial session: which adapter, and how to talk to it.
///
/// Line settings are stored flat rather than as a `wr_serial::SerialConfig` so
/// that `sessions.json` doesn't gain a `portName` that contradicts the resolved
/// one — the port is derived from `identity` at connect time and belongs
/// nowhere else.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialProfile {
    /// How to find the adapter again. See `wr_serial::resolve`.
    pub identity: wr_serial::PortIdentity,
    pub baud_rate: u32,
    pub data_bits: wr_serial::DataBits,
    pub parity: wr_serial::Parity,
    pub stop_bits: wr_serial::StopBits,
    pub flow_control: wr_serial::FlowControl,
    pub local_echo: bool,
    pub line_ending: wr_serial::LineEnding,
    /// The frontend's input mode (`Normal`, `LocalEcho`, `Readline`,
    /// `ReadlineHex`). Opaque here and never interpreted — only `LocalEcho`
    /// has any backend-visible effect, and that already arrives as
    /// `local_echo`. Stored so it travels with the profile, exactly as
    /// `backspace_sends_ctrl_h` does; without it a session saved in readline
    /// mode would come back in normal mode.
    #[serde(default)]
    pub input_mode: Option<String>,
}

impl SerialProfile {
    /// Builds the connect-time config, with `port_name` filled in from
    /// whichever port the identity resolved to just now.
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

/// Atomic (see `atomic_file`) — a crash or power loss mid-write must not
/// leave a truncated `sessions.json`, silently losing every saved session.
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
