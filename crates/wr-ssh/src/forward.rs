//! Port forwarding: local, remote, and dynamic (SOCKS5). All three share
//! the same underlying primitive — an SSH `direct-tcpip` channel piped to a
//! local TCP stream — they differ only in how the local TCP connection and
//! the forwarding target are decided.

use std::collections::HashMap;
use std::sync::Arc;

use russh::client::Handle;
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::error::SshError;
use crate::handler::ClientHandler;
use crate::socks;

/// Maps a server-side remote-forward bind (address, port) to the local
/// target it should be piped to. Shared between `SshSession` (which
/// registers entries when a remote forward is added) and `ClientHandler`
/// (which consults it when the server opens a `forwarded-tcpip` channel).
pub type RemoteForwardRegistry = Arc<Mutex<HashMap<(String, u16), (String, u16)>>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ForwardSpec {
    /// Listen locally on `bind_host:bind_port`; each connection is tunneled
    /// to `target_host:target_port` as seen from the server.
    Local {
        bind_host: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    },
    /// Ask the server to listen on `bind_host:bind_port`; each connection
    /// it accepts is tunneled back to `target_host:target_port` as seen
    /// from this client.
    Remote {
        bind_host: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    },
    /// Listen locally on `bind_host:bind_port` as a SOCKS5 proxy; the
    /// target is whatever each connecting client asks to CONNECT to.
    Dynamic { bind_host: String, bind_port: u16 },
}

pub struct ForwardHandle {
    accept_task: JoinHandle<()>,
    handle: Arc<Handle<ClientHandler>>,
    /// Set for `Remote` forwards: the (address, port) to hand back to
    /// `cancel_tcpip_forward` when stopping, and the registry key to remove.
    remote: Option<(String, u16)>,
    registry: Option<RemoteForwardRegistry>,
}

impl ForwardHandle {
    pub async fn stop(self) -> Result<(), SshError> {
        self.accept_task.abort();
        if let Some((addr, port)) = self.remote {
            if let Some(registry) = &self.registry {
                registry.lock().await.remove(&(addr.clone(), port));
            }
            self.handle.cancel_tcpip_forward(addr, port as u32).await?;
        }
        Ok(())
    }
}

pub async fn start(
    handle: Arc<Handle<ClientHandler>>,
    registry: RemoteForwardRegistry,
    spec: ForwardSpec,
) -> Result<ForwardHandle, SshError> {
    match spec {
        ForwardSpec::Local {
            bind_host,
            bind_port,
            target_host,
            target_port,
        } => start_local(handle, bind_host, bind_port, target_host, target_port).await,
        ForwardSpec::Dynamic {
            bind_host,
            bind_port,
        } => start_dynamic(handle, bind_host, bind_port).await,
        ForwardSpec::Remote {
            bind_host,
            bind_port,
            target_host,
            target_port,
        } => {
            start_remote(
                handle,
                registry,
                bind_host,
                bind_port,
                target_host,
                target_port,
            )
            .await
        }
    }
}

async fn start_local(
    handle: Arc<Handle<ClientHandler>>,
    bind_host: String,
    bind_port: u16,
    target_host: String,
    target_port: u16,
) -> Result<ForwardHandle, SshError> {
    let listener = TcpListener::bind((bind_host.as_str(), bind_port)).await?;
    let handle_for_stop = handle.clone();

    let accept_task = tokio::spawn(async move {
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => break,
            };
            let handle = handle.clone();
            let target_host = target_host.clone();
            tokio::spawn(async move {
                let result = handle
                    .channel_open_direct_tcpip(
                        target_host,
                        target_port as u32,
                        peer.ip().to_string(),
                        peer.port() as u32,
                    )
                    .await;
                match result {
                    Ok(channel) => pipe(stream, channel).await,
                    Err(e) => tracing::warn!(error = %e, "direct-tcpip open failed"),
                }
            });
        }
    });

    Ok(ForwardHandle {
        accept_task,
        handle: handle_for_stop,
        remote: None,
        registry: None,
    })
}

async fn start_dynamic(
    handle: Arc<Handle<ClientHandler>>,
    bind_host: String,
    bind_port: u16,
) -> Result<ForwardHandle, SshError> {
    let listener = TcpListener::bind((bind_host.as_str(), bind_port)).await?;
    let handle_for_stop = handle.clone();

    let accept_task = tokio::spawn(async move {
        loop {
            let (stream, _peer) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => break,
            };
            let handle = handle.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_socks_connection(stream, handle).await {
                    tracing::warn!(error = %e, "socks connection failed");
                }
            });
        }
    });

    Ok(ForwardHandle {
        accept_task,
        handle: handle_for_stop,
        remote: None,
        registry: None,
    })
}

async fn handle_socks_connection(
    mut stream: TcpStream,
    handle: Arc<Handle<ClientHandler>>,
) -> Result<(), SshError> {
    // Greeting: VER, NMETHODS, METHODS[NMETHODS]
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await?;
    if socks::validate_version(head[0]).is_err() {
        return Ok(());
    }
    let mut methods = vec![0u8; head[1] as usize];
    stream.read_exact(&mut methods).await?;
    let Ok(method) = socks::select_method(&methods) else {
        stream
            .write_all(&[socks::VERSION, socks::METHOD_NONE_ACCEPTABLE])
            .await?;
        return Ok(());
    };
    stream.write_all(&[socks::VERSION, method]).await?;

    // Request: VER, CMD, RSV, ATYP
    let mut req = [0u8; 4];
    stream.read_exact(&mut req).await?;
    if socks::validate_version(req[0]).is_err() {
        return Ok(());
    }
    if socks::validate_command(req[1]).is_err() {
        stream
            .write_all(&socks::reply(socks::REPLY_COMMAND_NOT_SUPPORTED))
            .await?;
        return Ok(());
    }
    let atyp = req[3];

    let domain_len = if atyp == socks::ATYP_DOMAIN {
        let mut len = [0u8; 1];
        stream.read_exact(&mut len).await?;
        len[0]
    } else {
        0
    };
    let Some(len) = socks::body_len(atyp, domain_len) else {
        stream
            .write_all(&socks::reply(socks::REPLY_ADDRESS_TYPE_NOT_SUPPORTED))
            .await?;
        return Ok(());
    };
    // The domain-length byte itself was already consumed above; only read
    // the remaining name+port bytes for that case.
    let mut body = vec![
        0u8;
        if atyp == socks::ATYP_DOMAIN {
            len - 1
        } else {
            len
        }
    ];
    stream.read_exact(&mut body).await?;
    let full_body = if atyp == socks::ATYP_DOMAIN {
        let mut b = vec![domain_len];
        b.extend_from_slice(&body);
        b
    } else {
        std::mem::take(&mut body)
    };

    let Ok((target_host, target_port)) = socks::decode_address(atyp, &full_body) else {
        stream
            .write_all(&socks::reply(socks::REPLY_ADDRESS_TYPE_NOT_SUPPORTED))
            .await?;
        return Ok(());
    };

    match handle
        .channel_open_direct_tcpip(target_host, target_port as u32, "127.0.0.1", 0)
        .await
    {
        Ok(channel) => {
            stream
                .write_all(&socks::reply(socks::REPLY_SUCCEEDED))
                .await?;
            pipe(stream, channel).await;
        }
        Err(_) => {
            stream
                .write_all(&socks::reply(socks::REPLY_CONNECTION_REFUSED))
                .await?;
        }
    }
    Ok(())
}

async fn start_remote(
    handle: Arc<Handle<ClientHandler>>,
    registry: RemoteForwardRegistry,
    bind_host: String,
    bind_port: u16,
    target_host: String,
    target_port: u16,
) -> Result<ForwardHandle, SshError> {
    let bound_port = handle
        .tcpip_forward(bind_host.clone(), bind_port as u32)
        .await?;
    let actual_port = if bind_port == 0 {
        bound_port as u16
    } else {
        bind_port
    };

    registry
        .lock()
        .await
        .insert((bind_host.clone(), actual_port), (target_host, target_port));

    // No accept-loop task on our side for remote forwards — incoming
    // connections arrive as server-initiated channels, handled by
    // `ClientHandler::server_channel_open_forwarded_tcpip`. This task just
    // exists so `ForwardHandle` has something uniform to abort/hold onto.
    let accept_task = tokio::spawn(async {});

    Ok(ForwardHandle {
        accept_task,
        handle,
        remote: Some((bind_host, actual_port)),
        registry: Some(registry),
    })
}

/// Bidirectionally copies bytes between a local TCP stream and an SSH
/// `direct-tcpip`/`forwarded-tcpip` channel until either side closes.
pub(crate) async fn pipe(stream: TcpStream, channel: russh::Channel<russh::client::Msg>) {
    let (mut tcp_read, mut tcp_write) = tokio::io::split(stream);
    let mut writer = channel.make_writer();
    let mut channel = channel;

    let to_ssh = async {
        let mut buf = [0u8; 8192];
        loop {
            match tcp_read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if writer.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
            }
        }
    };

    let to_tcp = async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    if tcp_write.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
    };

    tokio::select! {
        _ = to_ssh => {}
        _ = to_tcp => {}
    }
}
