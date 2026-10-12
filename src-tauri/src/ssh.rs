//! Tauri command layer for SSH sessions: connecting (one-off or from a saved
//! profile), host-key and keyboard-interactive prompts relayed to the frontend
//! through pending-request maps, and port forwards.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, Mutex as TokioMutex};
use wr_ssh::{
    AuthMethod, AuthPrompt, AuthPrompter, ForwardHandle, ForwardSpec, HostKeyPrompt, HostKeyStatus,
    HostKeyVerifier, SshConfig, SshConnector, SshSession,
};
use wr_vault::VaultSecret;
use zeroize::Zeroizing;

use crate::connection_status::status_label;
use crate::profiles;
use crate::session_registry::{ReconnectPolicy, SessionRegistry, Slot, TransportPhase};
use crate::vault::VaultState;
use crate::wake::WakeOnLan;

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SshEvent {
    // PTY output travels on its own raw-bytes channel (see coalesce.rs).
    Status {
        status: String,
    },
    HostKeyPrompt {
        request_id: String,
        host: String,
        port: u16,
        fingerprint: String,
        /// "unknown" (first connection), "changed" (possible MITM or reprovision),
        /// or "newKeyType" (a known host offering a key type we hold no pin for;
        /// see `HostKeyStatus::NewKeyType`). Worded very differently in the UI.
        status: String,
        /// For "changed": the fingerprint on record, for comparison.
        stored_fingerprint: Option<String>,
        /// For "newKeyType": every key on record for this host, as
        /// `algorithm fingerprint`.
        known_keys: Vec<String>,
    },
    /// One round of keyboard-interactive auth, answered by
    /// `ssh_respond_auth_prompt`.
    AuthPrompt {
        request_id: String,
        /// The server's title and preamble; often empty.
        name: String,
        instructions: String,
        /// What to ask, in order; responses come back in the same order.
        fields: Vec<AuthPromptFieldPayload>,
        /// Which host is asking. A jumped connection authenticates twice with
        /// similar prompts, so the UI names the host.
        host: String,
        port: u16,
        is_jump: bool,
    },
}

/// One field of an [`SshEvent::AuthPrompt`].
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptFieldPayload {
    /// The server's wording, shown verbatim.
    prompt: String,
    /// False means a secret; the field is masked.
    echo: bool,
}

/// Prompts waiting on an answer, by request id, with the owning session id so
/// closing a pane can answer (and unpark) its own prompts.
type PendingMap<T> = TokioMutex<HashMap<String, (String, oneshot::Sender<T>)>>;

/// SSH's prompt and forward maps live alongside the shared registry, since no
/// other transport has them.
pub struct SshState {
    sessions: SessionRegistry<SshConnector>,
    /// Outstanding host-key prompts. `false` rejects.
    pending_host_key: PendingMap<bool>,
    /// Outstanding keyboard-interactive prompts. `None` cancels; otherwise one
    /// response per field of the prompt, in order.
    pending_auth: PendingMap<Option<Zeroizing<Vec<String>>>>,
    /// By forward id; see [`Forward`].
    forwards: TokioMutex<HashMap<String, Forward>>,
    /// Counter for request and forward ids.
    next_id: AtomicU64,
}

/// One port forward, live or not. The spec is kept so the forward can be
/// re-opened after a reconnect (a `ForwardHandle` dies with its connection),
/// and this map is the single answer to "what is this session forwarding".
struct Forward {
    /// The session that opened it, so `ssh_disconnect` can stop it.
    session_id: String,
    spec: ForwardSpec,
    /// The port actually bound. Differs from `spec` when it asked for 0 ("any",
    /// which an empty port field produces); re-opening must reuse this port.
    bound_port: Option<u16>,
    /// The running forward, kept even while its connection is dead: dropping it
    /// leaks the listener, and stopping it would free the port for something
    /// else before the reconnect can rebind.
    handle: Option<ForwardHandle>,
    /// Whether the connection behind the forward is alive. Not derived from
    /// `handle`, which is still held during an outage.
    live: bool,
    /// Set while a re-establish is in flight, so a retry and a restore can't
    /// both work on one entry.
    reestablishing: bool,
    /// Why it's down, verbatim (usually "the local port is taken").
    error: Option<String>,
}

impl Forward {
    /// The spec to re-open with: the bound port substituted when it asked for
    /// "any".
    fn spec_to_open(&self) -> ForwardSpec {
        let Some(bound) = self.bound_port else {
            return self.spec.clone();
        };
        let mut spec = self.spec.clone();
        match &mut spec {
            ForwardSpec::Local { bind_port, .. }
            | ForwardSpec::Remote { bind_port, .. }
            | ForwardSpec::Dynamic { bind_port, .. } => {
                if *bind_port == 0 {
                    *bind_port = bound;
                }
            }
        }
        spec
    }
}

/// The frontend's view of a [`Forward`]. `spec` carries the bound port, so a
/// forward opened on "any" shows its real port rather than `:0`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    id: String,
    spec: ForwardSpec,
    active: bool,
    error: Option<String>,
}

/// Emitted after forwards change across a reconnect. Status events can't serve:
/// `Connected` is emitted inside `SshConnector::connect`, before `supervise`
/// publishes the session and the restore runs (and `Lost` races similarly).
const FORWARDS_CHANGED_EVENT: &str = "ssh-forwards-changed";

impl Default for SshState {
    fn default() -> Self {
        Self {
            sessions: SessionRegistry::new("ssh"),
            pending_host_key: TokioMutex::default(),
            pending_auth: TokioMutex::default(),
            forwards: TokioMutex::default(),
            next_id: AtomicU64::new(0),
        }
    }
}

struct TauriHostKeyVerifier {
    app: AppHandle,
    channel: Channel<SshEvent>,
    /// The session this prompt belongs to, so `ssh_disconnect` can answer it.
    session_id: String,
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
            .insert(request_id.clone(), (self.session_id.clone(), tx));

        let (status, stored_fingerprint, known_keys) = match prompt.status {
            HostKeyStatus::Unknown => ("unknown", None, Vec::new()),
            HostKeyStatus::Changed { stored_fingerprint } => {
                ("changed", Some(stored_fingerprint), Vec::new())
            }
            HostKeyStatus::NewKeyType { known } => ("newKeyType", None, known),
            // verify() isn't called for a trusted key.
            HostKeyStatus::Trusted => ("unknown", None, Vec::new()),
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
                known_keys,
            })
            .is_err()
        {
            return false;
        }

        // Fail closed if nothing answers.
        rx.await.unwrap_or(false)
    }
}

/// Relays the server's keyboard-interactive questions to the connecting pane.
/// Same shape as `TauriHostKeyVerifier`; fails closed if the webview goes away.
struct TauriAuthPrompter {
    app: AppHandle,
    channel: Channel<SshEvent>,
    session_id: String,
}

#[async_trait]
impl AuthPrompter for TauriAuthPrompter {
    async fn prompt(&self, prompt: AuthPrompt) -> Option<Zeroizing<Vec<String>>> {
        let state = self.app.state::<SshState>();
        let request_id = state.next_request_id();
        let (tx, rx) = oneshot::channel();
        state
            .pending_auth
            .lock()
            .await
            .insert(request_id.clone(), (self.session_id.clone(), tx));

        if self
            .channel
            .send(SshEvent::AuthPrompt {
                request_id: request_id.clone(),
                name: prompt.name,
                instructions: prompt.instructions,
                fields: prompt
                    .fields
                    .into_iter()
                    .map(|f| AuthPromptFieldPayload {
                        prompt: f.prompt,
                        echo: f.echo,
                    })
                    .collect(),
                host: prompt.host,
                port: prompt.port,
                is_jump: prompt.is_jump,
            })
            .is_err()
        {
            // Nothing can answer; don't leave the entry behind.
            state.pending_auth.lock().await.remove(&request_id);
            return None;
        }

        // A dropped sender is a cancel, which abandons the connection.
        rx.await.ok().flatten()
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

// Command arguments are the IPC contract, deserialized by name.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    mut config: SshConfig,
    jump_profile_id: Option<String>,
    wake: Option<WakeOnLan>,
    // The global proxy setting, already resolved against the form's checkbox.
    proxy: Option<wr_ssh::ProxyConfig>,
    channel: Channel<SshEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    cols: u16,
    rows: u16,
    reconnect_policy: Option<ReconnectPolicy>,
    state: State<'_, SshState>,
    vault_state: State<'_, VaultState>,
) -> Result<String, String> {
    config.proxy = proxy;
    // A one-off connection can still jump through a saved profile, resolved
    // here so the jump credential never reaches the webview.
    if let Some(jump_id) = &jump_profile_id {
        let jump_profile = profiles::get_profile(&app, jump_id)?;
        let jump_config = build_ssh_config(&jump_profile, &vault_state).await?;
        config.jump = Some(Box::new(jump_config));
    }

    // With no profile to re-resolve from, reconnecting means keeping this
    // config, so only allow it when the config holds no secret.
    let reconnect = keeps_no_secret(&config).then(|| {
        let config = config.clone();
        move || {
            let config = config.clone();
            async move { Ok(config) }
        }
    });

    start_connection(
        app,
        config,
        wake,
        channel,
        data_channel,
        cols,
        rows,
        &state,
        reconnect,
        reconnect_policy.unwrap_or_default().sanitized(),
    )
    .await
}

/// Whether a config can be kept for the session's life without holding a
/// secret: agent auth, or a key path with no passphrase, on every hop.
fn keeps_no_secret(config: &SshConfig) -> bool {
    fn hop(auth: &AuthMethod) -> bool {
        match auth {
            AuthMethod::Agent => true,
            AuthMethod::PublicKey { passphrase, .. } => passphrase.is_none(),
            AuthMethod::Password { .. }
            | AuthMethod::PublicKeyMaterial { .. }
            | AuthMethod::KeyboardInteractive => false,
        }
    }
    // `is_none_or` postdates the MSRV.
    hop(&config.auth) && config.jump.as_ref().map_or(true, |jump| hop(&jump.auth))
}

/// Connects using a saved profile; the credential is resolved here from the
/// vault and never crosses into the webview.
// Command arguments are the IPC contract, deserialized by name.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_connect_profile(
    app: AppHandle,
    profile_id: String,
    // The global proxy setting; the profile's opt-out is applied in
    // `resolve_profile_config`.
    proxy: Option<wr_ssh::ProxyConfig>,
    channel: Channel<SshEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    cols: u16,
    rows: u16,
    reconnect_policy: Option<ReconnectPolicy>,
    state: State<'_, SshState>,
    vault_state: State<'_, VaultState>,
) -> Result<String, String> {
    let profile = profiles::get_profile(&app, &profile_id)?;
    let config = resolve_profile_config(&app, &profile_id, &vault_state, proxy.clone()).await?;

    // A reconnect authenticates both hops, so both must be unattended.
    let jump_asks = match &profile.jump_profile_id {
        Some(jump_id) => !reconnects_unattended(&profiles::get_profile(&app, jump_id)?),
        None => false,
    };
    let reconnect = (reconnects_unattended(&profile) && !jump_asks).then(|| {
        let app = app.clone();
        let profile_id = profile_id.clone();
        move || {
            let app = app.clone();
            let profile_id = profile_id.clone();
            let proxy = proxy.clone();
            // Each attempt re-resolves from the vault, so secrets aren't held and
            // profile edits take effect. A locked vault fails the attempt and the run
            // keeps trying.
            async move {
                let vault_state = app.state::<VaultState>();
                resolve_profile_config(&app, &profile_id, &vault_state, proxy).await
            }
        }
    });

    start_connection(
        app,
        config,
        profile.wake_on_lan,
        channel,
        data_channel,
        cols,
        rows,
        &state,
        reconnect,
        reconnect_policy.unwrap_or_default().sanitized(),
    )
    .await
}

/// A saved profile's full `SshConfig` (jump hop included), resolved from the
/// vault now. Re-run per reconnect attempt.
async fn resolve_profile_config(
    app: &AppHandle,
    profile_id: &str,
    vault_state: &VaultState,
    proxy: Option<wr_ssh::ProxyConfig>,
) -> Result<SshConfig, String> {
    let profile = profiles::get_profile(app, profile_id)?;
    let mut config = build_ssh_config(&profile, vault_state).await?;
    // Opt-out only: a profile can decline the global proxy.
    config.proxy = if profile.use_proxy == Some(false) {
        None
    } else {
        proxy
    };

    if let Some(jump_id) = &profile.jump_profile_id {
        let jump_profile = profiles::get_profile(app, jump_id)?;
        let jump_config = build_ssh_config(&jump_profile, vault_state).await?;
        config.jump = Some(Box::new(jump_config));
    }
    Ok(config)
}

/// Builds a single-hop `SshConfig` for `profile` from the vault. Used for the
/// target and its jump host; a jump profile's own jump is ignored.
async fn build_ssh_config(
    profile: &profiles::SessionProfile,
    vault_state: &VaultState,
) -> Result<SshConfig, String> {
    let auth = resolve_auth(profile, vault_state).await?;
    Ok(SshConfig {
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        auth,
        jump: None,
        term_type: profile.term_type.clone(),
        keepalive_seconds: profile.keepalive_seconds,
        // Set by the caller: only the first hop goes through the proxy.
        proxy: None,
    })
}

/// Whether a profile's credential can be produced again unattended. Everything
/// but `keyboard_interactive`, which has nothing stored and must never prompt
/// on its own after a link flaps; those panes keep the manual Reconnect button.
fn reconnects_unattended(profile: &profiles::SessionProfile) -> bool {
    profile.auth_type != "keyboard_interactive"
}

async fn resolve_auth(
    profile: &profiles::SessionProfile,
    vault_state: &VaultState,
) -> Result<AuthMethod, String> {
    // Agent and keyboard-interactive need no stored secret, so a locked vault
    // mustn't block them. `authNeedsVault` in lib/profiles.ts mirrors this.
    if profile.auth_type == "agent" {
        return Ok(AuthMethod::Agent);
    }
    if profile.auth_type == "keyboard_interactive" {
        return Ok(AuthMethod::KeyboardInteractive);
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
            // No path: the key itself is in the vault.
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

/// Builds a connector for one attempt. The verifier and prompter keep the same
/// session id across reconnects so `ssh_disconnect` can answer a prompt a
/// retry is parked on.
fn build_connector(
    app: &AppHandle,
    session_id: &str,
    channel: &Channel<SshEvent>,
    config: SshConfig,
    cols: u16,
    rows: u16,
) -> Result<SshConnector, String> {
    let known_hosts = known_hosts_path(app)?;
    let verifier = Arc::new(TauriHostKeyVerifier {
        app: app.clone(),
        channel: channel.clone(),
        session_id: session_id.to_string(),
    });
    let prompter = Arc::new(TauriAuthPrompter {
        app: app.clone(),
        channel: channel.clone(),
        session_id: session_id.to_string(),
    });
    SshConnector::new(config, known_hosts, verifier, prompter, cols, rows)
        .map_err(|e| e.to_string())
}

// Mirrors the two commands' arguments.
#[allow(clippy::too_many_arguments)]
async fn start_connection<MakeCfg, Fut>(
    app: AppHandle,
    config: SshConfig,
    wake: Option<WakeOnLan>,
    channel: Channel<SshEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    cols: u16,
    rows: u16,
    state: &State<'_, SshState>,
    // A fresh config for each reconnect attempt, or `None` to opt out.
    // Re-resolved rather than retained so credentials aren't kept alive for
    // the session's whole life (`AuthMethod` is `ZeroizeOnDrop` for this).
    reconnect_config: Option<MakeCfg>,
    policy: ReconnectPolicy,
) -> Result<String, String>
where
    MakeCfg: Fn() -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<SshConfig, String>> + Send,
{
    let session_id = state.sessions.next_session_id();

    // A magic packet only reaches the local segment, never a host behind a
    // jump. Skip it rather than wait on a host we can't route to.
    let wake = match wake {
        Some(_) if config.jump.is_some() => {
            log::warn!(
                "not waking {}: a magic packet can't reach a host behind a jump host",
                config.host
            );
            None
        }
        // Likewise behind a proxy.
        Some(_) if config.proxy.is_some() => {
            log::warn!(
                "not waking {}: a magic packet can't reach a host behind a proxy",
                config.host
            );
            None
        }
        wake => wake,
    };

    // The probe knocks on the same endpoint as the handshake.
    let target = wake.map(|wake| (config.host.clone(), config.port, wake));

    let connector = build_connector(&app, &session_id, &channel, config, cols, rows)?;

    let reconnect = reconnect_config.map(|resolve| {
        let app = app.clone();
        let channel = channel.clone();
        let session_id = session_id.clone();
        move || {
            let app = app.clone();
            let channel = channel.clone();
            let session_id = session_id.clone();
            let config = resolve();
            async move {
                let config = config.await?;
                build_connector(&app, &session_id, &channel, config, cols, rows)
            }
        }
    });

    // Every SSH session gets this, so forwards are marked dead on `Lost` even
    // when no reconnect follows.
    let on_transport = {
        let app = app.clone();
        let session_id = session_id.clone();
        move |phase| {
            let app = app.clone();
            let session_id = session_id.clone();
            async move { on_transport_phase(&app, &session_id, phase).await }
        }
    };

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
            target.map(|(host, port, wake)| {
                move |events| async move {
                    crate::wake::wake_and_wait(&host, port, &wake, &events).await
                }
            }),
            reconnect,
            Some(on_transport),
            policy,
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
    logging: State<'_, crate::logging::LoggingState>,
) -> Result<(), String> {
    // Logged before applying, so output after the marker is at the new size.
    crate::logging::note_resize(&logging, &session_id, cols, rows);
    state.sessions.resize(&session_id, cols, rows).await
}

#[tauri::command]
pub async fn ssh_disconnect(
    session_id: String,
    state: State<'_, SshState>,
    sftp_state: State<'_, crate::sftp::SftpState>,
) -> Result<(), String> {
    // First, answer any prompt this session is parked on (closing a pane is
    // how users decline), so the handshake fails and unwinds.
    for tx in take_pending(&state.pending_host_key, &session_id).await {
        let _ = tx.send(false);
    }
    for tx in take_pending(&state.pending_auth, &session_id).await {
        let _ = tx.send(None);
    }

    state.sessions.disconnect(&session_id).await?;

    // `stop()` is async, so remove under the lock and stop afterward.
    let stale: Vec<_> = {
        let mut forwards = state.forwards.lock().await;
        let ids: Vec<String> = forwards
            .iter()
            .filter(|(_, forward)| forward.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| forwards.remove(&id).and_then(|forward| forward.handle))
            .collect()
    };
    for handle in stale {
        let _ = handle.stop().await;
    }

    crate::sftp::stop_watching_session(&sftp_state, &session_id).await;
    // Nothing else would remove them.
    crate::sftp::forget_interrupted_transfers(&sftp_state, &session_id).await;

    Ok(())
}

/// Non-loopback binds expose the forward beyond this machine (for `Dynamic`, an
/// unauthenticated SOCKS5 proxy). The frontend confirms and retries with
/// `confirmed: true`; enforced here regardless.
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
    let handle = open_forward(&state, &session_id, spec.clone()).await?;
    let forward_id = state.next_forward_id();
    state.forwards.lock().await.insert(
        forward_id.clone(),
        Forward {
            session_id,
            spec,
            bound_port: Some(handle.bound_port()),
            handle: Some(handle),
            live: true,
            reestablishing: false,
            error: None,
        },
    );
    Ok(forward_id)
}

/// Starts one forward on whatever connection `session_id` holds now (it changes
/// across reconnects). Used for adding, retrying and restoring.
async fn open_forward(
    state: &State<'_, SshState>,
    session_id: &str,
    spec: ForwardSpec,
) -> Result<ForwardHandle, String> {
    let session = lookup(state, session_id).await?;
    let handle = session
        .lock()
        .await
        .ready()?
        .add_forward(spec)
        .await
        .map_err(|e| e.to_string())?;
    Ok(handle)
}

#[tauri::command]
pub async fn ssh_remove_forward(
    forward_id: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let entry = state.forwards.lock().await.remove(&forward_id);
    // `None` when already down: just dismiss the row.
    if let Some(handle) = entry.and_then(|forward| forward.handle) {
        handle.stop().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Every forward this session has, live or down. The backend owns this list,
/// so forwards stay visible after the panel closes.
#[tauri::command]
pub async fn ssh_list_forwards(
    session_id: String,
    state: State<'_, SshState>,
) -> Result<Vec<ForwardInfo>, String> {
    let forwards = state.forwards.lock().await;
    let mut list: Vec<ForwardInfo> = forwards
        .iter()
        .filter(|(_, forward)| forward.session_id == session_id)
        .map(|(id, forward)| ForwardInfo {
            id: id.clone(),
            spec: forward.spec_to_open(),
            active: forward.live,
            error: forward.error.clone(),
        })
        .collect();
    // Ids only increase, so this is insertion order.
    list.sort_by_key(|info| forward_sequence(&info.id));
    Ok(list)
}

/// The number in a `fwd-N` id, for ordering; unparseable sorts first.
fn forward_sequence(id: &str) -> u64 {
    id.rsplit_once('-')
        .and_then(|(_, n)| n.parse().ok())
        .unwrap_or(0)
}

/// Retries a forward that's down, against the current connection. Typically
/// the local port was taken during the outage; the user fixes that and retries.
#[tauri::command]
pub async fn ssh_retry_forward(
    forward_id: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    reestablish(&state, &forward_id).await
}

/// Re-opens one forward, replacing whatever handle it holds, and records the
/// outcome on the entry either way.
async fn reestablish(state: &State<'_, SshState>, forward_id: &str) -> Result<(), String> {
    let claimed = {
        let mut forwards = state.forwards.lock().await;
        match forwards.get_mut(forward_id) {
            None => None,
            // Claimed under the lock, so only one caller owns the entry.
            Some(forward) if forward.reestablishing => {
                return Err("this forward is already being re-established".to_string())
            }
            Some(forward) => {
                forward.reestablishing = true;
                Some((
                    forward.session_id.clone(),
                    forward.spec_to_open(),
                    forward.handle.take(),
                ))
            }
        }
    };
    let Some((session_id, spec, old)) = claimed else {
        // Stopped meanwhile; don't resurrect it.
        return Ok(());
    };

    // Stop before rebinding: the old listener owns the port until it stops.
    // Errors are expected (a remote forward's cancel goes to the dead
    // connection).
    if let Some(old) = old {
        let _ = old.stop().await;
    }

    let result = open_forward(state, &session_id, spec).await;

    let mut forwards = state.forwards.lock().await;
    let Some(entry) = forwards.get_mut(forward_id) else {
        // Stopped while opening; close the orphaned handle.
        drop(forwards);
        if let Ok(handle) = result {
            let _ = handle.stop().await;
        }
        return Ok(());
    };
    entry.reestablishing = false;
    match result {
        Ok(handle) => {
            entry.bound_port = Some(handle.bound_port());
            entry.handle = Some(handle);
            entry.live = true;
            entry.error = None;
            Ok(())
        }
        Err(message) => {
            entry.live = false;
            entry.error = Some(message.clone());
            Err(message)
        }
    }
}

/// Marks every forward on `session_id` as down, keeping each handle so its
/// listener holds the port during the outage (see `Forward::handle`).
async fn mark_lost(state: &State<'_, SshState>, session_id: &str) {
    let mut forwards = state.forwards.lock().await;
    for forward in forwards.values_mut() {
        if forward.session_id == session_id {
            forward.live = false;
            // Earlier errors describe a connection that's gone anyway.
            forward.error = Some("connection lost".to_string());
        }
    }
}

/// Run from the registry's `on_transport` hook: marks forwards dead and
/// interrupts transfers on `Lost`, restores both on `Restored`, then emits
/// [`FORWARDS_CHANGED_EVENT`].
pub(crate) async fn on_transport_phase(app: &AppHandle, session_id: &str, phase: TransportPhase) {
    let state = app.state::<SshState>();
    match phase {
        TransportPhase::Lost => {
            mark_lost(&state, session_id).await;
            // Races the transfer's own teardown, so run it promptly.
            crate::sftp::interrupt_session_transfers(app, session_id).await;
        }
        TransportPhase::Restored => {
            restore_forwards(&state, session_id).await;
            crate::sftp::resume_session_transfers(app, session_id).await;
        }
    }
    // The id, so a panel can ignore other panes' sessions.
    let _ = app.emit(FORWARDS_CHANGED_EVENT, session_id.to_string());
}

/// Re-establishes every forward on `session_id` against the new connection,
/// one at a time in list order.
async fn restore_forwards(state: &State<'_, SshState>, session_id: &str) {
    let ids: Vec<String> = {
        let forwards = state.forwards.lock().await;
        let mut ids: Vec<String> = forwards
            .iter()
            .filter(|(_, forward)| forward.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort_by_key(|id| forward_sequence(id));
        ids
    };
    for id in ids {
        if let Err(message) = reestablish(state, &id).await {
            // Recorded on the entry; also logged since the panel may be closed.
            log::warn!("could not re-establish forward {id} after reconnect: {message}");
        }
    }
}

#[tauri::command]
pub async fn ssh_respond_host_key(
    request_id: String,
    accept: bool,
    state: State<'_, SshState>,
) -> Result<(), String> {
    if let Some((_, tx)) = state.pending_host_key.lock().await.remove(&request_id) {
        let _ = tx.send(accept);
    }
    Ok(())
}

/// Answers one round of keyboard-interactive auth: one response per field, in
/// order. `None` cancels (abandoning the connection rather than sending blanks
/// that count as a failure). Responses are zeroized and never logged or
/// stored.
#[tauri::command]
pub async fn ssh_respond_auth_prompt(
    request_id: String,
    responses: Option<Vec<String>>,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let responses = responses.map(Zeroizing::new);
    if let Some((_, tx)) = state.pending_auth.lock().await.remove(&request_id) {
        let _ = tx.send(responses);
    }
    Ok(())
}

/// Removes every prompt `session_id` owns from a pending map, returning the
/// senders to answer outside the lock.
async fn take_pending<T>(map: &PendingMap<T>, session_id: &str) -> Vec<oneshot::Sender<T>> {
    let mut pending = map.lock().await;
    let ids: Vec<String> = pending
        .iter()
        .filter(|(_, (owner, _))| owner == session_id)
        .map(|(id, _)| id.clone())
        .collect();
    ids.into_iter()
        .filter_map(|id| pending.remove(&id).map(|(_, tx)| tx))
        .collect()
}

/// Every trusted host key, loaded from the file on each call so there's no
/// long-lived copy to drift.
#[tauri::command]
pub async fn ssh_list_known_hosts(app: AppHandle) -> Result<Vec<wr_ssh::KnownHostEntry>, String> {
    let path = known_hosts_path(&app)?;
    Ok(wr_ssh::KnownHostsStore::load(path)
        .map_err(|e| e.to_string())?
        .list())
}

/// Forgets one stored host key, by its exact stored line (an unparseable entry
/// has no fingerprint, and those most need removing).
#[tauri::command]
pub async fn ssh_forget_host_key(
    app: AppHandle,
    host: String,
    port: u16,
    key_text: String,
) -> Result<bool, String> {
    let path = known_hosts_path(&app)?;
    wr_ssh::KnownHostsStore::load(path)
        .map_err(|e| e.to_string())?
        .forget(&host, port, &key_text)
        .map_err(|e| e.to_string())
}

/// Forgets every key held for one host, returning how many there were.
#[tauri::command]
pub async fn ssh_forget_host(app: AppHandle, host: String, port: u16) -> Result<usize, String> {
    let path = known_hosts_path(&app)?;
    wr_ssh::KnownHostsStore::load(path)
        .map_err(|e| e.to_string())?
        .forget_host(&host, port)
        .map_err(|e| e.to_string())
}

/// Looks up the SSH session an SFTP operation piggybacks on, without exposing
/// the registry.
pub(crate) async fn lookup(
    state: &State<'_, SshState>,
    session_id: &str,
) -> Result<Arc<TokioMutex<Slot<SshSession>>>, String> {
    state.sessions.lookup(session_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forward(spec: ForwardSpec, bound_port: Option<u16>) -> Forward {
        Forward {
            session_id: "ssh-0".to_string(),
            spec,
            bound_port,
            handle: None,
            live: false,
            reestablishing: false,
            error: None,
        }
    }

    /// A forward opened on "any port" re-opens on the port it got. `ForwardPanel`
    /// sends 0 for an empty port field, so this is common.
    #[test]
    fn a_forward_bound_to_any_port_is_reopened_on_the_port_it_got() {
        let f = forward(
            ForwardSpec::Local {
                bind_host: "127.0.0.1".to_string(),
                bind_port: 0,
                target_host: "db.internal".to_string(),
                target_port: 5432,
            },
            Some(49_812),
        );
        assert!(matches!(
            f.spec_to_open(),
            ForwardSpec::Local {
                bind_port: 49_812,
                ..
            }
        ));
    }

    /// An explicit port is never rewritten.
    #[test]
    fn an_explicit_port_is_left_alone() {
        let f = forward(
            ForwardSpec::Dynamic {
                bind_host: "127.0.0.1".to_string(),
                bind_port: 1080,
            },
            Some(1080),
        );
        assert!(matches!(
            f.spec_to_open(),
            ForwardSpec::Dynamic {
                bind_port: 1080,
                ..
            }
        ));
    }

    /// Never bound: use the spec as written.
    #[test]
    fn without_a_bound_port_the_spec_is_used_as_written() {
        let f = forward(
            ForwardSpec::Remote {
                bind_host: "0.0.0.0".to_string(),
                bind_port: 0,
                target_host: "localhost".to_string(),
                target_port: 22,
            },
            None,
        );
        assert!(matches!(
            f.spec_to_open(),
            ForwardSpec::Remote { bind_port: 0, .. }
        ));
    }

    /// Forward ids share a counter with request ids: increasing, not contiguous.
    #[test]
    fn forwards_are_ordered_by_the_counter_behind_their_ids() {
        let mut ids = vec![
            "fwd-12".to_string(),
            "fwd-3".to_string(),
            "fwd-7".to_string(),
        ];
        ids.sort_by_key(|id| forward_sequence(id));
        assert_eq!(ids, vec!["fwd-3", "fwd-7", "fwd-12"]);
    }
}
