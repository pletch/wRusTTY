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
    /// How to wake this host before connecting to it, or `None` to just
    /// connect. Per-profile for the same reason `keepalive_seconds` is: a MAC
    /// address describes one machine, and whether that machine sleeps is a
    /// fact about it rather than about this one. `default` so profiles saved
    /// before this field existed still parse.
    #[serde(rename = "wakeOnLan", default)]
    pub wake_on_lan: Option<crate::wake::WakeOnLan>,
    /// Whether this profile may reconnect itself when its transport drops.
    /// `None` — which every profile saved before this field existed reads as —
    /// means "follow the global setting", and `Some(false)` opts this one
    /// session out of it.
    ///
    /// Stored but never read here: the connect commands are handed an already
    /// resolved [`crate::session_registry::ReconnectPolicy`], because the
    /// global half of the same decision is a frontend setting and resolving
    /// the two in different places is how they come to disagree. What this
    /// field needs from the backend is to survive a save, which is the whole
    /// reason it is declared — `save_session` takes a typed profile, so a
    /// field missing from this struct is a field dropped from `sessions.json`.
    #[serde(rename = "autoReconnect", default)]
    pub auto_reconnect: Option<bool>,
    /// Whether this session may have its remote shell history imported once,
    /// for autocomplete. `None` — which every profile saved before this field
    /// existed reads as — means "follow the global setting"; `Some(false)`
    /// opts this one host out of it whatever that setting says.
    ///
    /// Per-host because the question is about the *host*, not about this
    /// machine: importing from the homelab box and never from the customer's
    /// bastion is the normal shape of the answer. Like `auto_reconnect` this is
    /// stored but never read here — the frontend resolves the two halves, and
    /// what this field needs from the backend is to survive a save.
    #[serde(rename = "importRemoteHistory", default)]
    pub import_remote_history: Option<bool>,
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

impl ProfileState {
    /// Runs `f` with `sessions.json` held against every other writer.
    ///
    /// The commands below take the mutex directly. This is the same door for
    /// everything *outside* this module that touches the same file — the PuTTY
    /// import, the vault's `hasCredential` sweep, vault export and import —
    /// several of which read, modify and write. Without it, running the PuTTY
    /// import while the session browser saves a rename means one of the two
    /// writes is silently lost: both read the same list, and the second to
    /// finish writes its own copy over the other's.
    ///
    /// `f` is handed the profile path rather than the profiles, because the
    /// callers differ in what they need — one only reads, one replaces the file
    /// wholesale — and a read-modify-write is only safe if the *read* is inside
    /// the lock too.
    ///
    /// Not re-entrant: the mutex is not, so calling a `#[tauri::command]` from
    /// this module inside `f` deadlocks.
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
    // Checked here rather than only at connect time: this is the point where
    // there is still a person to tell. A bad MAC or a wake target that isn't
    // one used to save cleanly and surface a minute into a connection, in a
    // pane, with the form long closed.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `sessions.json` is a compatibility surface: it is on disk before an
    /// update and read by the version after it. Every field added since v1 is
    /// `#[serde(default)]` for this reason, and the way that stays true is a
    /// test that parses a profile written without them.
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

    /// The other direction: what the form saves has to come back as what it
    /// saved, under the camelCase names the frontend reads.
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
        // Unwritten by the form when left at its default, and unwritten again
        // on the way back out.
        assert!(wake.port.is_none());

        let reparsed: SessionProfile =
            serde_json::from_str(&serde_json::to_string(&profile).unwrap()).unwrap();
        assert_eq!(reparsed.wake_on_lan, profile.wake_on_lan);
    }
}
