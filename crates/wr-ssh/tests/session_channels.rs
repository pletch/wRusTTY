//! A slow side channel must not hold up typing. The server here leaves each
//! extra channel unanswered until a keystroke arrives on the shell, so a
//! keystroke that waits for the channel to finish hangs the test.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::server::{
    Auth, ChannelOpenHandle, Handler as ServerHandler, Msg, Session as ServerSession,
};
use russh::{Channel, ChannelId};
use tokio::sync::{mpsc, Mutex};
use wr_core::{ConnectionEvent, Connector, Session};
use wr_ssh::{AuthMethod, DenyAll, HostKeyPrompt, HostKeyVerifier, SshConfig, SshConnector};

const LIMIT: Duration = Duration::from_secs(5);

struct ParkingServer {
    /// The extra channel waiting on a keystroke.
    parked: Option<ChannelId>,
    /// Tells the test a channel is now parked.
    parked_tx: mpsc::UnboundedSender<()>,
}

impl ParkingServer {
    fn park(
        &mut self,
        channel: ChannelId,
        session: &mut ServerSession,
    ) -> Result<(), russh::Error> {
        session.channel_success(channel)?;
        self.parked = Some(channel);
        let _ = self.parked_tx.send(());
        Ok(())
    }
}

impl ServerHandler for ParkingServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _command: &[u8],
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        self.park(channel, session)
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        _name: &str,
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        self.park(channel, session)
    }

    /// A keystroke answers the parked channel with what was typed, then ends it.
    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        if let Some(parked) = self.parked.take() {
            session.data(parked, data.to_vec())?;
            session.eof(parked)?;
            session.close(parked)?;
        }
        Ok(())
    }
}

struct AcceptAnyHostKey;

#[async_trait]
impl HostKeyVerifier for AcceptAnyHostKey {
    async fn verify(&self, _prompt: HostKeyPrompt) -> bool {
        true
    }
}

/// A session shared as the app shares it, and a signal for parked channels.
async fn connect() -> (
    Arc<Mutex<wr_ssh::SshSession>>,
    mpsc::UnboundedReceiver<()>,
    tempfile::TempDir,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Arc::new(russh::server::Config {
        keys: vec![
            wr_ssh::parse_private_key(include_str!("fixtures/id_ed25519.ppk"), None).unwrap(),
        ],
        ..Default::default()
    });
    let (parked_tx, parked_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let handler = ParkingServer {
            parked: None,
            parked_tx,
        };
        if let Ok(session) = russh::server::run_stream(config, stream, handler).await {
            let _ = session.await;
        }
    });

    let dir = tempfile::tempdir().unwrap();
    let connector = SshConnector::new(
        SshConfig {
            host: "127.0.0.1".into(),
            port,
            username: "tester".into(),
            auth: AuthMethod::Password {
                password: "secret".into(),
            },
            ..Default::default()
        },
        dir.path().join("known_hosts"),
        Arc::new(AcceptAnyHostKey),
        Arc::new(DenyAll),
        80,
        24,
    )
    .unwrap();

    let (tx, mut rx) = mpsc::channel::<ConnectionEvent>(64);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let session = connector.connect(tx).await.unwrap();
    (Arc::new(Mutex::new(session)), parked_rx, dir)
}

/// Passes bytes both ways until told to stop, then keeps the sockets open and says
/// nothing: what a host looks like when the network under the connection has gone.
async fn black_hole_proxy(target: u16) -> (u16, Arc<std::sync::atomic::AtomicBool>) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let stalled = Arc::new(AtomicBool::new(false));
    let flag = stalled.clone();
    tokio::spawn(async move {
        let (client, _) = listener.accept().await.unwrap();
        let server = tokio::net::TcpStream::connect(("127.0.0.1", target))
            .await
            .unwrap();
        let (mut client_read, mut client_write) = client.into_split();
        let (mut server_read, mut server_write) = server.into_split();
        let up = flag.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok(n) = client_read.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                if !up.load(Ordering::SeqCst) && server_write.write_all(&buf[..n]).await.is_err() {
                    break;
                }
            }
            std::future::pending::<()>().await;
        });
        let mut buf = [0u8; 4096];
        while let Ok(n) = server_read.read(&mut buf).await {
            if n == 0 {
                break;
            }
            if !flag.load(Ordering::SeqCst) && client_write.write_all(&buf[..n]).await.is_err() {
                break;
            }
        }
        std::future::pending::<()>().await;
    });
    (port, stalled)
}

/// A session through [`black_hole_proxy`], and whether its link was reported lost.
async fn connect_through_proxy() -> (
    wr_ssh::SshSession,
    Arc<std::sync::atomic::AtomicBool>,
    mpsc::Receiver<ConnectionEvent>,
    tempfile::TempDir,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = listener.local_addr().unwrap().port();
    let config = Arc::new(russh::server::Config {
        keys: vec![
            wr_ssh::parse_private_key(include_str!("fixtures/id_ed25519.ppk"), None).unwrap(),
        ],
        ..Default::default()
    });
    let (parked_tx, parked_rx) = mpsc::unbounded_channel();
    // Dropped with the task, which outlives the test only by a moment.
    std::mem::forget(parked_rx);
    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let handler = ParkingServer {
            parked: None,
            parked_tx,
        };
        if let Ok(session) = russh::server::run_stream(config, stream, handler).await {
            let _ = session.await;
        }
    });
    let (port, stalled) = black_hole_proxy(target).await;

    let dir = tempfile::tempdir().unwrap();
    let connector = SshConnector::new(
        SshConfig {
            host: "127.0.0.1".into(),
            port,
            username: "tester".into(),
            auth: AuthMethod::Password {
                password: "secret".into(),
            },
            ..Default::default()
        },
        dir.path().join("known_hosts"),
        Arc::new(AcceptAnyHostKey),
        Arc::new(DenyAll),
        80,
        24,
    )
    .unwrap();
    let (tx, rx) = mpsc::channel::<ConnectionEvent>(64);
    let session = connector.connect(tx).await.unwrap();
    (session, stalled, rx, dir)
}

/// Waits for the link to be reported lost, draining anything else.
async fn lost(events: &mut mpsc::Receiver<ConnectionEvent>) -> bool {
    use wr_core::{ConnectionStatus, DisconnectKind};
    tokio::time::timeout(LIMIT, async {
        while let Some(event) = events.recv().await {
            if matches!(
                event,
                ConnectionEvent::Status(ConnectionStatus::Disconnected(DisconnectKind::Lost))
            ) {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false)
}

/// After a network change a host that still answers must keep its session. Through a
/// VPN that moved networks, it may well have survived.
#[tokio::test]
async fn a_probe_leaves_a_session_that_answers_alone() {
    let (session, _stalled, mut events, _dir) = connect_through_proxy().await;
    session.probe_within(LIMIT).unwrap().await;
    assert!(
        !tokio::time::timeout(Duration::from_millis(300), lost(&mut events))
            .await
            .unwrap_or(false)
    );
    assert!(session.channels().is_ok());
}

/// Without a probe this took about three minutes of missed keepalives.
#[tokio::test]
async fn a_probe_ends_a_session_on_a_dead_link() {
    let (session, stalled, mut events, _dir) = connect_through_proxy().await;
    stalled.store(true, std::sync::atomic::Ordering::SeqCst);
    session
        .probe_within(Duration::from_millis(200))
        .unwrap()
        .await;
    assert!(lost(&mut events).await, "the link was never reported lost");
}

/// The remote history import and the Files panel's identity check.
#[tokio::test]
async fn typing_gets_through_while_a_remote_command_is_running() {
    let (session, mut parked, _dir) = connect().await;

    let channels = session.lock().await.channels().unwrap();
    let capture =
        tokio::spawn(async move { channels.exec_capture("slow", 1024, LIMIT).await.unwrap() });
    tokio::time::timeout(LIMIT, parked.recv())
        .await
        .expect("the command never started");

    tokio::time::timeout(LIMIT, async {
        session.lock().await.write(b"typed").await.unwrap();
    })
    .await
    .expect("the keystroke waited on the command");

    assert_eq!(capture.await.unwrap(), b"typed");
}

/// The first SFTP open. The reply isn't valid SFTP, so the open fails at the
/// client's own 10-second request timeout, which is how long this test takes.
#[tokio::test]
async fn typing_gets_through_while_sftp_is_opening() {
    let (session, mut parked, _dir) = connect().await;

    let channels = session.lock().await.channels().unwrap();
    let open = tokio::spawn(async move { channels.sftp().await.is_ok() });
    tokio::time::timeout(LIMIT, parked.recv())
        .await
        .expect("the subsystem was never requested");

    tokio::time::timeout(LIMIT, async {
        session.lock().await.write(b"typed").await.unwrap();
    })
    .await
    .expect("the keystroke waited on the open");

    assert!(!open.await.unwrap(), "garbage shouldn't open as SFTP");
}
