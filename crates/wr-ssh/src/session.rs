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

/// How many prompt rounds a keyboard-interactive exchange may take before it
/// is treated as a server that will never finish. Generous against real
/// stacks — password plus a 2FA challenge plus a retry or two is under five —
/// and the only thing standing between a misbehaving server and a handshake
/// that prompts forever.
const MAX_AUTH_ROUNDS: usize = 32;

/// Everything needed to open an SSH session, before one exists.
///
/// Separate from `SshSession` because the handshake here is the longest of
/// any transport — TCP connect, KEX, auth, and a host-key prompt that blocks
/// on a human reading a fingerprint. Driving it against a value nothing else
/// can reach is what keeps a resize or a keystroke from queueing behind it.
/// See `wr_core::Connector`.
pub struct SshConnector {
    config: SshConfig,
    known_hosts: Arc<Mutex<KnownHostsStore>>,
    verifier: Arc<dyn HostKeyVerifier>,
    /// Answers the server's own auth questions, for keyboard-interactive.
    /// Second of the two ways this handshake blocks on a human, alongside
    /// `verifier` — see `crate::prompt`.
    prompter: Arc<dyn AuthPrompter>,
    remote_forwards: forward::RemoteForwardRegistry,
    initial_cols: u16,
    initial_rows: u16,
}

/// A live SSH session: the authenticated transport, its PTY channel, and the
/// two channels feeding it.
pub struct SshSession {
    handle: Option<Arc<client::Handle<ClientHandler>>>,
    /// `Option` only so `disconnect` can drop them, which is what ends the
    /// pump tasks. Always `Some` on a freshly connected session.
    input_tx: Option<mpsc::Sender<Vec<u8>>>,
    resize_tx: Option<mpsc::Sender<(u16, u16)>>,
    remote_forwards: forward::RemoteForwardRegistry,
    // Opened lazily on first use and reused for the connection's lifetime —
    // a `OnceCell` keeps this on a shared `&self`, matching `add_forward`'s
    // shape, rather than requiring `&mut self` everywhere SFTP is touched.
    sftp: tokio::sync::OnceCell<Arc<wr_sftp::SftpClient>>,
    // A second, identical channel used only by bulk transfers. See
    // `get_or_open_transfer_sftp` for why there are two.
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

    /// A handle for running things as root on this connection.
    ///
    /// Returns rather than borrows, for the same reason `get_or_open_sftp`
    /// hands back an `Arc`: elevated work outlives the session mutex by a long
    /// way — a privileged helper stays open for the life of an edit — and
    /// holding the lock for that would stop every keystroke in the pane.
    ///
    /// Opening no channel here is deliberate. Whether a host needs a password
    /// at all is only knowable by trying, so the decision belongs to the caller
    /// that can put a dialog in front of the user. See [`crate::sudo`].
    pub fn sudo(&self) -> Result<crate::sudo::SudoRunner, SshError> {
        let handle = self.handle.clone().ok_or(SshError::NotConnected)?;
        Ok(crate::sudo::SudoRunner::new(handle))
    }

    /// Run one command on a channel of its own and collect what it prints.
    ///
    /// The same move as `get_or_open_transfer_sftp` below — `channel_open_session`
    /// on the connection that is already up — but requesting `exec` instead of
    /// a subsystem, and closing the channel when the command is done. No second
    /// TCP connection, no second authentication, nothing in the server's auth
    /// log: to sshd this is one more channel on an established session.
    ///
    /// Everything about it is bounded, because the caller is asking a machine
    /// it does not control to print something:
    ///
    ///   - **`max_bytes`** caps what is collected. Past it, collection stops
    ///     and the channel is dropped; the result is whatever arrived, which
    ///     the caller can use or discard.
    ///   - **`timeout`** caps the wait, for a host that accepts the channel and
    ///     then says nothing. Hitting it is an error rather than a short read:
    ///     a truncated answer that *looks* complete is worse than none.
    ///   - stderr is discarded rather than merged. The callers here want the
    ///     command's output, and a shell that prints a warning to stderr would
    ///     otherwise have it spliced into the middle of that.
    ///
    /// Not every host allows this. `ForceCommand`, a restricted shell, and any
    /// appliance whose "shell" is its own CLI will refuse the request or answer
    /// something unusable — so callers must treat failure as ordinary.
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
                        // Take only up to the cap, then stop reading. Breaking
                        // here drops the channel, which tells the far end to
                        // stop rather than letting it keep sending into a
                        // buffer nobody is growing.
                        let room = max_bytes.saturating_sub(out.len());
                        if room == 0 {
                            break;
                        }
                        out.extend_from_slice(&data[..data.len().min(room)]);
                        if out.len() >= max_bytes {
                            break;
                        }
                    }
                    // The command finished, or the transport went away. Either
                    // way what has arrived is all there is.
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    // Exit status, stderr, window adjustments: nothing this
                    // needs. stderr in particular is deliberately dropped.
                    _ => {}
                }
            }
            Ok::<_, SshError>(out)
        })
        .await
        .map_err(|_| SshError::ExecTimeout)?
    }

    /// The same thing again, on a channel of its own, for bulk transfers.
    ///
    /// One SFTP client serialises everything asked of it: requests queue behind
    /// whatever is in flight. That is invisible while every operation is a
    /// directory listing or a few-kilobyte config file, and intolerable the
    /// moment a download runs for a minute — the Files panel would stop
    /// responding for the length of the transfer, including the cancel button's
    /// own refresh afterwards.
    ///
    /// So browsing and editing keep `get_or_open_sftp`, and anything with a
    /// progress bar comes here. Both are lazy, so a session that never
    /// transfers anything never pays for the second channel. Opening one is a
    /// `channel_open_session` plus a subsystem request on the connection that
    /// is already up — cheap now, and much harder to retrofit once the UI
    /// assumes it can browse mid-transfer.
    pub async fn get_or_open_transfer_sftp(&self) -> Result<Arc<wr_sftp::SftpClient>, SshError> {
        Self::get_or_open(&self.transfer_sftp, self.handle.clone()).await
    }

    async fn get_or_open(
        cell: &tokio::sync::OnceCell<Arc<wr_sftp::SftpClient>>,
        handle: Option<Arc<client::Handle<ClientHandler>>>,
    ) -> Result<Arc<wr_sftp::SftpClient>, SshError> {
        cell.get_or_try_init(|| async {
            // Mirrors the existing `request_pty`/`request_shell` sequence in
            // `connect_inner` — a fresh independent channel off the same live
            // connection, requesting a subsystem instead of a shell.
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

    /// The rule is not "did this fail" but "does trying again cost anything".
    ///
    /// Every rejected credential spends one of the server's `MaxAuthTries`
    /// (OpenSSH allows 6 by default), so a background retry loop would lock
    /// the account out on the user's behalf without ever showing them why —
    /// and would do it while nobody is watching, which is the whole point of
    /// auto-reconnect. A rejected host key is worse: retrying past it is
    /// exactly the thing the prompt exists to prevent.
    ///
    /// Timeouts are the other way round. `Timeout` and `AuthTimeout` both mean
    /// the far side went quiet, which is a network symptom rather than a
    /// verdict on the credential, and is precisely the case auto-reconnect
    /// exists for.
    fn retryable(error: &SshError) -> bool {
        !matches!(
            error,
            SshError::HostKeyRejected { .. }
                | SshError::AuthFailed
                | SshError::AuthCancelled
                | SshError::AuthPartial { .. }
                | SshError::AuthMethodUnavailable { .. }
                | SshError::AuthTooManyRounds { .. }
                // Neither of these is fixed by waiting: the agent is not
                // running, or it is and the server refused everything in it.
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
        // Both cells, not just the first. `transfer_sftp` was missed here, and
        // was harmless only for as long as a disconnected session was always
        // on its way to being dropped: a cell still holding a client for a
        // channel on a dead connection hands that same dead channel back
        // forever. The moment a session id survives its transport — which is
        // what auto-reconnect is — that becomes a live bug.
        self.sftp = tokio::sync::OnceCell::new();
        self.transfer_sftp = tokio::sync::OnceCell::new();
        if let Some(handle) = self.handle.take() {
            // Dropping input/resize senders stops the pumping tasks; ignore
            // errors here since the transport may already be gone.
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
                    self.known_hosts.clone(),
                    self.verifier.clone(),
                    self.prompter.clone(),
                    false,
                    self.remote_forwards.clone(),
                )
                .await?
            }
            Some(jump_config) => {
                // The jump hop gets its own throwaway remote-forward
                // registry — incoming forwarded-tcpip requests are only
                // meaningful on the final hop, which is what
                // `self.remote_forwards` is shared with.
                //
                // It does share the prompter, flagged `is_jump` so a prompt
                // can say which hop is asking. Both hops can run their own
                // interactive exchange, and "Password:" with no host beside
                // it is how a target's password gets typed into a bastion.
                let jump_handle = connect_direct(
                    jump_config,
                    self.known_hosts.clone(),
                    self.verifier.clone(),
                    self.prompter.clone(),
                    true,
                    Arc::new(Mutex::new(HashMap::new())),
                )
                .await?;

                // Same primitive as an SSH port forward (see forward.rs): a
                // `direct-tcpip` channel on the jump host's connection,
                // piped into the target's own SSH handshake instead of a
                // fresh TCP socket — the standard ProxyJump shape.
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
        // Advertise 24-bit colour. The terminal has always rendered it —
        // the engine handles `ESC[38;2;R;G;Bm` directly — but remote programs
        // won't *emit* it unless something says the terminal can: vim,
        // neovim, tmux, bat and friends all key off `COLORTERM`, and `TERM`
        // alone can't express it (`xterm-256color` says 256 and means it).
        //
        // Sent with `want_reply: false` because this legitimately fails on
        // most servers and must not be treated as an error: sshd only honours
        // variables listed in `AcceptEnv`, which defaults to `LANG LC_*`. It
        // costs one message to try and silently does nothing when refused;
        // where it matters, the fix is server-side (`AcceptEnv COLORTERM`),
        // in the remote shell's rc, or `TERM=xterm-direct`.
        //
        // Must precede `request_shell` — environment set after the shell
        // starts cannot reach it.
        let _ = channel.set_env(false, "COLORTERM", "truecolor").await;
        // Advertise progress reporting — OSC 9;4, the sequence that spins a
        // pane's marker while a program works (see lib/appProgress.ts).
        //
        // `ConEmuANSI` rather than a name of our own because programs do not
        // probe for this capability, they recognise terminals by name from a
        // fixed list. Claude Code is the concrete case: it emits OSC 9;4 only
        // when it sees `ConEmuANSI`/`ConEmuPID`/`ConEmuTask`, or a
        // `TERM_PROGRAM` of `ghostty` >= 1.2.0 or `iTerm.app` >= 3.6.6 — and
        // it explicitly *disables* progress under `WT_SESSION`. With none of
        // those set it never emits, whatever its own progress setting says.
        //
        // Claiming ConEmu's name is a claim about the protocol, not the
        // program: OSC 9;4 is ConEmu's, and this app implements it. The
        // alternative — impersonating Ghostty or iTerm2 — would also opt us
        // into their unrelated private sequences, which this app does not
        // implement. Nothing else keys off `ConEmuANSI` in a way that changes
        // rendering, so the blast radius is the capability itself.
        //
        // Same best-effort caveat as `COLORTERM` above, and it bites harder
        // here: a default sshd drops both, so the reliable fix is a line in
        // the remote shell's rc. See docs/SHELL_INTEGRATION.md.
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
                // Paced rather than written straight through -- see
                // `wr_core::WRITE_CHUNK`. Here rather than at the paste site
                // because every route to the wire passes through this one
                // task: the three paste shortcuts, a broadcast fan-out, a drop
                // upload. One of them being missed is exactly how this would
                // come back.
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
                            // The far end finished — the shell exited, or the
                            // server closed the channel. Reconnecting after
                            // this would fight the user.
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                                let _ = output_events.send(ConnectionEvent::Status(
                                    ConnectionStatus::Disconnected(DisconnectKind::Closed),
                                )).await;
                                break;
                            }
                            // `wait()` yielding nothing is the *transport*
                            // having gone: the russh session task ended under
                            // us, which is what a dropped link or an expired
                            // keepalive looks like from here. Nobody asked for
                            // it, so it is the one worth undoing.
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

/// Connects and fully authenticates a fresh TCP connection to `config`,
/// sharing `known_hosts`/`verifier` (host-key trust) and `remote_forwards`
/// (which registry incoming `forwarded-tcpip` requests get matched against)
/// with whatever's driving this hop. Used directly for a plain connection,
/// and as the first hop of a jump connection (see `connect_via_stream`).
async fn connect_direct(
    config: &SshConfig,
    known_hosts: Arc<Mutex<KnownHostsStore>>,
    verifier: Arc<dyn HostKeyVerifier>,
    prompter: Arc<dyn AuthPrompter>,
    is_jump: bool,
    remote_forwards: forward::RemoteForwardRegistry,
) -> Result<client::Handle<ClientHandler>, SshError> {
    let ssh_config = Arc::new(client::Config {
        keepalive_interval: config.keepalive_interval(),
        keepalive_max: crate::config::KEEPALIVE_MAX,
        // Nagle's algorithm off. russh leaves it *on* by default; OpenSSH and
        // PuTTY both turn it off for an interactive session, and this is one.
        // A keystroke is a packet of a few bytes, and under Nagle it waits in
        // the kernel until the previous segment is acknowledged -- against a
        // peer doing delayed ACK, up to ~40ms added to every character on top
        // of the round trip. The remote tty is what echoes what you type, so
        // that delay lands squarely on the thing the connection exists for.
        //
        // Only meaningful here. russh applies this to a real socket, and
        // `connect_via_stream`'s stream is a channel on a jump hop rather
        // than one. The jump hop's own socket is opened by this function, so
        // a jump connection is covered by the first hop setting it.
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

    let connect_fut = client::connect(ssh_config, (config.host.as_str(), config.port), handler);
    await_handshake(config, connect_fut, verify_started, prompter, is_jump).await
}

/// Same as `connect_direct`, but runs the handshake over an already-open
/// stream rather than opening a fresh TCP socket — the `direct-tcpip`
/// channel from a jump hop, in this crate's case. This is the whole trick
/// behind ProxyJump: `russh::client::connect_stream` doesn't care whether
/// its stream is a raw TCP socket or a channel tunneled through another SSH
/// connection.
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
    let ssh_config = Arc::new(client::Config {
        keepalive_interval: config.keepalive_interval(),
        keepalive_max: crate::config::KEEPALIVE_MAX,
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
    // Always the final hop: a stream only exists because a jump hop opened
    // it, so this is the destination the user actually asked for.
    await_handshake(config, connect_fut, verify_started, prompter, false).await
}

/// Shared by `connect_direct` and `connect_via_stream`: waits for the
/// handshake future to resolve (bounded by `CONNECT_TIMEOUT`, except while
/// waiting on a human to accept/reject an unknown host key — see
/// `verify_started`), then authenticates (bounded by `AUTH_TIMEOUT`).
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

    // A real hang here (bad server, network stall) should surface as an error
    // rather than leaving the UI stuck on "Connecting..." forever. But since
    // keyboard-interactive, auth *can* be waiting on a human — the assumption
    // that only host-key verification does no longer holds, and a flat
    // `timeout` around the whole exchange would fail every 2FA login in the
    // time it takes to read a push notification.
    //
    // So the budget bounds *server* silence rather than the exchange: each
    // expiry is forgiven while a prompt is on screen, and once more if one was
    // answered during the window just elapsed. What that buys is a full
    // `AUTH_TIMEOUT` of quiet after the user's last keystroke before the
    // connection is declared dead — at the cost of a genuinely dead server
    // taking up to two windows to be called, but only on a connection that
    // prompted at all.
    // Scoped so the pinned future — and with it the `&mut handle` borrow it
    // holds — is dropped before the handle is returned.
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

/// Lets `await_handshake`'s timeout tell "the server is not answering" apart
/// from "a person is reading a fingerprint off their phone", without either
/// side needing to know how the other measures time.
///
/// Two counters rather than one flag because the flag alone is only true
/// *during* a prompt: a user who answers at second 14 of a 15-second window
/// would leave a bare flag false again by the time it is read, and the
/// connection would be failed after one second of server silence rather than
/// fifteen.
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

    /// Whether an elapsed timeout window should be forgiven rather than
    /// failing the connection, advancing `seen_answers` to this moment when it
    /// is. Called once per expiry; `false` means the server has been silent for
    /// a full window with no human involved, which is the case the timeout
    /// exists for.
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

/// Drives an RFC 4256 keyboard-interactive exchange, relaying each round of
/// the server's questions to `prompter` and its answers back.
///
/// Unlike every other method here this is a loop, because the server decides
/// how many rounds there are and what each one asks: a plain password host
/// sends one, a PAM stack with 2FA sends "Password:" and then "Verification
/// code:" as two separate rounds, and a wrong answer can be followed by
/// another attempt rather than a failure. Nothing about that is knowable
/// before the exchange starts, which is the whole reason this method exists.
async fn authenticate_keyboard_interactive(
    config: &SshConfig,
    handle: &mut client::Handle<ClientHandler>,
    prompter: Arc<dyn AuthPrompter>,
    is_jump: bool,
    progress: &AuthProgress,
) -> Result<(), SshError> {
    use russh::client::KeyboardInteractiveAuthResponse as Response;

    // No submethod hint: it's a request for a *preferred* flavour that
    // servers are free to ignore, and there is nothing to prefer here.
    let mut response = handle
        .authenticate_keyboard_interactive_start(config.username.clone(), None::<String>)
        .await?;

    // Whether the server has asked the user anything yet. Separates "this
    // server won't do keyboard-interactive" from "that was the wrong answer",
    // which arrive as the same `Failure`.
    let mut asked_anything = false;

    for _ in 0..MAX_AUTH_ROUNDS {
        let (name, instructions, fields) = match response {
            Response::Success => return Ok(()),
            // Accepted, but the server's policy wants a second method on top.
            // Only this one method is driven here, so there is nothing further
            // to offer — but the credential was right, and an "authentication
            // failed" here would send the user to change a working password.
            Response::Failure {
                partial_success: true,
                remaining_methods,
            } => {
                return Err(SshError::AuthPartial {
                    remaining: render_methods(&remaining_methods),
                })
            }
            // A server that does not do keyboard-interactive at all refuses
            // the opening request, before asking anything — which is not a
            // rejected credential, because nothing was offered yet. This is
            // the common case, not an exotic one: Debian and Ubuntu ship
            // `KbdInteractiveAuthentication no` with `PasswordAuthentication
            // yes`, so the whole method is off on a large share of hosts.
            //
            // The rejection carries the methods that *would* work, so when a
            // password is among them, ask for one and use it. "Prompt me"
            // means asking the user at connect time rather than storing a
            // secret; which wire method carries the answer is the server's
            // business, not something the user chose.
            //
            // Only before the first question, and only when the server named
            // `password` itself. A failure *after* a round is a wrong answer,
            // and retrying it as a password would spend another of the
            // server's limited attempts to ask the same thing again.
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
            // A round with nothing to fill in is legal, and is the server
            // talking rather than asking — an expiry notice, a policy banner.
            // It needs an (empty) response to move the exchange along, but
            // putting a dialog on screen with no field and one OK button
            // trains people to dismiss this whole class of prompt unread.
            Zeroizing::new(Vec::new())
        } else {
            asked_anything = true;
            // The one place auth blocks on a human. Bracketed so the
            // handshake's timeout can tell this apart from a stalled server.
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
            // Cancelling abandons the connection rather than sending blanks:
            // an empty answer is a *wrong* answer, and burns one of the
            // server's limited attempts on the user's behalf.
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

/// Asks for a password and authenticates with the plain `password` method.
///
/// The fallback for a server that refuses keyboard-interactive but takes a
/// password — which is most of them, since Debian and Ubuntu ship
/// `KbdInteractiveAuthentication no` by default. From the user's side this is
/// indistinguishable from the interactive path, and it should be: "Prompt me"
/// is a statement about not storing the secret, not about a wire method.
///
/// One attempt. The server counts every failure against `MaxAuthTries`
/// (OpenSSH defaults to 6, and each rejection here spends one), so silently
/// re-prompting on a typo would burn that budget invisibly and lock the user
/// out of the retry they would have made themselves.
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
            // Worded like the prompt a server would have sent, because to the
            // user this *is* that prompt.
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

/// Renders a server's list of acceptable auth methods for an error message.
/// Empty lists happen and must not render as an empty string, which reads as
/// a bug in us rather than a statement about the server.
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

/// Connects to whichever SSH agent is running and tries each identity it
/// holds until one authenticates.
///
/// Both Windows agents are attempted because users routinely run either, and
/// often don't know which: the OpenSSH agent ships as a Windows service and
/// speaks over a named pipe, while Pageant is what anyone arriving from
/// PuTTY already has open. Trying both means "your existing keys work"
/// without asking the user to classify their own setup.
///
/// Keys are offered in the order the agent lists them. Servers commonly cap
/// authentication attempts (OpenSSH's `MaxAuthTries` defaults to 6), so an
/// agent loaded with many keys can exhaust that budget before reaching the
/// right one and fail with what looks like a rejected key — hence the
/// distinct error rather than a bare `AuthFailed`.
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

    // Elsewhere the convention is a single agent addressed by SSH_AUTH_SOCK.
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
            // Certificate identities need `authenticate_certificate_with`,
            // which is a different flow; skip rather than mis-offer them.
            continue;
        };
        // The agent, not this process, holds the private half and produces
        // the signature — `agent` is passed as the `Signer`.
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

/// PuTTY key files open with `PuTTY-User-Key-File-2:` or `-3:` — distinct
/// enough from every OpenSSH/PEM header (`-----BEGIN ... PRIVATE KEY-----`
/// or `ssh-...`) that a prefix check is all the dispatch needs.
fn is_ppk(content: &str) -> bool {
    content.trim_start().starts_with("PuTTY-User-Key-File-")
}

/// Loads a private key from disk, dispatching to PuTTY's `.ppk` decoder or
/// OpenSSH/PEM's depending on the file's own header. PuTTY's format is
/// structurally unrelated to OpenSSH/PEM (its own header, section layout,
/// and — for v3 — Argon2id KDF), so it needs its own decoder rather than
/// falling out of `decode_secret_key`. russh already pulls in `ssh-key`
/// with the "ppk" feature enabled, so both v2 and v3, encrypted or not,
/// are supported for free via `PrivateKey::from_ppk`. Pulled out of
/// `authenticate` so it's unit-testable without a live connection.
fn load_private_key(key_path: &str, passphrase: Option<&str>) -> Result<PrivateKey, SshError> {
    let expanded = expand_tilde(key_path);
    if !expanded.exists() {
        return Err(SshError::KeyNotFound(key_path.to_string()));
    }
    let key_content = std::fs::read_to_string(&expanded)?.replace("\r\n", "\n");
    parse_private_key(&key_content, passphrase)
}

/// Parses already-in-hand key content (from disk or from the vault),
/// dispatching to PuTTY's `.ppk` decoder or OpenSSH/PEM's depending on the
/// content's own header. Public so `src-tauri`'s vault-key-import command
/// can validate a key (and its passphrase) before storing it, without this
/// crate needing to know anything about the vault.
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

/// The rules `await_handshake`'s auth timeout runs on. Worth pinning
/// separately from a live handshake because getting these wrong fails
/// silently in one direction (every 2FA login dies at 15 seconds) and
/// invisibly in the other (a dead server never times out at all).
#[cfg(test)]
mod auth_timeout_tests {
    use super::*;

    /// The case the timeout exists for: nobody was asked anything, the server
    /// simply stopped talking.
    #[test]
    fn a_silent_server_with_no_prompt_is_not_forgiven() {
        let progress = AuthProgress::default();
        let mut seen = progress.answers();
        assert!(!progress.should_extend(&mut seen));
    }

    /// A dialog is on screen — the "server" is us, waiting on a person.
    #[test]
    fn a_prompt_on_screen_is_forgiven_indefinitely() {
        let progress = AuthProgress::default();
        let mut seen = progress.answers();
        progress.begin_prompt();
        for _ in 0..100 {
            assert!(progress.should_extend(&mut seen));
        }
    }

    /// The reason there is a counter and not just a flag: answering at second
    /// 14 of a 15-second window leaves the flag false again by the time the
    /// window is read, and the connection would be failed after one second of
    /// server silence rather than a full window of it.
    #[test]
    fn answering_late_in_a_window_still_buys_a_full_window() {
        let progress = AuthProgress::default();
        let mut seen = progress.answers();
        progress.begin_prompt();
        progress.end_prompt();
        assert!(progress.should_extend(&mut seen));
    }

    /// ...but only one. A server that goes quiet after the user has answered
    /// must still be called dead, or a cancelled-looking connection hangs
    /// forever.
    #[test]
    fn silence_after_an_answer_is_forgiven_once_and_then_fails() {
        let progress = AuthProgress::default();
        let mut seen = progress.answers();
        progress.begin_prompt();
        progress.end_prompt();
        assert!(progress.should_extend(&mut seen));
        assert!(!progress.should_extend(&mut seen));
    }

    /// Each round of a multi-step exchange gets its own grace, so a password
    /// followed by a 2FA code doesn't spend a budget the first round set.
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

    // Real PuTTY-generated key files, borrowed from ssh-key's own test
    // suite (Apache-2.0/MIT) — these exercise the actual PuTTY-3 + Argon2id
    // decode path, not just our own dispatch logic.
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
