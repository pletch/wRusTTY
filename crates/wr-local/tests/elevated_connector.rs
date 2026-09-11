//! The tab's end of an elevated session, against a real host over a real pipe.
//!
//! The only thing replaced is the launcher: instead of `ShellExecuteEx`/`runas`
//! it starts the host in-process, unelevated. Everything the tab does with
//! what it launched — waiting for the pipe, checking who serves it, sending its
//! size, relaying — is the production code.
#![cfg(windows)]

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::net::windows::named_pipe::ServerOptions;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use wr_core::{ConnectionEvent, ConnectionStatus, Connector, DisconnectKind, Session};
use wr_local::elevated::connector::{
    ElevatedConnector, ElevatedSession, LaunchError, LaunchRequest, LaunchedHost, Launcher,
};
use wr_local::elevated::host::{run_host, HostConfig, HostError};
use wr_local::elevated::protocol::read_frame;
use wr_local::{LocalConfig, LocalError};

type Launched = Pin<Box<dyn Future<Output = Result<LaunchedHost, LaunchError>> + Send>>;

fn cmd(command: &str) -> LocalConfig {
    LocalConfig {
        command: std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into()),
        args: vec!["/v:on".into(), "/c".into(), command.into()],
        ..Default::default()
    }
}

fn linger(command: &str) -> String {
    format!("{command} & ping -n 2 127.0.0.1 > nul")
}

/// Starts the real host in-process for a fixed set of "shells", and keeps each
/// host's task so a test can see when it finishes.
#[derive(Default)]
struct InProcessLauncher {
    shells: HashMap<String, LocalConfig>,
    hosts: Mutex<Vec<JoinHandle<Result<(), HostError>>>>,
}

impl InProcessLauncher {
    fn with(id: &str, shell: LocalConfig) -> Arc<Self> {
        let mut shells = HashMap::new();
        shells.insert(id.to_string(), shell);
        Arc::new(Self {
            shells,
            hosts: Mutex::new(Vec::new()),
        })
    }

    fn take_host(&self) -> JoinHandle<Result<(), HostError>> {
        self.hosts
            .lock()
            .unwrap()
            .pop()
            .expect("a host was launched")
    }
}

impl Launcher for InProcessLauncher {
    fn launch(&self, request: LaunchRequest) -> Launched {
        let Some(shell) = self.shells.get(&request.shell_id).cloned() else {
            return Box::pin(async { Err(LaunchError::Failed("unknown shell".into())) });
        };
        let host = tokio::spawn(run_host(HostConfig {
            pipe_name: request.pipe_name,
            client_pid: request.client_pid,
            shell,
        }));
        // The tab only needs to know when the host has gone; the handle itself
        // stays here so the test can await the host's own result.
        let (gone_tx, gone_rx) = tokio::sync::oneshot::channel::<()>();
        let watched = tokio::spawn(async move {
            let result = host.await.expect("the host task should not panic");
            let _ = gone_tx.send(());
            result
        });
        self.hosts.lock().unwrap().push(watched);
        Box::pin(async move {
            Ok(LaunchedHost {
                // In-process: the host's pipe is served by this very process.
                pid: std::process::id(),
                exited: Box::pin(async move {
                    let _ = gone_rx.await;
                }),
            })
        })
    }
}

/// Stands in for the user answering No.
struct DecliningLauncher;
impl Launcher for DecliningLauncher {
    fn launch(&self, _: LaunchRequest) -> Launched {
        Box::pin(async { Err(LaunchError::Declined) })
    }
}

/// A host that starts and dies before it ever creates its pipe.
struct VanishingLauncher;
impl Launcher for VanishingLauncher {
    fn launch(&self, _: LaunchRequest) -> Launched {
        Box::pin(async {
            Ok(LaunchedHost {
                pid: std::process::id(),
                exited: Box::pin(async {}),
            })
        })
    }
}

/// Something that got to the pipe name first, while the host the tab believes
/// it launched is a different process.
struct ImpostorLauncher {
    /// What the impostor received, if anything.
    received: Arc<Mutex<Option<Vec<u8>>>>,
}
impl Launcher for ImpostorLauncher {
    fn launch(&self, request: LaunchRequest) -> Launched {
        let squatter = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&request.pipe_name)
            .expect("the impostor creates the pipe first");
        let received = self.received.clone();
        tokio::spawn(async move {
            if squatter.connect().await.is_ok() {
                let mut squatter = squatter;
                let got = read_frame(&mut squatter).await;
                *received.lock().unwrap() = Some(format!("{got:?}").into_bytes());
            }
        });
        Box::pin(async {
            Ok(LaunchedHost {
                // Not this process, which is who actually serves the pipe.
                pid: std::process::id() ^ 0x4000_0000,
                exited: Box::pin(std::future::pending()),
            })
        })
    }
}

/// Runs an open session to its end the way a pane would, answering the
/// pseudoconsole's cursor query and optionally sending input once it's up.
async fn drive(
    session: &mut ElevatedSession,
    events: &mut mpsc::Receiver<ConnectionEvent>,
    input: Option<&[u8]>,
    resize_to: Option<(u16, u16)>,
) -> (String, Vec<ConnectionStatus>) {
    let mut output = Vec::new();
    let mut statuses = Vec::new();
    let mut input = input;
    if let Some((cols, rows)) = resize_to {
        session.resize(cols, rows).await.unwrap();
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, events.recv()).await {
        match event {
            ConnectionEvent::Data(bytes) => {
                if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                    session.write(b"\x1b[1;1R").await.unwrap();
                    if let Some(pending) = input.take() {
                        session.write(pending).await.unwrap();
                    }
                }
                output.extend_from_slice(&bytes);
            }
            ConnectionEvent::Status(status) => {
                let done = matches!(status, ConnectionStatus::Disconnected(_));
                statuses.push(status);
                if done {
                    break;
                }
            }
        }
    }
    (String::from_utf8_lossy(&output).into_owned(), statuses)
}

async fn open(
    launcher: Arc<dyn Launcher>,
    shell_id: &str,
) -> (
    Result<ElevatedSession, LocalError>,
    mpsc::Receiver<ConnectionEvent>,
) {
    let (tx, rx) = mpsc::channel(256);
    let result = ElevatedConnector::new(launcher, shell_id)
        .with_size(100, 30)
        .connect(tx)
        .await;
    (result, rx)
}

/// The width `mode con` reported, off its `Columns:` line.
fn columns(out: &str) -> Option<u32> {
    let at = out.find("Columns:")? + "Columns:".len();
    out[at..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

fn statuses_so_far(events: &mut mpsc::Receiver<ConnectionEvent>) -> Vec<ConnectionStatus> {
    let mut out = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let ConnectionEvent::Status(s) = event {
            out.push(s);
        }
    }
    out
}

// --- through the pipe -----------------------------------------------------

#[tokio::test]
async fn an_elevated_session_relays_output_and_its_exit() {
    let launcher = InProcessLauncher::with("echo", cmd(&linger("echo through-the-host")));
    let (session, mut events) = open(launcher.clone(), "echo").await;
    let mut session = session.expect("the session should open");

    let (out, statuses) = drive(&mut session, &mut events, None, None).await;
    assert!(out.contains("through-the-host"), "got: {out:?}");
    assert!(out.contains("exited with code 0"), "got: {out:?}");
    // Closed, not Lost: an elevated tab is never reconnected.
    assert!(
        matches!(
            statuses.last(),
            Some(ConnectionStatus::Disconnected(DisconnectKind::Closed))
        ),
        "got: {statuses:?}"
    );
    assert!(
        statuses.contains(&ConnectionStatus::Connected),
        "got: {statuses:?}"
    );
    launcher.take_host().await.unwrap().unwrap();
}

#[tokio::test]
async fn input_reaches_an_elevated_shell() {
    let launcher = InProcessLauncher::with("echo", cmd(&linger("set /p line= && echo got-!line!")));
    let (session, mut events) = open(launcher, "echo").await;
    let mut session = session.unwrap();

    let (out, _) = drive(&mut session, &mut events, Some(b"ping\r\n"), None).await;
    assert!(out.contains("got-ping"), "got: {out:?}");
}

/// The size the tab opened at is the size the pseudoconsole was created at.
#[tokio::test]
async fn the_tab_s_size_reaches_the_console() {
    let launcher = InProcessLauncher::with("mode", cmd(&linger("mode con")));
    let (session, mut events) = open(launcher, "mode").await;
    let mut session = session.unwrap();

    let (out, _) = drive(&mut session, &mut events, None, None).await;
    assert_eq!(columns(&out), Some(100), "got: {out:?}");
}

#[tokio::test]
async fn a_resize_reaches_an_elevated_console() {
    let launcher = InProcessLauncher::with(
        "mode",
        cmd("ping -n 2 127.0.0.1 > nul & mode con & ping -n 2 127.0.0.1 > nul"),
    );
    let (session, mut events) = open(launcher, "mode").await;
    let mut session = session.unwrap();

    let (out, _) = drive(&mut session, &mut events, None, Some((123, 40))).await;
    assert_eq!(columns(&out), Some(123), "got: {out:?}");
}

/// The pane is the only place to say why, since the host has no window.
#[tokio::test]
async fn a_shell_the_host_cannot_start_fails_the_connect_with_its_reason() {
    let launcher = InProcessLauncher::with(
        "missing",
        LocalConfig {
            command: r"C:\definitely\not\a\shell.exe".into(),
            ..Default::default()
        },
    );
    let (result, _) = open(launcher, "missing").await;
    match result {
        Err(LocalError::Spawn { message, .. }) => {
            assert!(message.contains("no such executable"), "got: {message}")
        }
        Err(other) => panic!("expected the host's reason, got {other:?}"),
        Ok(_) => panic!("a missing shell cannot open"),
    }
}

/// Dropping the session — closing the tab, or wRusTTY going away — has to end
/// the host, and with it the administrator shell.
#[tokio::test]
async fn dropping_the_session_ends_the_host() {
    let launcher = InProcessLauncher::with("long", cmd("ping -n 60 127.0.0.1 > nul"));
    let (session, _events) = open(launcher.clone(), "long").await;
    drop(session.unwrap());

    let host = launcher.take_host();
    tokio::time::timeout(Duration::from_secs(10), host)
        .await
        .expect("a sixty-second shell should end when its tab does")
        .unwrap()
        .unwrap();
}

// --- refusals and failures ------------------------------------------------

#[tokio::test]
async fn declining_the_prompt_is_reported_as_declined_and_never_retried() {
    let (result, mut events) = open(Arc::new(DecliningLauncher), "any").await;
    let error = match result {
        Err(e) => e,
        Ok(_) => panic!("a declined prompt cannot open a session"),
    };
    assert!(
        matches!(error, LocalError::ElevationDeclined),
        "got: {error:?}"
    );
    assert!(!ElevatedConnector::retryable(&error));
    assert!(
        statuses_so_far(&mut events)
            .iter()
            .any(|s| matches!(s, ConnectionStatus::Failed(m) if m == "elevation was declined")),
        "the pane should be told plainly"
    );
}

/// No fixed timeout while waiting for the host, since the user may take any
/// time over the prompt — so the tab must notice the host going away instead.
#[tokio::test]
async fn a_host_that_dies_before_its_pipe_exists_fails_promptly() {
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        open(Arc::new(VanishingLauncher), "any"),
    )
    .await
    .expect("the tab must not wait forever for a host that has gone");
    assert!(
        matches!(result.0, Err(LocalError::Elevation(_))),
        "got: {:?}",
        result.0.err()
    );
}

/// The check this phase added: a pipe served by anything but the launched
/// host is refused — and refused before the tab sends it anything at all.
#[tokio::test]
async fn a_pipe_served_by_an_impostor_is_refused_before_anything_is_sent() {
    let received = Arc::new(Mutex::new(None));
    let launcher = Arc::new(ImpostorLauncher {
        received: received.clone(),
    });
    let (result, _) = open(launcher, "any").await;
    match result {
        Err(LocalError::Elevation(message)) => {
            assert!(
                message.contains("not the host that was launched"),
                "got: {message}"
            )
        }
        Err(other) => panic!("expected the impostor to be refused, got {other:?}"),
        Ok(_) => panic!("an impostor's pipe must not become a session"),
    }

    // Give the impostor a moment to read whatever it was going to get.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let got = received.lock().unwrap().clone();
    assert_eq!(
        got.as_deref(),
        Some(b"Ok(None)".as_slice()),
        "the impostor should have seen the connection close with nothing sent"
    );
}
