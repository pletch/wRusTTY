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
        })
    }

    /// Starts a local, remote, or dynamic (SOCKS5) port forward on the
    /// active connection. Must be called after `connect()` has succeeded.
    pub async fn add_forward(&self, spec: ForwardSpec) -> Result<ForwardHandle, SshError> {
        let handle = self.handle.clone().ok_or(SshError::NotConnected)?;
        forward::start(handle, self.remote_forwards.clone(), spec).await
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

        let handler = ClientHandler::new(
            self.config.host.clone(),
            self.config.port,
            self.known_hosts.clone(),
            self.verifier.clone(),
            self.remote_forwards.clone(),
        );

        let connect_fut = client::connect(
            Arc::new(ssh_config),
            (self.config.host.as_str(), self.config.port),
            handler,
        );

        let mut handle = tokio::time::timeout(CONNECT_TIMEOUT, connect_fut)
            .await
            .map_err(|_| SshError::Timeout {
                host: self.config.host.clone(),
                port: self.config.port,
            })??;

        self.authenticate(&mut handle).await?;

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
                let expanded = expand_tilde(key_path);
                if !expanded.exists() {
                    return Err(SshError::KeyNotFound(key_path.clone()));
                }
                let key_content = std::fs::read_to_string(&expanded)?.replace("\r\n", "\n");
                let key: PrivateKey = decode_secret_key(&key_content, passphrase.as_deref())
                    .map_err(|e| SshError::KeyLoad(e.to_string()))?;

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

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}
