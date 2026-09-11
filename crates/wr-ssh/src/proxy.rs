//! Reaching an SSH server through an outbound proxy: HTTP `CONNECT` or SOCKS5.
//!
//! Not to be confused with `socks.rs`, which is the *server* side of a dynamic
//! port forward. This is the client side, for a machine that can only get out
//! through a corporate proxy.
//!
//! Both protocols end the same way: once the proxy has agreed, the socket is a
//! plain byte pipe to the target, and russh runs its handshake over it exactly
//! as it would over a direct connection (`client::connect_stream`).
//!
//! **No proxy authentication.** A corporate HTTP proxy that wants credentials
//! almost always wants NTLM or Kerberos rather than Basic, which a username and
//! password field would not satisfy, and storing one would put a second secret
//! outside the vault. A proxy that demands it is reported as such, rather than
//! as a generic refusal that sends someone hunting for a wrong host name.

use std::net::IpAddr;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyKind {
    Http,
    Socks5,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
}

/// Covers reaching the proxy and hearing its answer. The SSH handshake after
/// it keeps its own budget (`CONNECT_TIMEOUT` in session.rs).
const PROXY_TIMEOUT: Duration = Duration::from_secs(15);

/// A `CONNECT` reply's headers are a few hundred bytes. Past this, whatever is
/// answering is not a proxy this can talk to, and reading on would be reading
/// an unbounded stream into memory on a stranger's say-so.
const MAX_HTTP_RESPONSE: usize = 8 * 1024;

/// Worded to follow "proxy host:port", which `SshError::Proxy` puts in front.
#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("could not be reached: {0}")]
    Unreachable(std::io::Error),
    #[error("did not answer in time")]
    Timeout,
    #[error("requires a login, which wRusTTY does not support")]
    AuthRequired,
    #[error("refused the connection: {0}")]
    Refused(String),
    #[error("sent a reply that is neither HTTP CONNECT nor SOCKS5")]
    Protocol,
    #[error("dropped the connection: {0}")]
    Io(std::io::Error),
}

/// Opens a socket to `proxy` and asks it for a tunnel to `host:port`. On
/// success the stream carries the target's bytes and nothing of the proxy's.
pub async fn connect(proxy: &ProxyConfig, host: &str, port: u16) -> Result<TcpStream, ProxyError> {
    tokio::time::timeout(PROXY_TIMEOUT, async {
        let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
            .await
            .map_err(ProxyError::Unreachable)?;
        // Nagle off, for the reason `nodelay: true` is set in session.rs. russh
        // can only set it on a socket it opened itself, and this one it didn't.
        let _ = stream.set_nodelay(true);
        match proxy.kind {
            ProxyKind::Http => http_connect(&mut stream, host, port).await?,
            ProxyKind::Socks5 => socks5_connect(&mut stream, host, port).await?,
        }
        Ok(stream)
    })
    .await
    .map_err(|_| ProxyError::Timeout)?
}

/// `host:port` as HTTP spells it, with an IPv6 literal bracketed.
fn authority(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

async fn http_connect<S>(stream: &mut S, host: &str, port: u16) -> Result<(), ProxyError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let authority = authority(host, port);
    let request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(ProxyError::Io)?;

    // A byte at a time, deliberately. Whatever follows the blank line is the
    // SSH server's banner, and a buffered read would take it along with the
    // headers and leave russh waiting for a version string that already came.
    let mut response = Vec::new();
    let mut byte = [0u8; 1];
    while !response.ends_with(b"\r\n\r\n") {
        if response.len() >= MAX_HTTP_RESPONSE {
            return Err(ProxyError::Protocol);
        }
        if stream.read(&mut byte).await.map_err(ProxyError::Io)? == 0 {
            return Err(ProxyError::Io(std::io::ErrorKind::UnexpectedEof.into()));
        }
        response.push(byte[0]);
    }

    let text = String::from_utf8_lossy(&response);
    let status_line = text.lines().next().unwrap_or_default();
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or_default();
    let code = parts.next().unwrap_or_default();
    let reason = parts.next().unwrap_or_default().trim();
    if !version.starts_with("HTTP/") {
        return Err(ProxyError::Protocol);
    }
    match code.parse::<u16>() {
        Ok(200..=299) => Ok(()),
        Ok(407) => Err(ProxyError::AuthRequired),
        Ok(code) => Err(ProxyError::Refused(
            format!("{code} {reason}").trim().to_string(),
        )),
        Err(_) => Err(ProxyError::Protocol),
    }
}

async fn socks5_connect<S>(stream: &mut S, host: &str, port: u16) -> Result<(), ProxyError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // Version 5, one method offered: no authentication.
    stream.write_all(&[5, 1, 0]).await.map_err(ProxyError::Io)?;
    let mut choice = [0u8; 2];
    stream
        .read_exact(&mut choice)
        .await
        .map_err(ProxyError::Io)?;
    match choice {
        [5, 0] => {}
        // "No acceptable methods". Having offered only "none", that means it
        // wants a login.
        [5, 0xFF] => return Err(ProxyError::AuthRequired),
        _ => return Err(ProxyError::Protocol),
    }

    // CONNECT. A host name goes as a name rather than being resolved here, so
    // the proxy does the lookup: behind a corporate proxy the internal names
    // are frequently the ones this machine cannot resolve for itself.
    let mut request = vec![5, 1, 0];
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<IpAddr>() {
        Ok(IpAddr::V4(addr)) => {
            request.push(1);
            request.extend_from_slice(&addr.octets());
        }
        Ok(IpAddr::V6(addr)) => {
            request.push(4);
            request.extend_from_slice(&addr.octets());
        }
        Err(_) => {
            let name = host.as_bytes();
            let len = u8::try_from(name.len())
                .map_err(|_| ProxyError::Refused("the host name is too long for SOCKS5".into()))?;
            request.push(3);
            request.push(len);
            request.extend_from_slice(name);
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await.map_err(ProxyError::Io)?;

    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await.map_err(ProxyError::Io)?;
    if head[0] != 5 {
        return Err(ProxyError::Protocol);
    }
    if head[1] != 0 {
        return Err(ProxyError::Refused(socks5_reply_text(head[1])));
    }
    // The address the proxy bound for us. Nothing uses it, but it has to be
    // read off the stream or it would arrive in front of the SSH banner.
    let addr_len = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(ProxyError::Io)?;
            usize::from(len[0])
        }
        _ => return Err(ProxyError::Protocol),
    };
    let mut rest = vec![0u8; addr_len + 2];
    stream.read_exact(&mut rest).await.map_err(ProxyError::Io)?;
    Ok(())
}

/// RFC 1928's reply codes, in words.
fn socks5_reply_text(code: u8) -> String {
    match code {
        1 => "general failure".into(),
        2 => "not allowed by the proxy's rules".into(),
        3 => "network unreachable".into(),
        4 => "host unreachable".into(),
        5 => "the destination host refused it".into(),
        6 => "the connection timed out".into(),
        7 => "command not supported".into(),
        8 => "address type not supported".into(),
        other => format!("SOCKS5 error {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, DuplexStream};

    /// Reads the proxy side of the pipe up to the end of an HTTP request.
    async fn read_request(server: &mut DuplexStream) -> String {
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        while !request.ends_with(b"\r\n\r\n") {
            server.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
        }
        String::from_utf8(request).unwrap()
    }

    /// The failure this guards is silent: the headers read correctly, and the
    /// handshake then waits forever for a banner the header read swallowed.
    #[tokio::test]
    async fn http_leaves_the_servers_banner_on_the_stream() {
        let (mut client, mut server) = duplex(1024);
        let proxy = tokio::spawn(async move {
            let request = read_request(&mut server).await;
            server
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-test\r\n")
                .await
                .unwrap();
            request
        });

        http_connect(&mut client, "example.com", 22).await.unwrap();
        let mut banner = [0u8; 14];
        client.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"SSH-2.0-test\r\n");
        assert_eq!(
            proxy.await.unwrap(),
            "CONNECT example.com:22 HTTP/1.1\r\nHost: example.com:22\r\n\r\n"
        );
    }

    #[tokio::test]
    async fn http_brackets_an_ipv6_target() {
        let (mut client, mut server) = duplex(1024);
        let proxy = tokio::spawn(async move {
            let request = read_request(&mut server).await;
            server.write_all(b"HTTP/1.0 200 OK\r\n\r\n").await.unwrap();
            request
        });
        http_connect(&mut client, "fe80::1", 2222).await.unwrap();
        assert!(proxy
            .await
            .unwrap()
            .starts_with("CONNECT [fe80::1]:2222 HTTP/1.1\r\n"));
    }

    #[tokio::test]
    async fn http_407_is_reported_as_a_login_rather_than_a_refusal() {
        let (mut client, mut server) = duplex(1024);
        tokio::spawn(async move {
            read_request(&mut server).await;
            server
                .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: NTLM\r\n\r\n")
                .await
                .unwrap();
        });
        assert!(matches!(
            http_connect(&mut client, "h", 22).await,
            Err(ProxyError::AuthRequired)
        ));
    }

    #[tokio::test]
    async fn http_refusal_carries_the_status() {
        let (mut client, mut server) = duplex(1024);
        tokio::spawn(async move {
            read_request(&mut server).await;
            server
                .write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                .await
                .unwrap();
        });
        match http_connect(&mut client, "h", 22).await {
            Err(ProxyError::Refused(reason)) => assert_eq!(reason, "403 Forbidden"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    /// Something that is not a proxy at all — an SSH server on the proxy's
    /// port, say — must not be read without end.
    #[tokio::test]
    async fn http_gives_up_on_a_reply_with_no_end() {
        let (mut client, mut server) = duplex(64 * 1024);
        tokio::spawn(async move {
            read_request(&mut server).await;
            let _ = server.write_all(&vec![b'x'; MAX_HTTP_RESPONSE + 16]).await;
        });
        assert!(matches!(
            http_connect(&mut client, "h", 22).await,
            Err(ProxyError::Protocol)
        ));
    }

    #[tokio::test]
    async fn socks5_sends_a_name_for_the_proxy_to_resolve() {
        let (mut client, mut server) = duplex(1024);
        let proxy = tokio::spawn(async move {
            let mut greeting = [0u8; 3];
            server.read_exact(&mut greeting).await.unwrap();
            server.write_all(&[5, 0]).await.unwrap();
            let mut request = vec![0u8; 5 + "db.internal".len() + 2];
            server.read_exact(&mut request).await.unwrap();
            // Bound address 10.0.0.9:40000, then the target's banner.
            server
                .write_all(&[5, 0, 0, 1, 10, 0, 0, 9, 0x9c, 0x40])
                .await
                .unwrap();
            server.write_all(b"SSH-2.0-x\r\n").await.unwrap();
            (greeting, request)
        });

        socks5_connect(&mut client, "db.internal", 22)
            .await
            .unwrap();
        let mut banner = [0u8; 11];
        client.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"SSH-2.0-x\r\n");

        let (greeting, request) = proxy.await.unwrap();
        assert_eq!(greeting, [5, 1, 0]);
        let mut expected = vec![5, 1, 0, 3, 11];
        expected.extend_from_slice(b"db.internal");
        expected.extend_from_slice(&[0, 22]);
        assert_eq!(request, expected);
    }

    #[tokio::test]
    async fn socks5_sends_an_ipv4_literal_as_an_address() {
        let (mut client, mut server) = duplex(1024);
        let proxy = tokio::spawn(async move {
            let mut greeting = [0u8; 3];
            server.read_exact(&mut greeting).await.unwrap();
            server.write_all(&[5, 0]).await.unwrap();
            let mut request = [0u8; 10];
            server.read_exact(&mut request).await.unwrap();
            server
                .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
                .await
                .unwrap();
            request
        });
        socks5_connect(&mut client, "192.168.1.20", 2222)
            .await
            .unwrap();
        assert_eq!(
            proxy.await.unwrap(),
            [5, 1, 0, 1, 192, 168, 1, 20, 0x08, 0xae]
        );
    }

    #[tokio::test]
    async fn socks5_no_acceptable_method_means_it_wants_a_login() {
        let (mut client, mut server) = duplex(1024);
        tokio::spawn(async move {
            let mut greeting = [0u8; 3];
            server.read_exact(&mut greeting).await.unwrap();
            server.write_all(&[5, 0xFF]).await.unwrap();
        });
        assert!(matches!(
            socks5_connect(&mut client, "h", 22).await,
            Err(ProxyError::AuthRequired)
        ));
    }

    #[tokio::test]
    async fn socks5_refusal_is_put_in_words() {
        let (mut client, mut server) = duplex(1024);
        tokio::spawn(async move {
            let mut greeting = [0u8; 3];
            server.read_exact(&mut greeting).await.unwrap();
            server.write_all(&[5, 0]).await.unwrap();
            let mut request = [0u8; 8];
            server.read_exact(&mut request).await.unwrap();
            server
                .write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0])
                .await
                .unwrap();
        });
        match socks5_connect(&mut client, "h", 22).await {
            Err(ProxyError::Refused(reason)) => assert!(reason.contains("refused")),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    /// The shape the webview sends. Pinned because a rename here is a proxy
    /// setting that silently stops arriving.
    #[test]
    fn config_wire_shape() {
        let config: ProxyConfig =
            serde_json::from_str(r#"{"kind":"socks5","host":"proxy.corp","port":1080}"#).unwrap();
        assert_eq!(
            config,
            ProxyConfig {
                kind: ProxyKind::Socks5,
                host: "proxy.corp".into(),
                port: 1080,
            }
        );
        let http: ProxyConfig =
            serde_json::from_str(r#"{"kind":"http","host":"p","port":3128}"#).unwrap();
        assert_eq!(http.kind, ProxyKind::Http);
    }
}
