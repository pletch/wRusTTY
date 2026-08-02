use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::ssh_key::HashAlg;
use russh::keys::{decode_secret_key, PrivateKey};
use russh::{client, ChannelMsg, Disconnect};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Mutex};
use wr_core::{ConnectionEvent, ConnectionStatus, Connector, Session};

use crate::config::{AuthMethod, SshConfig};
use crate::error::SshError;
use crate::forward::{self, ForwardHandle, ForwardSpec};
use crate::handler::{ClientHandler, HostKeyVerifier};
use crate::known_hosts::KnownHostsStore;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);

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
        initial_cols: u16,
        initial_rows: u16,
    ) -> std::io::Result<Self> {
        let known_hosts = KnownHostsStore::load(known_hosts_path)?;
        Ok(Self {
            config,
            known_hosts: Arc::new(Mutex::new(known_hosts)),
            verifier,
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
        self.sftp = tokio::sync::OnceCell::new();
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
                    self.remote_forwards.clone(),
                )
                .await?
            }
            Some(jump_config) => {
                // The jump hop gets its own throwaway remote-forward
                // registry — incoming forwarded-tcpip requests are only
                // meaningful on the final hop, which is what
                // `self.remote_forwards` is shared with.
                let jump_handle = connect_direct(
                    jump_config,
                    self.known_hosts.clone(),
                    self.verifier.clone(),
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
                if writer.write_all(&data).await.is_err() {
                    break;
                }
                if writer.flush().await.is_err() {
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
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                let _ = output_events.send(ConnectionEvent::Status(ConnectionStatus::Disconnected)).await;
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
    remote_forwards: forward::RemoteForwardRegistry,
) -> Result<client::Handle<ClientHandler>, SshError> {
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

    let connect_fut = client::connect(ssh_config, (config.host.as_str(), config.port), handler);
    await_handshake(config, connect_fut, verify_started).await
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
    await_handshake(config, connect_fut, verify_started).await
}

/// Shared by `connect_direct` and `connect_via_stream`: waits for the
/// handshake future to resolve (bounded by `CONNECT_TIMEOUT`, except while
/// waiting on a human to accept/reject an unknown host key — see
/// `verify_started`), then authenticates (bounded by `AUTH_TIMEOUT`).
async fn await_handshake<F>(
    config: &SshConfig,
    connect_fut: F,
    verify_started: Arc<tokio::sync::Notify>,
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

    // No prior art for how long auth should take, but unlike host-key
    // verification this isn't waiting on a human — a real hang here (bad
    // server, network stall) should surface as an error rather than
    // leaving the UI stuck on "Connecting..." forever.
    tokio::time::timeout(AUTH_TIMEOUT, authenticate(config, &mut handle))
        .await
        .map_err(|_| SshError::AuthTimeout {
            host: config.host.clone(),
            port: config.port,
        })??;

    Ok(handle)
}

async fn authenticate(
    config: &SshConfig,
    handle: &mut client::Handle<ClientHandler>,
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
            // Wired up to a real prompt round-trip once the UI layer
            // (task #10) can relay server prompts to the user.
            return Err(SshError::AuthFailed);
        }
        AuthMethod::Agent => return authenticate_with_agent(handle, &config.username).await,
    };

    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { .. } => Err(SshError::AuthFailed),
    }
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
