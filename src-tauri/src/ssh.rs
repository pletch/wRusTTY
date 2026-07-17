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
use wr_core::{Connection, ConnectionEvent};
use wr_ssh::{
    AuthMethod, ForwardHandle, ForwardSpec, HostKeyPrompt, HostKeyStatus, HostKeyVerifier,
    SshConfig, SshSession,
};
use wr_vault::VaultSecret;

use crate::connection_status::status_label;
use crate::profiles;
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
    },
}

#[derive(Default)]
pub struct SshState {
    sessions: TokioMutex<HashMap<String, Arc<TokioMutex<SshSession>>>>,
    pending_host_key: TokioMutex<HashMap<String, oneshot::Sender<bool>>>,
    /// Keyed by forward id; each entry also remembers its owning session id
    /// so `ssh_disconnect` can stop every forward that session opened.
    forwards: TokioMutex<HashMap<String, (String, ForwardHandle)>>,
    next_id: AtomicU64,
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

        let status = match prompt.status {
            HostKeyStatus::Unknown => "unknown",
            HostKeyStatus::Changed { .. } => "changed",
            HostKeyStatus::Trusted => "unknown", // verify() is never called when already trusted
        };

        if self
            .channel
            .send(SshEvent::HostKeyPrompt {
                request_id: request_id.clone(),
                host: prompt.host,
                port: prompt.port,
                fingerprint: prompt.fingerprint,
                status: status.to_string(),
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

    fn next_session_id(&self) -> String {
        format!("ssh-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
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

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    config: SshConfig,
    channel: Channel<SshEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    state: State<'_, SshState>,
) -> Result<String, String> {
    start_connection(app, config, channel, data_channel, &state).await
}

/// Connects using a saved session profile's vault-stored credential,
/// resolved entirely here — the frontend only ever sends a profile id, and
/// the decrypted secret never crosses back into the webview.
#[tauri::command]
pub async fn ssh_connect_profile(
    app: AppHandle,
    profile_id: String,
    channel: Channel<SshEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    state: State<'_, SshState>,
    vault_state: State<'_, VaultState>,
) -> Result<String, String> {
    let profile = profiles::get_profile(&app, &profile_id)?;
    let auth = resolve_auth(&profile, &vault_state).await?;
    let config = SshConfig {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        auth,
    };
    start_connection(app, config, channel, data_channel, &state).await
}

async fn resolve_auth(
    profile: &profiles::SessionProfile,
    vault_state: &State<'_, VaultState>,
) -> Result<AuthMethod, String> {
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
    state: &State<'_, SshState>,
) -> Result<String, String> {
    let session_id = state.next_session_id();
    let known_hosts = known_hosts_path(&app)?;
    let verifier = Arc::new(TauriHostKeyVerifier {
        app: app.clone(),
        channel: channel.clone(),
    });

    let session = SshSession::new(config, known_hosts, verifier).map_err(|e| e.to_string())?;
    let session = Arc::new(TokioMutex::new(session));

    state
        .sessions
        .lock()
        .await
        .insert(session_id.clone(), session.clone());

    let cleanup_session_id = session_id.clone();

    tokio::spawn(async move {
        let (tx, rx) = tokio::sync::mpsc::channel::<ConnectionEvent>(
            crate::coalesce::CONNECTION_EVENT_CHANNEL_BOUND,
        );

        let forward = tokio::spawn(crate::coalesce::forward_coalesced(
            rx,
            channel,
            data_channel,
            |status| SshEvent::Status {
                status: status_label(status),
            },
        ));

        let connect_result = session.lock().await.connect(tx).await;
        if connect_result.is_err() {
            let ssh_state = app.state::<SshState>();
            ssh_state.sessions.lock().await.remove(&cleanup_session_id);
        }

        // Once connect() returns, the session's own output-pump task keeps
        // running independently (spawned inside wr_ssh); this task's only
        // job was driving the handshake and forwarding events, so let the
        // forwarder finish draining whatever's left in the channel.
        drop(forward);
    });

    Ok(session_id)
}

#[tauri::command]
pub async fn ssh_write(
    session_id: String,
    data: Vec<u8>,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let session = lookup(&state, &session_id).await?;
    let mut session = session.lock().await;
    session.write(&data).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let session = lookup(&state, &session_id).await?;
    let mut session = session.lock().await;
    session.resize(cols, rows).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_disconnect(
    session_id: String,
    state: State<'_, SshState>,
    sftp_state: State<'_, crate::sftp::SftpState>,
) -> Result<(), String> {
    let session = state.sessions.lock().await.remove(&session_id);
    if let Some(session) = session {
        session
            .lock()
            .await
            .disconnect()
            .await
            .map_err(|e| e.to_string())?;
    }

    let stale: Vec<String> = {
        let forwards = state.forwards.lock().await;
        forwards
            .iter()
            .filter(|(_, (owner, _))| *owner == session_id)
            .map(|(id, _)| id.clone())
            .collect()
    };
    for forward_id in stale {
        if let Some((_, handle)) = state.forwards.lock().await.remove(&forward_id) {
            let _ = handle.stop().await;
        }
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
pub(crate) async fn lookup(
    state: &State<'_, SshState>,
    session_id: &str,
) -> Result<Arc<TokioMutex<SshSession>>, String> {
    state
        .sessions
        .lock()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("no such session: {session_id}"))
}
