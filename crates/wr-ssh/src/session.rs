use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::ssh_key::HashAlg;
use russh::keys::{decode_secret_key, PrivateKey};
use russh::{client, ChannelMsg, Disconnect, MethodKind};
use tokio::sync::{mpsc, Mutex};
use wr_core::{write_paced, ConnectionEvent, ConnectionStatus, Connector, DisconnectKind, Session};
use zeroize::Zeroizing;

use crate::config::{AuthMethod, SshConfig};
use crate::error::SshError;
use crate::forward::{self, ForwardHandle, ForwardSpec};
use crate::handler::{ClientHandler, HostKeyVerifier};
use crate::known_hosts::KnownHostsStore;
use crate::prompt::{AuthPrompt, AuthPromptField, AuthPrompter};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);

/// Prompt rounds a keyboard-interactive exchange may take before the server is
/// treated as never finishing. Real stacks use under five.
const MAX_AUTH_ROUNDS: usize = 32;

/// Everything needed to open an SSH session, before one exists. Separate from
/// `SshSession` so the long handshake (including a host-key prompt waiting on a
/// human) doesn't block input or resizes. See `wr_core::Connector`.
pub struct SshConnector {
    config: SshConfig,
    known_hosts: Arc<Mutex<KnownHostsStore>>,
    verifier: Arc<dyn HostKeyVerifier>,
    /// Answers the server's keyboard-interactive questions; see `crate::prompt`.
    prompter: Arc<dyn AuthPrompter>,
    remote_forwards: forward::RemoteForwardRegistry,
    initial_cols: u16,
    initial_rows: u16,
}

/// A live SSH session: the authenticated transport, its PTY channel, and the
/// two channels feeding it.
pub struct SshSession {
    handle: Option<Arc<client::Handle<ClientHandler>>>,
    /// `Option` so `disconnect` can drop them, which ends the pump tasks.
    input_tx: Option<mpsc::Sender<Vec<u8>>>,
    resize_tx: Option<mpsc::Sender<(u16, u16)>>,
    remote_forwards: forward::RemoteForwardRegistry,
    // Opened lazily and reused for the connection's lifetime; a `OnceCell`
    // keeps this on `&self`.
    sftp: tokio::sync::OnceCell<Arc<wr_sftp::SftpClient>>,
    // A second channel for bulk transfers; see `get_or_open_transfer_sftp`.
    transfer_sftp: tokio::sync::OnceCell<Arc<wr_sftp::SftpClient>>,
}

impl SshConnector {
    pub fn new(
        config: SshConfig,
        known_hosts_path: impl Into<PathBuf>,
        verifier: Arc<dyn HostKeyVerifier>,
        prompter: Arc<dyn AuthPrompter>,
        initial_cols: u16,
        initial_rows: u16,
    ) -> std::io::Result<Self> {
        let known_hosts = KnownHostsStore::load(known_hosts_path)?;
        Ok(Self {
            config,
            known_hosts: Arc::new(Mutex::new(known_hosts)),
            verifier,
            prompter,
            remote_forwards: Arc::new(Mutex::new(HashMap::new())),
            initial_cols,
            initial_rows,
        })
    }
}

impl SshSession {
    /// Starts a local, remote, or dynamic (SOCKS5) port forward on the
    /// active connection.
    pub async fn add_forward(&self, spec: ForwardSpec) -> Result<ForwardHandle, SshError> {
        let handle = self.handle.clone().ok_or(SshError::NotConnected)?;
        forward::start(handle, self.remote_forwards.clone(), spec).await
    }

    /// Returns the SFTP client for browsing and editing, opening the subsystem
    /// channel on first use.
    pub async fn get_or_open_sftp(&self) -> Result<Arc<wr_sftp::SftpClient>, SshError> {
        Self::get_or_open(&self.sftp, self.handle.clone()).await
    }

    /// A handle for running things as root on this connection. Returned owned
    /// because elevated work outlives the session mutex. Opens no channel; whether
    /// a password is needed is only known by trying. See [`crate::sudo`].
    pub fn sudo(&self) -> Result<crate::sudo::SudoRunner, SshError> {
        let handle = self.handle.clone().ok_or(SshError::NotConnected)?;
        Ok(crate::sudo::SudoRunner::new(handle))
    }

    /// Run one command on its own `exec` channel and collect its stdout: one more
    /// channel on the established session, with no new authentication.
    ///
    /// Bounded, since the host is untrusted:
    ///
    ///   - **`max_bytes`** caps collection; the channel is then dropped.
    ///   - **`timeout`** caps the wait; hitting it is an error, not a short read.
    ///   - stderr is discarded rather than spliced into the output.
    ///
    /// Hosts with `ForceCommand`, restricted shells or appliance CLIs may refuse or
    /// answer nonsense; callers must treat failure as ordinary.
    pub async fn exec_capture(
        &self,
        command: &str,
        max_bytes: usize,
        timeout: Duration,
    ) -> Result<Vec<u8>, SshError> {
        let handle = self.handle.clone().ok_or(SshError::NotConnected)?;
        tokio::time::timeout(timeout, async move {
            let mut channel = handle.channel_open_session().await?;
            channel.exec(true, command).await?;
            let mut out = Vec::new();
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        // Stop at the cap; dropping the channel tells the far end to stop.
                        let room = max_bytes.saturating_sub(out.len());
                        if room == 0 {
                            break;
                        }
                        out.extend_from_slice(&data[..data.len().min(room)]);
                        if out.len() >= max_bytes {
                            break;
                        }
                    }
                    // Finished, or the transport went away.
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    // Exit status, stderr, window adjustments: ignored.
                    _ => {}
                }
            }
            Ok::<_, SshError>(out)
        })
        .await
        .map_err(|_| SshError::ExecTimeout)?
    }

    /// A second SFTP client on its own channel, for bulk transfers. One client
    /// serializes requests, so a long download would freeze browsing. Lazy, so
    /// sessions that never transfer don't open it.
    pub async fn get_or_open_transfer_sftp(&self) -> Result<Arc<wr_sftp::SftpClient>, SshError> {
        Self::get_or_open(&self.transfer_sftp, self.handle.clone()).await
    }

    async fn get_or_open(
        cell: &tokio::sync::OnceCell<Arc<wr_sftp::SftpClient>>,
        handle: Option<Arc<client::Handle<ClientHandler>>>,
    ) -> Result<Arc<wr_sftp::SftpClient>, SshError> {
        cell.get_or_try_init(|| async {
            // A fresh channel on the live connection, requesting the subsystem.
            let handle = handle.ok_or(SshError::NotConnected)?;
            let channel = handle.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let client = wr_sftp::SftpClient::new(channel.into_stream()).await?;
            Ok::<_, SshError>(Arc::new(client))
        })
        .await
        .cloned()
    }
}

#[async_trait]
impl Connector for SshConnector {
    type Session = SshSession;
    type Error = SshError;

    async fn connect(self, events: mpsc::Sender<ConnectionEvent>) -> Result<SshSession, SshError> {
        let _ = events
            .send(ConnectionEvent::Status(ConnectionStatus::Connecting))
            .await;

        let host = self.config.host.clone();
        let port = self.config.port;

        let result = self.connect_inner(&events).await;

        match &result {
            Ok(_) => {
                let _ = events
                    .send(ConnectionEvent::Status(ConnectionStatus::Connected))
                    .await;
            }
            Err(e) => {
                let _ = events
                    .send(ConnectionEvent::Status(ConnectionStatus::Failed(
                        e.to_string(),
                    )))
                    .await;
                tracing::warn!(%host, port, error = %e, "ssh connect failed");
            }
        }

        result
    }

    /// Whether retrying costs anything. Rejected credentials spend the server's
    /// `MaxAuthTries` (OpenSSH defaults to 6), so an unattended loop would lock the
    /// account out; a rejected host key must never be retried past. Timeouts are
    /// network symptoms and are retryable.
    fn retryable(error: &SshError) -> bool {
        !matches!(
            error,
            SshError::HostKeyRejected { .. }
                | SshError::AuthFailed
                | SshError::AuthCancelled
                | SshError::AuthPartial { .. }
                | SshError::AuthMethodUnavailable { .. }
                | SshError::AuthTooManyRounds { .. }
                // No agent, or it holds nothing the server accepts.
                | SshError::AgentUnavailable(_)
                | SshError::AgentRejected { .. }
                // A missing or unreadable key file is a configuration fault.
                | SshError::KeyNotFound(_)
                | SshError::KeyLoad(_)
        )
    }
}

#[async_trait]
impl Session for SshSession {
    type Error = SshError;

    async fn write(&mut self, data: &[u8]) -> Result<(), SshError> {
        let tx = self.input_tx.as_ref().ok_or(SshError::NotConnected)?;
        tx.send(data.to_vec())
            .await
            .map_err(|_| SshError::NotConnected)
    }

    async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), SshError> {
        let tx = self.resize_tx.as_ref().ok_or(SshError::NotConnected)?;
        tx.send((cols, rows))
            .await
            .map_err(|_| SshError::NotConnected)
    }

    async fn disconnect(&mut self) -> Result<(), SshError> {
        self.input_tx = None;
        self.resize_tx = None;
        // Reset both SFTP cells, so a reconnected session doesn't hand out
        // channels on the dead connection.
        self.sftp = tokio::sync::OnceCell::new();
        self.transfer_sftp = tokio::sync::OnceCell::new();
        if let Some(handle) = self.handle.take() {
            // Dropping the senders stops the pumps; the transport may already be gone.
            let _ = handle
                .disconnect(Disconnect::ByApplication, "", "English")
                .await;
        }
        Ok(())
    }
}

impl SshConnector {
    async fn connect_inner(
        self,
        events: &mpsc::Sender<ConnectionEvent>,
    ) -> Result<SshSession, SshError> {
        let handle = match &self.config.jump {
            None => {
                connect_direct(
                    &self.config,
                    self.config.proxy.as_ref(),
                    self.known_hosts.clone(),
                    self.verifier.clone(),
                    self.prompter.clone(),
                    false,
                    self.remote_forwards.clone(),
                )
                .await?
            }
            Some(jump_config) => {
                // The jump hop gets its own throwaway remote-forward registry (forwarded
                // connections only matter on the final hop). It shares the prompter,
                // flagged `is_jump` so prompts say which hop is asking. A proxy, if any,
                // carries only this first socket.
                let jump_handle = connect_direct(
                    jump_config,
                    self.config.proxy.as_ref().or(jump_config.proxy.as_ref()),
                    self.known_hosts.clone(),
                    self.verifier.clone(),
                    self.prompter.clone(),
                    true,
                    Arc::new(Mutex::new(HashMap::new())),
                )
                .await?;

                // A `direct-tcpip` channel on the jump connection, piped into the target's
                // handshake (the standard ProxyJump shape; see forward.rs).
                let channel = jump_handle
                    .channel_open_direct_tcpip(
                        self.config.host.clone(),
                        self.config.port as u32,
                        "127.0.0.1",
                        0,
                    )
                    .await?;

                connect_via_stream(
                    &self.config,
                    channel.into_stream(),
                    self.known_hosts.clone(),
                    self.verifier.clone(),
                    self.prompter.clone(),
                    self.remote_forwards.clone(),
                )
                .await?
            }
        };

        let channel = handle.channel_open_session().await?;
        // Advertise 24-bit color; vim, tmux, bat and others check `COLORTERM`.
        // Best-effort (`want_reply: false`): sshd drops it unless `AcceptEnv`
        // allows it. Must precede `request_shell`.
        let _ = channel.set_env(false, "COLORTERM", "truecolor").await;
        // Advertise OSC 9;4 progress reporting (see lib/appProgress.ts). Programs
        // recognize terminals by name rather than probing; Claude Code, for one,
        // emits it only for ConEmu, recent Ghostty or iTerm2, and disables it under
        // `WT_SESSION`. `ConEmuANSI` names the protocol's origin without claiming
        // Ghostty's or iTerm2's other private sequences. Same `AcceptEnv` caveat;
        // see docs/SHELL_INTEGRATION.md.
        let _ = channel.set_env(false, "ConEmuANSI", "ON").await;
        channel
            .request_pty(
                false,
                self.config.term_type(),
                self.initial_cols as u32,
                self.initial_rows as u32,
                0,
                0,
                &[],
            )
            .await?;
        channel.request_shell(true).await?;

        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(1000);
        let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(16);

        let mut writer = channel.make_writer();
        tokio::spawn(async move {
            while let Some(data) = input_rx.recv().await {
                // Paced (see `wr_core::WRITE_CHUNK`); every input route passes through
                // this task.
                if write_paced(&mut writer, &data).await.is_err() {
                    break;
                }
            }
        });

        let output_events = events.clone();
        let mut channel = channel;
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                                if output_events.send(ConnectionEvent::Data(data.to_vec())).await.is_err() {
                                    break;
                                }
                            }
                            // The far end finished (shell exited or channel closed); not reconnected.
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                                let _ = output_events.send(ConnectionEvent::Status(
                                    ConnectionStatus::Disconnected(DisconnectKind::Closed),
                                )).await;
                                break;
                            }
                            // The russh session ended under us: a dropped link or expired
                            // keepalive. This is the one worth reconnecting.
                            None => {
                                let _ = output_events.send(ConnectionEvent::Status(
                                    ConnectionStatus::Disconnected(DisconnectKind::Lost),
                                )).await;
                                break;
                            }
                            _ => {}
                        }
                    }
                    resize = resize_rx.recv() => {
                        match resize {
                            Some((cols, rows)) => {
                                if let Err(e) = channel.window_change(cols as u32, rows as u32, 0, 0).await {
                                    tracing::warn!(error = %e, "ssh window_change failed");
                                }
                            }
                            None => break,
                        }
                    }
                }
            }
        });

        Ok(SshSession {
            handle: Some(Arc::new(handle)),
            input_tx: Some(input_tx),
            resize_tx: Some(resize_tx),
            remote_forwards: self.remote_forwards,
            sftp: tokio::sync::OnceCell::new(),
            transfer_sftp: tokio::sync::OnceCell::new(),
        })
    }
}

/// Connects and authenticates a fresh TCP connection (optionally via a proxy),
/// sharing host-key trust and the remote-forward registry with the caller. Used
/// for a plain connection and for a jump connection's first hop.
async fn connect_direct(
    config: &SshConfig,
    proxy: Option<&crate::proxy::ProxyConfig>,
    known_hosts: Arc<Mutex<KnownHostsStore>>,
    verifier: Arc<dyn HostKeyVerifier>,
    prompter: Arc<dyn AuthPrompter>,
    is_jump: bool,
    remote_forwards: forward::RemoteForwardRegistry,
) -> Result<client::Handle<ClientHandler>, SshError> {
    // Key types already pinned for this host go first; see
    // `KnownHostsStore::host_key_preference`.
    let preferred = known_hosts
        .lock()
        .await
        .host_key_preference(&config.host, config.port);
    let ssh_config = Arc::new(client::Config {
        keepalive_interval: config.keepalive_interval(),
        keepalive_max: crate::config::KEEPALIVE_MAX,
        preferred,
        // Nagle off, as OpenSSH and PuTTY do for interactive sessions (russh
        // leaves it on); otherwise delayed ACKs can add ~40ms per keystroke.
        // Only meaningful on a real socket, which is this function's.
        nodelay: true,
        ..Default::default()
    });

    let verify_started = Arc::new(tokio::sync::Notify::new());
    let handler = ClientHandler::new(
        config.host.clone(),
        config.port,
        known_hosts,
        verifier,
        remote_forwards,
        verify_started.clone(),
    );

    match proxy {
        None => {
            let connect_fut =
                client::connect(ssh_config, (config.host.as_str(), config.port), handler);
            await_handshake(config, connect_fut, verify_started, prompter, is_jump).await
        }
        // The same handshake over a stream the proxy opened.
        Some(proxy) => {
            let stream = crate::proxy::connect(proxy, &config.host, config.port)
                .await
                .map_err(|source| SshError::Proxy {
                    proxy: format!("{}:{}", proxy.host, proxy.port),
                    source,
                })?;
            let connect_fut = client::connect_stream(ssh_config, stream, handler);
            await_handshake(config, connect_fut, verify_started, prompter, is_jump).await
        }
    }
}

/// Like `connect_direct`, but over an already-open stream (a jump hop's
/// `direct-tcpip` channel): ProxyJump.
async fn connect_via_stream<S>(
    config: &SshConfig,
    stream: S,
    known_hosts: Arc<Mutex<KnownHostsStore>>,
    verifier: Arc<dyn HostKeyVerifier>,
    prompter: Arc<dyn AuthPrompter>,
    remote_forwards: forward::RemoteForwardRegistry,
) -> Result<client::Handle<ClientHandler>, SshError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    // Checked against its own pins.
    let preferred = known_hosts
        .lock()
        .await
        .host_key_preference(&config.host, config.port);
    let ssh_config = Arc::new(client::Config {
        keepalive_interval: config.keepalive_interval(),
        keepalive_max: crate::config::KEEPALIVE_MAX,
        preferred,
        ..Default::default()
    });

    let verify_started = Arc::new(tokio::sync::Notify::new());
    let handler = ClientHandler::new(
        config.host.clone(),
        config.port,
        known_hosts,
        verifier,
        remote_forwards,
        verify_started.clone(),
    );

    let connect_fut = client::connect_stream(ssh_config, stream, handler);
    // Always the final hop.
    await_handshake(config, connect_fut, verify_started, prompter, false).await
}

/// Waits for the handshake (bounded by `CONNECT_TIMEOUT`, except while a
/// host-key prompt is up), then authenticates (bounded by `AUTH_TIMEOUT`).
async fn await_handshake<F>(
    config: &SshConfig,
    connect_fut: F,
    verify_started: Arc<tokio::sync::Notify>,
    prompter: Arc<dyn AuthPrompter>,
    is_jump: bool,
) -> Result<client::Handle<ClientHandler>, SshError>
where
    F: std::future::Future<Output = Result<client::Handle<ClientHandler>, SshError>>,
{
    tokio::pin!(connect_fut);

    let mut awaiting_verification = false;
    let mut handle = loop {
        tokio::select! {
            result = &mut connect_fut => break result?,
            () = tokio::time::sleep(CONNECT_TIMEOUT), if !awaiting_verification => {
                return Err(SshError::Timeout {
                    host: config.host.clone(),
                    port: config.port,
                });
            }
            () = verify_started.notified(), if !awaiting_verification => {
                awaiting_verification = true;
            }
        }
    };

    // The auth timeout bounds server silence, not the exchange, since
    // keyboard-interactive may wait on a human (2FA push). Each expiry is
    // forgiven while a prompt is up, and once more if one was answered during
    // the window, giving a full `AUTH_TIMEOUT` after the user's last answer.
    // Scoped so the pinned future's `&mut handle` borrow ends first.
    {
        let progress = Arc::new(AuthProgress::default());
        let auth_fut = authenticate(config, &mut handle, prompter, is_jump, progress.clone());
        tokio::pin!(auth_fut);

        let mut seen_answers = progress.answers();
        loop {
            tokio::select! {
                result = &mut auth_fut => break result?,
                () = tokio::time::sleep(AUTH_TIMEOUT) => {
                    if progress.should_extend(&mut seen_answers) {
                        continue;
                    }
                    return Err(SshError::AuthTimeout {
                        host: config.host.clone(),
                        port: config.port,
                    });
                }
            }
        }
    }

    Ok(handle)
}

/// Lets the auth timeout tell server silence from a person answering a prompt.
/// Counts answers as well as tracking an open prompt, so answering late in a
/// window still earns a full window.
#[derive(Default)]
struct AuthProgress {
    awaiting_user: AtomicBool,
    answers: AtomicU64,
}

impl AuthProgress {
    fn answers(&self) -> u64 {
        self.answers.load(Ordering::Relaxed)
    }

    fn begin_prompt(&self) {
        self.awaiting_user.store(true, Ordering::Relaxed);
    }

    fn end_prompt(&self) {
        self.awaiting_user.store(false, Ordering::Relaxed);
        self.answers.fetch_add(1, Ordering::Relaxed);
    }

    /// Whether an elapsed timeout window should be forgiven, advancing
    /// `seen_answers` when it is. `false` means a full window of server silence
    /// with no human involved.
    fn should_extend(&self, seen_answers: &mut u64) -> bool {
        let answers = self.answers();
        let extend = self.awaiting_user.load(Ordering::Relaxed) || answers != *seen_answers;
        if extend {
            *seen_answers = answers;
        }
        extend
    }
}

async fn authenticate(
    config: &SshConfig,
    handle: &mut client::Handle<ClientHandler>,
    prompter: Arc<dyn AuthPrompter>,
    is_jump: bool,
    progress: Arc<AuthProgress>,
) -> Result<(), SshError> {
    use russh::client::AuthResult;

    let result = match &config.auth {
        AuthMethod::Password { password } => {
            handle
                .authenticate_password(&config.username, password)
                .await?
        }
        AuthMethod::PublicKey {
            key_path,
            passphrase,
        } => {
            let key = load_private_key(key_path, passphrase.as_deref())?;

            handle
                .authenticate_publickey(
                    &config.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha256)),
                )
                .await?
        }
        AuthMethod::PublicKeyMaterial {
            key_material,
            passphrase,
        } => {
            let key = parse_private_key(key_material, passphrase.as_deref())?;

            handle
                .authenticate_publickey(
                    &config.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha256)),
                )
                .await?
        }
        AuthMethod::KeyboardInteractive => {
            return authenticate_keyboard_interactive(config, handle, prompter, is_jump, &progress)
                .await
        }
        AuthMethod::Agent => return authenticate_with_agent(handle, &config.username).await,
    };

    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { .. } => Err(SshError::AuthFailed),
    }
}

/// Drives an RFC 4256 keyboard-interactive exchange, relaying each round to
/// `prompter`. A loop because the server decides the rounds (e.g. password then
/// 2FA code, or a retry after a wrong answer).
async fn authenticate_keyboard_interactive(
    config: &SshConfig,
    handle: &mut client::Handle<ClientHandler>,
    prompter: Arc<dyn AuthPrompter>,
    is_jump: bool,
    progress: &AuthProgress,
) -> Result<(), SshError> {
    use russh::client::KeyboardInteractiveAuthResponse as Response;

    // No submethod hint; servers may ignore it anyway.
    let mut response = handle
        .authenticate_keyboard_interactive_start(config.username.clone(), None::<String>)
        .await?;

    // Distinguishes "method unsupported" from "wrong answer"; both arrive as
    // `Failure`.
    let mut asked_anything = false;

    for _ in 0..MAX_AUTH_ROUNDS {
        let (name, instructions, fields) = match response {
            Response::Success => return Ok(()),
            // Accepted, but policy requires another method too. Not "auth failed":
            // the credential was right.
            Response::Failure {
                partial_success: true,
                remaining_methods,
            } => {
                return Err(SshError::AuthPartial {
                    remaining: render_methods(&remaining_methods),
                })
            }
            // Refused before asking anything: the server doesn't do
            // keyboard-interactive (Debian and Ubuntu default to
            // `KbdInteractiveAuthentication no`). If it offers `password`, ask for one
            // instead; "Prompt me" is about not storing the secret, not the wire
            // method. After a round, a failure is a wrong answer and isn't retried.
            Response::Failure {
                remaining_methods, ..
            } => {
                if !asked_anything && remaining_methods.contains(&MethodKind::Password) {
                    return authenticate_password_interactively(
                        config, handle, prompter, is_jump, progress,
                    )
                    .await;
                }
                if asked_anything {
                    return Err(SshError::AuthFailed);
                }
                return Err(SshError::AuthMethodUnavailable {
                    remaining: render_methods(&remaining_methods),
                });
            }
            Response::InfoRequest {
                name,
                instructions,
                prompts,
            } => (name, instructions, prompts),
        };

        let answers = if fields.is_empty() {
            // A round with no fields is the server talking (a banner, an expiry
            // notice); answer it without showing an empty dialog.
            Zeroizing::new(Vec::new())
        } else {
            asked_anything = true;
            // Bracketed so the timeout knows a human is involved.
            progress.begin_prompt();
            let answered = prompter
                .prompt(AuthPrompt {
                    name,
                    instructions,
                    fields: fields
                        .iter()
                        .map(|p| AuthPromptField {
                            prompt: p.prompt.clone(),
                            echo: p.echo,
                        })
                        .collect(),
                    host: config.host.clone(),
                    port: config.port,
                    is_jump,
                })
                .await;
            progress.end_prompt();
            // Canceling abandons rather than sending blanks, which would spend an
            // attempt.
            answered.ok_or(SshError::AuthCancelled)?
        };

        response = handle
            .authenticate_keyboard_interactive_respond(answers.to_vec())
            .await?;
    }

    Err(SshError::AuthTooManyRounds {
        rounds: MAX_AUTH_ROUNDS,
    })
}

/// Asks for a password and authenticates with the plain `password` method: the
/// fallback when keyboard-interactive is off. One attempt, since each failure
/// spends one of the server's `MaxAuthTries`.
async fn authenticate_password_interactively(
    config: &SshConfig,
    handle: &mut client::Handle<ClientHandler>,
    prompter: Arc<dyn AuthPrompter>,
    is_jump: bool,
    progress: &AuthProgress,
) -> Result<(), SshError> {
    use russh::client::AuthResult;

    progress.begin_prompt();
    let answered = prompter
        .prompt(AuthPrompt {
            name: String::new(),
            instructions: String::new(),
            // Worded like the prompt a server would send.
            fields: vec![AuthPromptField {
                prompt: "Password:".to_string(),
                echo: false,
            }],
            host: config.host.clone(),
            port: config.port,
            is_jump,
        })
        .await;
    progress.end_prompt();

    let answers = answered.ok_or(SshError::AuthCancelled)?;
    let password = answers.first().cloned().unwrap_or_default();

    match handle
        .authenticate_password(&config.username, password)
        .await?
    {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { .. } => Err(SshError::AuthFailed),
    }
}

/// A server's acceptable auth methods for an error message; never empty.
fn render_methods(methods: &russh::MethodSet) -> String {
    if methods.is_empty() {
        return "no other methods".to_string();
    }
    methods
        .iter()
        .map(String::from)
        .collect::<Vec<_>>()
        .join(", ")
}

/// Tries each identity in the running SSH agent until one authenticates. On
/// Windows both the OpenSSH agent (named pipe) and Pageant are tried. Many keys
/// can exhaust the server's `MaxAuthTries` before the right one, hence the
/// distinct `AgentRejected` error.
#[cfg(windows)]
async fn authenticate_with_agent(
    handle: &mut russh::client::Handle<ClientHandler>,
    username: &str,
) -> Result<(), SshError> {
    use russh::keys::agent::client::AgentClient;

    let mut agent = match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        Ok(client) => client.dynamic(),
        Err(pipe_err) => match AgentClient::connect_pageant().await {
            Ok(client) => client.dynamic(),
            Err(pageant_err) => {
                return Err(SshError::AgentUnavailable(format!(
                    "no SSH agent found — the Windows OpenSSH agent service ({pipe_err}) \
                     and Pageant ({pageant_err}) were both unreachable"
                )))
            }
        },
    };
    authenticate_with_agent_identities(handle, username, &mut agent).await
}

#[cfg(not(windows))]
async fn authenticate_with_agent(
    handle: &mut russh::client::Handle<ClientHandler>,
    username: &str,
) -> Result<(), SshError> {
    use russh::keys::agent::client::AgentClient;

    // Elsewhere: a single agent at SSH_AUTH_SOCK.
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| SshError::AgentUnavailable(format!("no SSH agent found: {e}")))?
        .dynamic();
    authenticate_with_agent_identities(handle, username, &mut agent).await
}

async fn authenticate_with_agent_identities<S>(
    handle: &mut russh::client::Handle<ClientHandler>,
    username: &str,
    agent: &mut russh::keys::agent::client::AgentClient<S>,
) -> Result<(), SshError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    use russh::client::AuthResult;
    use russh::keys::agent::AgentIdentity;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| SshError::AgentUnavailable(format!("could not list agent keys: {e}")))?;
    if identities.is_empty() {
        return Err(SshError::AgentUnavailable(
            "the SSH agent is running but holds no keys — add one with `ssh-add`, \
             or load it into Pageant"
                .to_string(),
        ));
    }

    let offered = identities.len();
    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else {
            // Certificates need a different flow; skip them.
            continue;
        };
        // The agent produces the signature.
        let result = handle
            .authenticate_publickey_with(username, key, Some(HashAlg::Sha256), agent)
            .await
            .map_err(|e| SshError::AgentUnavailable(format!("agent signing failed: {e}")))?;
        if matches!(result, AuthResult::Success) {
            return Ok(());
        }
    }

    Err(SshError::AgentRejected { offered })
}

/// PuTTY key files start `PuTTY-User-Key-File-2:` or `-3:`.
fn is_ppk(content: &str) -> bool {
    content.trim_start().starts_with("PuTTY-User-Key-File-")
}

/// Loads a private key from disk; `.ppk` (v2 and v3, via `ssh-key`'s "ppk"
/// feature) or OpenSSH/PEM by header.
fn load_private_key(key_path: &str, passphrase: Option<&str>) -> Result<PrivateKey, SshError> {
    let expanded = expand_tilde(key_path);
    if !expanded.exists() {
        return Err(SshError::KeyNotFound(key_path.to_string()));
    }
    let key_content = std::fs::read_to_string(&expanded)?.replace("\r\n", "\n");
    parse_private_key(&key_content, passphrase)
}

/// Parses key content (from disk or the vault), `.ppk` or OpenSSH/PEM. Public so
/// the vault key-import command can validate a key and passphrase.
pub fn parse_private_key(content: &str, passphrase: Option<&str>) -> Result<PrivateKey, SshError> {
    if is_ppk(content) {
        PrivateKey::from_ppk(content, passphrase.map(str::to_string))
            .map_err(|e| SshError::KeyLoad(e.to_string()))
    } else {
        decode_secret_key(content, passphrase).map_err(|e| SshError::KeyLoad(e.to_string()))
    }
}

pub fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

/// The auth-timeout rules. Wrong in one direction, every 2FA login dies at 15
/// seconds; in the other, a dead server never times out.
#[cfg(test)]
mod auth_timeout_tests {
    use super::*;

    /// Nobody was asked anything; the server just stopped.
    #[test]
    fn a_silent_server_with_no_prompt_is_not_forgiven() {
        let progress = AuthProgress::default();
        let mut seen = progress.answers();
        assert!(!progress.should_extend(&mut seen));
    }

    /// A dialog is on screen.
    #[test]
    fn a_prompt_on_screen_is_forgiven_indefinitely() {
        let progress = AuthProgress::default();
        let mut seen = progress.answers();
        progress.begin_prompt();
        for _ in 0..100 {
            assert!(progress.should_extend(&mut seen));
        }
    }

    /// Answering late in a window still buys a full window.
    #[test]
    fn answering_late_in_a_window_still_buys_a_full_window() {
        let progress = AuthProgress::default();
        let mut seen = progress.answers();
        progress.begin_prompt();
        progress.end_prompt();
        assert!(progress.should_extend(&mut seen));
    }

    /// ...but only one, or a dead server after an answer hangs forever.
    #[test]
    fn silence_after_an_answer_is_forgiven_once_and_then_fails() {
        let progress = AuthProgress::default();
        let mut seen = progress.answers();
        progress.begin_prompt();
        progress.end_prompt();
        assert!(progress.should_extend(&mut seen));
        assert!(!progress.should_extend(&mut seen));
    }

    /// Each round of a multi-step exchange gets its own grace.
    #[test]
    fn every_round_earns_its_own_extension() {
        let progress = AuthProgress::default();
        let mut seen = progress.answers();
        for _ in 0..5 {
            progress.begin_prompt();
            assert!(progress.should_extend(&mut seen));
            progress.end_prompt();
            assert!(progress.should_extend(&mut seen));
            assert!(!progress.should_extend(&mut seen));
        }
    }
}

#[cfg(test)]
mod ppk_tests {
    use super::*;

    // Real PuTTY key files from ssh-key's test suite (Apache-2.0/MIT),
    // exercising the PuTTY-3 + Argon2id path.
    const ED25519_PLAIN: &str = include_str!("../tests/fixtures/id_ed25519.ppk");
    const ED25519_ENCRYPTED: &str = include_str!("../tests/fixtures/id_ed25519_enc.ppk");

    fn write_fixture(dir: &tempfile::TempDir, name: &str, content: &str) -> PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn detects_ppk_by_header() {
        assert!(is_ppk(ED25519_PLAIN));
        assert!(!is_ppk(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n"
        ));
    }

    #[test]
    fn loads_unencrypted_ppk() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_fixture(&dir, "id_ed25519.ppk", ED25519_PLAIN);
        load_private_key(path.to_str().unwrap(), None).unwrap();
    }

    #[test]
    fn loads_encrypted_ppk_with_correct_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_fixture(&dir, "id_ed25519_enc.ppk", ED25519_ENCRYPTED);
        load_private_key(path.to_str().unwrap(), Some("123")).unwrap();
    }

    #[test]
    fn rejects_encrypted_ppk_with_wrong_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_fixture(&dir, "id_ed25519_enc.ppk", ED25519_ENCRYPTED);
        assert!(load_private_key(path.to_str().unwrap(), Some("wrong")).is_err());
    }

    #[test]
    fn missing_key_file_reports_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.ppk");
        match load_private_key(path.to_str().unwrap(), None) {
            Err(SshError::KeyNotFound(_)) => {}
            other => panic!("expected KeyNotFound, got {other:?}"),
        }
    }
}
