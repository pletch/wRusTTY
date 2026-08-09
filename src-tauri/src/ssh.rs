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
    AuthMethod, AuthPrompt, AuthPrompter, ForwardHandle, ForwardSpec, HostKeyPrompt, HostKeyStatus,
    HostKeyVerifier, SshConfig, SshConnector, SshSession,
};
use wr_vault::VaultSecret;
use zeroize::Zeroizing;

use crate::connection_status::status_label;
use crate::profiles;
use crate::session_registry::{SessionRegistry, Slot};
use crate::vault::VaultState;
use crate::wake::WakeOnLan;

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
    /// One round of keyboard-interactive auth: the server's own questions,
    /// relayed for a human to answer. Answered by `ssh_respond_auth_prompt`.
    AuthPrompt {
        request_id: String,
        /// The server's title for the exchange, and its free-text preamble.
        /// Both are routinely empty, and the UI supplies its own heading then.
        name: String,
        instructions: String,
        /// What to ask, in order. Responses must come back in the same order
        /// and the same number.
        fields: Vec<AuthPromptFieldPayload>,
        /// Which host is asking. A jumped connection authenticates twice, and
        /// the prompts can look identical — without this the target's password
        /// gets typed into the bastion.
        host: String,
        port: u16,
        is_jump: bool,
    },
}

/// One field of an [`SshEvent::AuthPrompt`].
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptFieldPayload {
    /// The server's wording, shown verbatim — it's the only thing telling a
    /// password apart from a one-time code.
    prompt: String,
    /// False means the server called this a secret; the field is masked.
    echo: bool,
}

/// Prompts waiting on an answer, keyed by request id. Each entry also
/// remembers the session whose handshake is parked on it, so closing a pane
/// can answer its own outstanding prompts — without that owner, an unanswered
/// prompt leaks its entry and parks the connect task on `rx.await` for the
/// life of the process, where it can't be cancelled. `T` is what an answer
/// looks like for that kind of prompt.
type PendingMap<T> = TokioMutex<HashMap<String, (String, oneshot::Sender<T>)>>;

/// SSH keeps its two extra maps *alongside* the shared registry rather than
/// inside it: a host-key prompt and a set of port forwards are SSH's, not
/// every transport's, and pushing them down would have made the generic
/// registry carry fields two of its three users don't have.
pub struct SshState {
    sessions: SessionRegistry<SshConnector>,
    /// Outstanding host-key prompts. `false` rejects.
    pending_host_key: PendingMap<bool>,
    /// Outstanding keyboard-interactive prompts. `None` cancels; otherwise one
    /// response per field of the prompt, in order.
    pending_auth: PendingMap<Option<Zeroizing<Vec<String>>>>,
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
            pending_auth: TokioMutex::default(),
            forwards: TokioMutex::default(),
            next_id: AtomicU64::new(0),
        }
    }
}

struct TauriHostKeyVerifier {
    app: AppHandle,
    channel: Channel<SshEvent>,
    /// The session this prompt belongs to. Known at `start_connection` time,
    /// carried here so `ssh_disconnect` can find and answer the prompt.
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

/// Relays the server's keyboard-interactive questions to the pane that is
/// connecting. Same shape as `TauriHostKeyVerifier` above — pending map, one
/// oneshot per outstanding question, fail closed if the webview goes away —
/// because it has the same job: park a handshake on a human without blocking
/// anything else in the app.
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
            // Nothing can answer this now, so don't leave the entry behind for
            // `ssh_disconnect` to trip over.
            state.pending_auth.lock().await.remove(&request_id);
            return None;
        }

        // A dropped sender (pane closed, channel gone) reads as a cancel,
        // which abandons the connection rather than sending a blank answer.
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
    wake: Option<WakeOnLan>,
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

    // A one-off connection has no profile to re-resolve from, so the only way
    // to reconnect it is to keep the config it was given — which for most auth
    // types means keeping a live credential for the pane's whole lifetime, and
    // that is exactly what decision 2 rules out. So it reconnects only when the
    // config holds no secret to retain in the first place.
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
    )
    .await
}

/// Whether a config can be held for the life of a session without holding a
/// secret with it — the condition for auto-reconnecting a connection that has
/// no profile behind it.
///
/// The agent keeps its own key and signs on request, and a key path with no
/// passphrase is a filename that is re-read per attempt. Everything else is
/// either a live secret (`password`, a passphrase, key material) or a question
/// for a human (`keyboard_interactive`), and a jump hop counts the same way:
/// the weaker of the two hops decides.
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
    // `map_or(true, ..)` rather than `is_none_or`, which is newer than the
    // crate's MSRV.
    hop(&config.auth) && config.jump.as_ref().map_or(true, |jump| hop(&jump.auth))
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
    let config = resolve_profile_config(&app, &profile_id, &vault_state).await?;

    // Both hops have to be answerable without a human, since a reconnect
    // authenticates twice and either one can park on a prompt.
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
            // Every attempt goes back through the vault rather than reusing
            // what the first connect resolved, so the secret is fetched and
            // dropped per attempt — and so that editing the profile's host or
            // port takes effect on the next attempt rather than replaying what
            // was baked in when the pane opened. The cost is that reconnect
            // inherits the vault's state: locked means the attempt fails and
            // the run keeps trying, so unlocking within the window is enough.
            async move {
                let vault_state = app.state::<VaultState>();
                resolve_profile_config(&app, &profile_id, &vault_state).await
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
    )
    .await
}

/// A saved profile's full `SshConfig`, jump hop included, resolved from the
/// vault as of right now. Its own function because auto-reconnect runs it again
/// per attempt — see the factory in `ssh_connect_profile`.
async fn resolve_profile_config(
    app: &AppHandle,
    profile_id: &str,
    vault_state: &VaultState,
) -> Result<SshConfig, String> {
    let profile = profiles::get_profile(app, profile_id)?;
    let mut config = build_ssh_config(&profile, vault_state).await?;

    if let Some(jump_id) = &profile.jump_profile_id {
        let jump_profile = profiles::get_profile(app, jump_id)?;
        let jump_config = build_ssh_config(&jump_profile, vault_state).await?;
        config.jump = Some(Box::new(jump_config));
    }
    Ok(config)
}

/// Resolves `profile`'s own auth from the vault and builds a plain
/// (non-jumping) `SshConfig` for it — used both for the profile being
/// connected to and, if it names one, for its jump-host profile. A jump
/// profile's own `jump_profile_id`, if any, is ignored: only a single hop
/// is supported.
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
    })
}

/// Whether a profile's credential can be produced again with nobody watching.
///
/// The table this encodes, and why it is a feature rather than a limitation:
/// `agent` reconnects because the agent holds the key and signs again, and a
/// vault-stored password or key reconnects if the vault is still unlocked.
/// `keyboard_interactive` — "ask each time" — cannot, by construction: there is
/// nothing stored, and a session whose whole point is that its credential is
/// never written down must not sprout a password dialog at 3am because a link
/// flapped. Those panes keep the manual Reconnect button, which is what it is
/// for.
fn reconnects_unattended(profile: &profiles::SessionProfile) -> bool {
    profile.auth_type != "keyboard_interactive"
}

async fn resolve_auth(
    profile: &profiles::SessionProfile,
    vault_state: &VaultState,
) -> Result<AuthMethod, String> {
    // Both handled before the vault is touched, for opposite reasons: the
    // agent holds its key itself, and keyboard-interactive asks the user at
    // connect time. Neither has a stored secret to resolve, so neither has any
    // business being blocked by a locked vault. `authNeedsVault` in
    // lib/profiles.ts is the frontend's copy of this same judgement.
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

/// Builds a connector for one attempt, wiring in the prompts that belong to
/// this session id.
///
/// Its own function because auto-reconnect needs to do this again per attempt
/// (`Connector::connect` consumes the connector), and because the verifier and
/// prompter must keep pointing at the *same* session id across a reconnect —
/// that is what lets `ssh_disconnect` answer a prompt a retry is parked on when
/// the pane closes.
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

// Nine, two past clippy's threshold, and every one of them is already the
// shape the two commands above hold — a struct here would exist only to be
// built twice and destructured once.
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
    // Produces a *fresh* config for each reconnect attempt, or `None` to opt
    // this session out of auto-reconnect. Re-resolved rather than retained:
    // `AuthMethod` is `ZeroizeOnDrop` precisely so the copy cloned out of the
    // vault at connect time is not the one left in freed heap, and keeping a
    // resolved credential alive for a long-lived session's whole life to make
    // retries cheap would quietly reverse that for every pane in the app.
    reconnect_config: Option<MakeCfg>,
) -> Result<String, String>
where
    MakeCfg: Fn() -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<SshConfig, String>> + Send,
{
    let session_id = state.sessions.next_session_id();

    // A magic packet is a broadcast on the local segment; the host behind a
    // jump is, by definition, not on it. Waking would send the packet
    // somewhere it can't help and then spend the whole wait probing a host
    // this machine has no route to — failing a connection that would
    // otherwise have gone through the jump perfectly well. Waking *through*
    // the jump is a real thing to want, and a different feature: the packet
    // has to originate on the far side.
    let wake = match wake {
        Some(_) if config.jump.is_some() => {
            log::warn!(
                "not waking {}: a magic packet can't reach a host behind a jump host",
                config.host
            );
            None
        }
        wake => wake,
    };

    // Cloned before the config is handed to the connector: the probe needs to
    // know where it's knocking, and this is the same endpoint the handshake
    // will use.
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
    // Before the registry entry goes, answer any prompt this session is parked
    // on — closing a pane instead of answering is the normal way a user
    // declines an unknown host or an auth challenge, and the handshake is
    // blocked on `rx.await` until someone resolves it. Each gets the same
    // answer its own Cancel button gives, so the handshake fails and never
    // builds a session. Done first so the connect task is already unwinding by
    // the time the id disappears.
    for tx in take_pending(&state.pending_host_key, &session_id).await {
        let _ = tx.send(false);
    }
    for tx in take_pending(&state.pending_auth, &session_id).await {
        let _ = tx.send(None);
    }

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
    if let Some((_, tx)) = state.pending_host_key.lock().await.remove(&request_id) {
        let _ = tx.send(accept);
    }
    Ok(())
}

/// Answers one round of keyboard-interactive auth. `responses` must hold one
/// entry per field of the prompt, in order; `None` cancels, which abandons the
/// connection rather than sending blanks the server would count as a failed
/// attempt.
///
/// The responses are live secrets — a password, a one-time code — so they are
/// wrapped for zeroizing the moment they arrive and never logged. Nothing here
/// persists them: saving an interactive answer would mean saving a TOTP code,
/// which is worthless by the next connection.
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

/// Removes every prompt `session_id` owns from one pending map, returning the
/// senders so they can be answered outside the lock.
///
/// Generic over the answer type because host-key and auth prompts differ only
/// in what a cancel *is* (`false` vs `None`) — and an unanswered entry in
/// either one parks its handshake on `rx.await` for the life of the process.
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

/// Every host key this app has been told to trust.
///
/// Loaded from the file on each call rather than held in state. The store is
/// small, it is read once when a dialog opens, and every connector already
/// keeps its own copy — adding a fourth long-lived one that could drift is the
/// opposite of what a trust anchor needs.
#[tauri::command]
pub async fn ssh_list_known_hosts(app: AppHandle) -> Result<Vec<wr_ssh::KnownHostEntry>, String> {
    let path = known_hosts_path(&app)?;
    Ok(wr_ssh::KnownHostsStore::load(path)
        .map_err(|e| e.to_string())?
        .list())
}

/// Forgets one stored host key, identified by the exact line it is stored as.
///
/// By the line rather than by fingerprint because an unparseable entry has no
/// fingerprint — and those are the ones that most need removing, since they pin
/// a host to "the key changed" until someone edits the file by hand.
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
