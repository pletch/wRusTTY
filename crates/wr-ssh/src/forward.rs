//! Port forwarding: local, remote, and dynamic (SOCKS5). All three share
//! the same underlying primitive — an SSH `direct-tcpip` channel piped to a
//! local TCP stream — they differ only in how the local TCP connection and
//! the forwarding target are decided.

use std::collections::HashMap;
use std::sync::Arc;

use russh::client::Handle;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
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

/// `rename_all_fields` is load-bearing, not decoration. On an enum,
/// `rename_all` renames the *variants* — it says nothing about their fields —
/// so without this the variants arrived as `local`/`remote`/`dynamic` as
/// intended while the fields were still expected in snake_case. The frontend
/// sends `bindHost`, so every `ssh_add_forward` was rejected at the IPC
/// boundary with "missing field `bind_host`" before any forwarding code ran:
/// port forwarding could not be used at all. `SshEvent` in the app's ssh.rs
/// already spells both out; this type was simply missing the second.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
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

impl ForwardSpec {
    pub fn bind_host(&self) -> &str {
        match self {
            ForwardSpec::Local { bind_host, .. }
            | ForwardSpec::Remote { bind_host, .. }
            | ForwardSpec::Dynamic { bind_host, .. } => bind_host,
        }
    }
}

/// `Local`/`Dynamic` bind on this machine; `Remote` asks the SSH *server* to
/// bind (the OpenSSH `GatewayPorts` case) — either way, a non-loopback bind
/// host means something other than "just this machine" can reach the
/// forward, and `Dynamic`'s SOCKS5 proxy offers no authentication at all.
/// Anything that doesn't clearly parse as loopback is treated as
/// non-loopback (fail closed), including plain hostnames.
pub fn is_loopback_bind_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
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
/// `direct-tcpip`/`forwarded-tcpip` channel until both sides are done.
pub(crate) async fn pipe(stream: TcpStream, channel: russh::Channel<russh::client::Msg>) {
    pipe_streams(stream, channel.into_stream()).await;
}

/// The actual copy, generic over both sides so it's directly unit-testable
/// with two `tokio::io::duplex()` pairs (see the tests below) rather than
/// needing a live TCP connection and SSH channel.
///
/// Previously hand-rolled as two racing futures under `tokio::select!`,
/// which drops whichever direction was still running the instant the
/// *other* one finished — e.g. the local TCP side reaching EOF while
/// SSH-side data was still in flight, silently truncating it.
/// `copy_bidirectional` shuts each direction's write half down
/// independently on EOF and waits for both to finish, which is the correct
/// half-close behavior.
async fn pipe_streams<A, B>(mut a: A, mut b: B)
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let _ = tokio::io::copy_bidirectional(&mut a, &mut b).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the IPC wire contract against `src/lib/forward.ts`. These are the
    /// exact payloads the frontend sends; the shape being wrong here is not a
    /// compile error on either side, so nothing but a test catches it — and
    /// nothing did, which is why forwarding was unusable.
    #[test]
    fn deserializes_the_payloads_the_frontend_actually_sends() {
        let local: ForwardSpec = serde_json::from_str(
            r#"{"type":"local","bindHost":"127.0.0.1","bindPort":8080,
                "targetHost":"example.internal","targetPort":80}"#,
        )
        .expect("local forward should deserialize");
        assert!(matches!(
            local,
            ForwardSpec::Local { ref bind_host, bind_port: 8080, ref target_host, target_port: 80 }
                if bind_host == "127.0.0.1" && target_host == "example.internal"
        ));

        let remote: ForwardSpec = serde_json::from_str(
            r#"{"type":"remote","bindHost":"0.0.0.0","bindPort":9090,
                "targetHost":"localhost","targetPort":22}"#,
        )
        .expect("remote forward should deserialize");
        assert!(matches!(remote, ForwardSpec::Remote { bind_port: 9090, .. }));

        let dynamic: ForwardSpec = serde_json::from_str(
            r#"{"type":"dynamic","bindHost":"127.0.0.1","bindPort":1080}"#,
        )
        .expect("dynamic forward should deserialize");
        assert!(matches!(dynamic, ForwardSpec::Dynamic { bind_port: 1080, .. }));
    }

    /// The other half of the contract: what we emit is what the frontend can
    /// read back, so the rename applies in both directions.
    #[test]
    fn serializes_back_to_camel_case_fields() {
        let json = serde_json::to_string(&ForwardSpec::Dynamic {
            bind_host: "127.0.0.1".to_string(),
            bind_port: 1080,
        })
        .unwrap();
        assert!(json.contains("\"bindHost\""), "got {json}");
        assert!(json.contains("\"bindPort\""), "got {json}");
        assert!(json.contains("\"type\":\"dynamic\""), "got {json}");
    }

    #[test]
    fn loopback_ips_and_localhost_are_recognized() {
        assert!(is_loopback_bind_host("127.0.0.1"));
        assert!(is_loopback_bind_host("127.5.6.7"));
        assert!(is_loopback_bind_host("::1"));
        assert!(is_loopback_bind_host("localhost"));
        assert!(is_loopback_bind_host("LOCALHOST"));
    }

    #[test]
    fn non_loopback_and_unparseable_hosts_are_rejected() {
        assert!(!is_loopback_bind_host("0.0.0.0"));
        assert!(!is_loopback_bind_host("192.168.1.5"));
        assert!(!is_loopback_bind_host("::"));
        assert!(!is_loopback_bind_host("example.com"));
        assert!(!is_loopback_bind_host(""));
    }

    /// The bug this guards against: the old implementation raced two
    /// futures under `tokio::select!`, dropping whichever direction was
    /// still running the instant the *other* one finished — so data sent
    /// from one side, still in flight, could be silently lost if the other
    /// side happened to reach EOF first. `copy_bidirectional` must instead
    /// keep relaying a still-open direction until it's actually done.
    #[tokio::test]
    async fn half_close_does_not_truncate_in_flight_data() {
        let (a1, a2) = tokio::io::duplex(1024);
        let (b1, b2) = tokio::io::duplex(1024);

        let handle = tokio::spawn(pipe_streams(a1, b1));

        let (mut a2_read, a2_write) = tokio::io::split(a2);
        let (_b2_read, mut b2_write) = tokio::io::split(b2);

        // The "SSH side" sends a chunk toward the "TCP side" ...
        b2_write.write_all(b"hello from ssh").await.unwrap();
        // ... and, before it's necessarily been relayed yet, the "TCP
        // side" reaches EOF by having its write half dropped (a duplex
        // stream's read half sees EOF once its peer's write half closes)
        // — the exact race the old select!-based code lost data to.
        tokio::task::yield_now().await;
        drop(a2_write);

        let mut received = vec![0u8; b"hello from ssh".len()];
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            a2_read.read_exact(&mut received),
        )
        .await
        .expect("timed out waiting for in-flight data")
        .unwrap();
        assert_eq!(&received, b"hello from ssh");

        drop(b2_write);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), handle).await;
    }
}
