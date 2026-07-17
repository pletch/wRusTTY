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
use wr_core::{Connection, ConnectionEvent, ConnectionStatus};

use crate::config::{AuthMethod, SshConfig};
use crate::error::SshError;
use crate::forward::{self, ForwardHandle, ForwardSpec};
use crate::handler::{ClientHandler, HostKeyVerifier};
use crate::known_hosts::KnownHostsStore;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(60);
const KEEPALIVE_MAX: usize = 3;

/// A live (or not-yet-connected) SSH session: transport, auth, PTY channel.
/// Implements `wr_core::Connection` so the tab/session layer can drive it
/// without knowing it's SSH specifically.
pub struct SshSession {
    config: SshConfig,
    known_hosts: Arc<Mutex<KnownHostsStore>>,
    verifier: Arc<dyn HostKeyVerifier>,
    handle: Option<Arc<client::Handle<ClientHandler>>>,
    input_tx: Option<mpsc::Sender<Vec<u8>>>,
    resize_tx: Option<mpsc::Sender<(u16, u16)>>,
    remote_forwards: forward::RemoteForwardRegistry,
    // Opened lazily on first use and reused for the connection's lifetime —
    // a `OnceCell` keeps this on a shared `&self`, matching `add_forward`'s
    // shape, rather than requiring `&mut self` everywhere SFTP is touched.
    sftp: tokio::sync::OnceCell<Arc<wr_sftp::SftpClient>>,
}

impl SshSession {
    pub fn new(
        config: SshConfig,
        known_hosts_path: impl Into<PathBuf>,
        verifier: Arc<dyn HostKeyVerifier>,
    ) -> std::io::Result<Self> {
        let known_hosts = KnownHostsStore::load(known_hosts_path)?;
        Ok(Self {
            config,
            known_hosts: Arc::new(Mutex::new(known_hosts)),
            verifier,
            handle: None,
            input_tx: None,
            resize_tx: None,
            remote_forwards: Arc::new(Mutex::new(HashMap::new())),
            sftp: tokio::sync::OnceCell::new(),
        })
    }

    /// Starts a local, remote, or dynamic (SOCKS5) port forward on the
    /// active connection. Must be called after `connect()` has succeeded.
    pub async fn add_forward(&self, spec: ForwardSpec) -> Result<ForwardHandle, SshError> {
        let handle = self.handle.clone().ok_or(SshError::NotConnected)?;
        forward::start(handle, self.remote_forwards.clone(), spec).await
    }

    /// Returns the shared SFTP client for this connection, opening the
    /// subsystem channel on first use. Mirrors the existing
    /// `request_pty`/`request_shell` sequence in `connect_inner` — a fresh
    /// independent channel off the same live connection, requesting a
    /// subsystem instead of a shell.
    pub async fn get_or_open_sftp(&self) -> Result<Arc<wr_sftp::SftpClient>, SshError> {
        self.sftp
            .get_or_try_init(|| async {
                let handle = self.handle.clone().ok_or(SshError::NotConnected)?;
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
impl Connection for SshSession {
    type Error = SshError;

    async fn connect(
        &mut self,
        events: mpsc::UnboundedSender<ConnectionEvent>,
    ) -> Result<(), SshError> {
        let _ = events.send(ConnectionEvent::Status(ConnectionStatus::Connecting));

        let host = self.config.host.clone();
        let port = self.config.port;

        let result = self.connect_inner(&events).await;

        match &result {
            Ok(()) => {
                let _ = events.send(ConnectionEvent::Status(ConnectionStatus::Connected));
            }
            Err(e) => {
                let _ = events.send(ConnectionEvent::Status(ConnectionStatus::Failed(
                    e.to_string(),
                )));
                tracing::warn!(%host, port, error = %e, "ssh connect failed");
            }
        }

        result
    }

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

impl SshSession {
    async fn connect_inner(
        &mut self,
        events: &mpsc::UnboundedSender<ConnectionEvent>,
    ) -> Result<(), SshError> {
        let ssh_config = client::Config {
            keepalive_interval: Some(KEEPALIVE_INTERVAL),
            keepalive_max: KEEPALIVE_MAX,
            ..Default::default()
        };

        let verify_started = Arc::new(tokio::sync::Notify::new());
        let handler = ClientHandler::new(
            self.config.host.clone(),
            self.config.port,
            self.known_hosts.clone(),
            self.verifier.clone(),
            self.remote_forwards.clone(),
            verify_started.clone(),
        );

        let connect_fut = client::connect(
            Arc::new(ssh_config),
            (self.config.host.as_str(), self.config.port),
            handler,
        );
        tokio::pin!(connect_fut);

        // CONNECT_TIMEOUT bounds the network-level connect + key exchange —
        // it must stop counting once we're waiting on a human to accept or
        // reject a host key (see ClientHandler::verify_started), or every
        // first-time connection to an unknown host would time out before
        // anyone had a chance to read the fingerprint and click Accept.
        let mut awaiting_verification = false;
        let mut handle = loop {
            tokio::select! {
                result = &mut connect_fut => break result?,
                () = tokio::time::sleep(CONNECT_TIMEOUT), if !awaiting_verification => {
                    return Err(SshError::Timeout {
                        host: self.config.host.clone(),
                        port: self.config.port,
                    });
                }
                () = verify_started.notified(), if !awaiting_verification => {
                    awaiting_verification = true;
                }
            }
        };

        // No prior art for how long auth should take, but unlike host-key
        // verification this isn't waiting on a human — a real hang here
        // (bad server, network stall) should surface as an error rather
        // than leaving the UI stuck on "Connecting..." forever.
        tokio::time::timeout(AUTH_TIMEOUT, self.authenticate(&mut handle))
            .await
            .map_err(|_| SshError::AuthTimeout {
                host: self.config.host.clone(),
                port: self.config.port,
            })??;

        let channel = handle.channel_open_session().await?;
        channel
            .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
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
                                if output_events.send(ConnectionEvent::Data(data.to_vec())).is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                let _ = output_events.send(ConnectionEvent::Status(ConnectionStatus::Disconnected));
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

        self.handle = Some(Arc::new(handle));
        self.input_tx = Some(input_tx);
        self.resize_tx = Some(resize_tx);
        Ok(())
    }

    async fn authenticate(
        &self,
        handle: &mut client::Handle<ClientHandler>,
    ) -> Result<(), SshError> {
        use russh::client::AuthResult;

        let result = match &self.config.auth {
            AuthMethod::Password { password } => {
                handle
                    .authenticate_password(&self.config.username, password)
                    .await?
            }
            AuthMethod::PublicKey {
                key_path,
                passphrase,
            } => {
                let key = load_private_key(key_path, passphrase.as_deref())?;

                handle
                    .authenticate_publickey(
                        &self.config.username,
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
                        &self.config.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha256)),
                    )
                    .await?
            }
            AuthMethod::KeyboardInteractive => {
                // Wired up to a real prompt round-trip once the UI layer
                // (task #10) can relay server prompts to the user.
                return Err(SshError::AuthFailed);
            }
        };

        match result {
            AuthResult::Success => Ok(()),
            AuthResult::Failure { .. } => Err(SshError::AuthFailed),
        }
    }
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
