//! Tauri command layer for SSH sessions: owns the in-memory session
//! registry, pushes PTY output/status through a push `Channel` (same shape
//! proved out by the Phase 0 echo demo this module replaces), and relays
//! host-key accept/reject prompts to the frontend via a pending-request map.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::{oneshot, Mutex as TokioMutex};
use wr_ssh::{
    AuthMethod, ForwardHandle, ForwardSpec, HostKeyPrompt, HostKeyStatus, HostKeyVerifier,
    SshConfig, SshConnector, SshSession,
};
use wr_vault::VaultSecret;

use crate::connection_status::status_label;
use crate::profiles;
use crate::session_registry::{SessionRegistry, Slot};
use crate::vault::VaultState;

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SshEvent {
    // PTY output travels on its own raw-bytes Channel<InvokeResponseBody>
    // instead (see coalesce.rs) — no base64/JSON overhead for what's
    // already just bytes.
    Status {
        status: String,
    },
    HostKeyPrompt {
        request_id: String,
        host: String,
        port: u16,
        fingerprint: String,
        /// "unknown" (first connection) or "changed" (possible MITM or
        /// host reprovision) — the frontend must word these very differently.
        status: String,
        /// For "changed" only: the fingerprint previously on record, so the
        /// user can compare old vs. new instead of judging the new key blind.
        stored_fingerprint: Option<String>,
    },
}

/// SSH keeps its two extra maps *alongside* the shared registry rather than
/// inside it: a host-key prompt and a set of port forwards are SSH's, not
/// every transport's, and pushing them down would have made the generic
/// registry carry fields two of its three users don't have.
pub struct SshState {
    sessions: SessionRegistry<SshConnector>,
    pending_host_key: TokioMutex<HashMap<String, oneshot::Sender<bool>>>,
    /// Keyed by forward id; each entry also remembers its owning session id
    /// so `ssh_disconnect` can stop every forward that session opened.
    forwards: TokioMutex<HashMap<String, (String, ForwardHandle)>>,
    /// Request and forward ids only. Session ids come from the registry's own
    /// counter now, so these three no longer share one — they never needed to,
    /// since the prefix is what makes an id unique.
    next_id: AtomicU64,
}

impl Default for SshState {
    fn default() -> Self {
        Self {
            sessions: SessionRegistry::new("ssh"),
            pending_host_key: TokioMutex::default(),
            forwards: TokioMutex::default(),
            next_id: AtomicU64::new(0),
        }
    }
}

struct TauriHostKeyVerifier {
    app: AppHandle,
    channel: Channel<SshEvent>,
}

#[async_trait]
impl HostKeyVerifier for TauriHostKeyVerifier {
    async fn verify(&self, prompt: HostKeyPrompt) -> bool {
        let state = self.app.state::<SshState>();
        let request_id = state.next_request_id();
        let (tx, rx) = oneshot::channel();
        state
            .pending_host_key
            .lock()
            .await
            .insert(request_id.clone(), tx);

        let (status, stored_fingerprint) = match prompt.status {
            HostKeyStatus::Unknown => ("unknown", None),
            HostKeyStatus::Changed { stored_fingerprint } => ("changed", Some(stored_fingerprint)),
            HostKeyStatus::Trusted => ("unknown", None), // verify() is never called when already trusted
        };

        if self
            .channel
            .send(SshEvent::HostKeyPrompt {
                request_id: request_id.clone(),
                host: prompt.host,
                port: prompt.port,
                fingerprint: prompt.fingerprint,
                status: status.to_string(),
                stored_fingerprint,
            })
            .is_err()
        {
            return false;
        }

        // If the frontend/channel goes away without answering, fail closed.
        rx.await.unwrap_or(false)
    }
}

impl SshState {
    fn next_request_id(&self) -> String {
        format!("req-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    fn next_forward_id(&self) -> String {
        format!("fwd-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }
}

fn known_hosts_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("known_hosts"))
        .map_err(|e| e.to_string())
}

// The argument list is the IPC contract: `#[tauri::command]` deserialises
// each parameter by name from the invoke payload, so grouping them into a
// struct to satisfy the lint would change the shape the frontend has to send
// rather than simplify anything. Allowed here specifically, not workspace-wide.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    mut config: SshConfig,
    jump_profile_id: Option<String>,
    channel: Channel<SshEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    cols: u16,
    rows: u16,
    state: State<'_, SshState>,
    vault_state: State<'_, VaultState>,
) -> Result<String, String> {
    // A manual/one-off connection can still jump through a saved profile —
    // resolved here, same as ssh_connect_profile, so the jump host's
    // vault-stored credential never has to cross into the webview.
    if let Some(jump_id) = &jump_profile_id {
        let jump_profile = profiles::get_profile(&app, jump_id)?;
        let jump_config = build_ssh_config(&jump_profile, &vault_state).await?;
        config.jump = Some(Box::new(jump_config));
    }
    start_connection(app, config, channel, data_channel, cols, rows, &state).await
}

/// Connects using a saved session profile's vault-stored credential,
/// resolved entirely here — the frontend only ever sends a profile id, and
/// the decrypted secret never crosses back into the webview.
// The argument list is the IPC contract: `#[tauri::command]` deserialises
// each parameter by name from the invoke payload, so grouping them into a
// struct to satisfy the lint would change the shape the frontend has to send
// rather than simplify anything. Allowed here specifically, not workspace-wide.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_connect_profile(
    app: AppHandle,
    profile_id: String,
    channel: Channel<SshEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    cols: u16,
    rows: u16,
    state: State<'_, SshState>,
    vault_state: State<'_, VaultState>,
) -> Result<String, String> {
    let profile = profiles::get_profile(&app, &profile_id)?;
    let mut config = build_ssh_config(&profile, &vault_state).await?;

    if let Some(jump_id) = &profile.jump_profile_id {
        let jump_profile = profiles::get_profile(&app, jump_id)?;
        let jump_config = build_ssh_config(&jump_profile, &vault_state).await?;
        config.jump = Some(Box::new(jump_config));
    }

    start_connection(app, config, channel, data_channel, cols, rows, &state).await
}

/// Resolves `profile`'s own auth from the vault and builds a plain
/// (non-jumping) `SshConfig` for it — used both for the profile being
/// connected to and, if it names one, for its jump-host profile. A jump
/// profile's own `jump_profile_id`, if any, is ignored: only a single hop
/// is supported.
async fn build_ssh_config(
    profile: &profiles::SessionProfile,
    vault_state: &State<'_, VaultState>,
) -> Result<SshConfig, String> {
    let auth = resolve_auth(profile, vault_state).await?;
    Ok(SshConfig {
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        auth,
        jump: None,
        term_type: profile.term_type.clone(),
    })
}

async fn resolve_auth(
    profile: &profiles::SessionProfile,
    vault_state: &State<'_, VaultState>,
) -> Result<AuthMethod, String> {
    // Handled before the vault is touched: the agent holds the key itself, so
    // there is no stored secret to resolve and no reason to make a locked
    // vault block a connection that doesn't need one.
    if profile.auth_type == "agent" {
        return Ok(AuthMethod::Agent);
    }

    let guard = vault_state.vault.lock().await;
    let vault = guard.as_ref().ok_or("vault is locked")?;

    match profile.auth_type.as_str() {
        "password" => match vault.get(&profile.id) {
            Some(VaultSecret::Password { password }) => Ok(AuthMethod::Password {
                password: password.clone(),
            }),
            _ => Err(
                "no saved password for this session — connect manually once and save the credential"
                    .to_string(),
            ),
        },
        "public_key" => match &profile.key_path {
            Some(key_path) => {
                let passphrase = match vault.get(&profile.id) {
                    Some(VaultSecret::Passphrase { passphrase }) => Some(passphrase.clone()),
                    _ => None,
                };
                Ok(AuthMethod::PublicKey {
                    key_path: key_path.clone(),
                    passphrase,
                })
            }
            // No path means the key itself lives in the vault instead.
            None => match vault.get(&profile.id) {
                Some(VaultSecret::PrivateKey {
                    key_material,
                    passphrase,
                }) => Ok(AuthMethod::PublicKeyMaterial {
                    key_material: key_material.clone(),
                    passphrase: passphrase.clone(),
                }),
                _ => Err(
                    "session's key is stored in the vault, but none was found — re-import it by editing the session"
                        .to_string(),
                ),
            },
        },
        other => Err(format!("unknown auth type: {other}")),
    }
}

async fn start_connection(
    app: AppHandle,
    config: SshConfig,
    channel: Channel<SshEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    cols: u16,
    rows: u16,
    state: &State<'_, SshState>,
) -> Result<String, String> {
    let session_id = state.sessions.next_session_id();
    let known_hosts = known_hosts_path(&app)?;
    let verifier = Arc::new(TauriHostKeyVerifier {
        app: app.clone(),
        channel: channel.clone(),
    });

    let connector =
        SshConnector::new(config, known_hosts, verifier, cols, rows).map_err(|e| e.to_string())?;

    state
        .sessions
        .spawn_connect(
            app,
            session_id.clone(),
            connector,
            channel,
            data_channel,
            |status| SshEvent::Status {
                status: status_label(status),
            },
        )
        .await;

    Ok(session_id)
}

#[tauri::command]
pub async fn ssh_write(
    session_id: String,
    data: Vec<u8>,
    state: State<'_, SshState>,
) -> Result<(), String> {
    state.sessions.write(&session_id, &data).await
}

#[tauri::command]
pub async fn ssh_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, SshState>,
) -> Result<(), String> {
    state.sessions.resize(&session_id, cols, rows).await
}

#[tauri::command]
pub async fn ssh_disconnect(
    session_id: String,
    state: State<'_, SshState>,
    sftp_state: State<'_, crate::sftp::SftpState>,
) -> Result<(), String> {
    state.sessions.disconnect(&session_id).await?;

    // Unlike the SFTP equivalent this can't collapse to a single `retain`:
    // `stop()` is async and can't run under the lock. So it removes the
    // entries in one pass and stops them afterwards, rather than re-acquiring
    // the lock once per forward as it used to.
    let stale: Vec<_> = {
        let mut forwards = state.forwards.lock().await;
        let ids: Vec<String> = forwards
            .iter()
            .filter(|(_, (owner, _))| *owner == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| forwards.remove(&id).map(|(_, handle)| handle))
            .collect()
    };
    for handle in stale {
        let _ = handle.stop().await;
    }

    crate::sftp::stop_watching_session(&sftp_state, &session_id).await;

    Ok(())
}

/// Non-loopback binds (`0.0.0.0`, a LAN IP, ...) expose the forward beyond
/// this machine — for `Dynamic` that's an unauthenticated SOCKS5 proxy onto
/// whatever the SSH server can reach. Recognized by the frontend to prompt
/// for confirmation before retrying with `confirmed: true` — checked here
/// too regardless, since this is the actual enforcement point, not just a
/// UI speed bump.
pub const NON_LOOPBACK_BIND_ERROR: &str = "non-loopback bind host requires confirmation";

/// Starts a local, remote, or dynamic (SOCKS5) port forward on an active
/// session. Returns a forward id used to stop it later.
#[tauri::command]
pub async fn ssh_add_forward(
    session_id: String,
    spec: ForwardSpec,
    confirmed: bool,
    state: State<'_, SshState>,
) -> Result<String, String> {
    if !confirmed && !wr_ssh::is_loopback_bind_host(spec.bind_host()) {
        return Err(NON_LOOPBACK_BIND_ERROR.to_string());
    }
    let session = lookup(&state, &session_id).await?;
    let forward = session
        .lock()
        .await
        .ready()?
        .add_forward(spec)
        .await
        .map_err(|e| e.to_string())?;
    let forward_id = state.next_forward_id();
    state
        .forwards
        .lock()
        .await
        .insert(forward_id.clone(), (session_id, forward));
    Ok(forward_id)
}

#[tauri::command]
pub async fn ssh_remove_forward(
    forward_id: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let entry = state.forwards.lock().await.remove(&forward_id);
    if let Some((_, handle)) = entry {
        handle.stop().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_respond_host_key(
    request_id: String,
    accept: bool,
    state: State<'_, SshState>,
) -> Result<(), String> {
    if let Some(tx) = state.pending_host_key.lock().await.remove(&request_id) {
        let _ = tx.send(accept);
    }
    Ok(())
}

/// `pub(crate)` so the `sftp` module can look up the SSH session an SFTP
/// operation piggybacks on, without exposing `SshState`'s session map itself.
/// Kept as a free function because `sftp.rs` reaches for a live SSH session
/// to open its subsystem channel on, and shouldn't have to know that the
/// registry is where sessions live.
pub(crate) async fn lookup(
    state: &State<'_, SshState>,
    session_id: &str,
) -> Result<Arc<TokioMutex<Slot<SshSession>>>, String> {
    state.sessions.lookup(session_id).await
}
