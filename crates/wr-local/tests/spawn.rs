//! The parts of a local shell only a real pseudoconsole can prove: output
//! reaches the event channel, an exit is noticed with its code, and the
//! status is `Closed` rather than `Lost` (so auto-reconnect doesn't resurrect
//! a shell someone left). These spawn real processes using only what every
//! machine of the platform has.
//!
//! # They answer a cursor-position query
//!
//! ConPTY opens with `ESC [ 6 n` and pumps nothing else until answered. In the
//! app, Ghostty's VT core replies through the same channel as keystrokes;
//! [`drive`] is a minimal stand-in that answers only that query.
//!
//! # They keep the child alive past the first repaint
//!
//! See [`linger`].

use std::time::Duration;

use tokio::sync::mpsc;
use wr_core::{ConnectionEvent, ConnectionStatus, Connector, DisconnectKind, Session};
use wr_local::{LocalConfig, LocalConnector, LocalSession};

/// The query ConPTY blocks on, and an answer to it.
const DSR_CURSOR_POSITION: &[u8] = b"\x1b[6n";
const CURSOR_AT_ORIGIN: &[u8] = b"\x1b[1;1R";

/// A shell that's always present, with flags to run one command and exit.
/// `cmd.exe` gets `/v:on` (delayed expansion), or a variable set earlier in
/// the line reads as empty later in it.
fn shell(command: &str) -> LocalConfig {
    #[cfg(windows)]
    let (program, args) = (
        std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into()),
        vec!["/v:on".to_string(), "/c".to_string(), command.to_string()],
    );
    #[cfg(not(windows))]
    let (program, args) = (
        "/bin/sh".to_string(),
        vec!["-c".to_string(), command.to_string()],
    );

    LocalConfig {
        command: program,
        args,
        ..Default::default()
    }
}

/// Keeps a command alive past ConPTY's first repaint.
///
/// ConPTY emits a rendered view of the screen buffer on its own schedule, so
/// a process that writes and exits within a millisecond may never have its
/// output emitted (the exit code still arrives). Every Windows terminal has
/// this; it doesn't affect a shell someone is typing at, only these tests'
/// fast commands.
fn linger(command: &str) -> String {
    // `&`, not `&&`: wait even if the command failed.
    #[cfg(windows)]
    return format!("{command} & ping -n 2 127.0.0.1 > nul");
    #[cfg(not(windows))]
    return format!("{command}; sleep 1");
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Runs a session to its end, standing in for the terminal on the other side.
/// Returns everything written and every status. Bounded by a deadline, so a
/// session that never reports its exit fails rather than hangs.
///
/// On Windows, `input` is written once the opening query is answered, when
/// the pseudoconsole is known to be up.
async fn drive(
    session: &mut LocalSession,
    rx: &mut mpsc::Receiver<ConnectionEvent>,
    input: Option<&[u8]>,
) -> (Vec<u8>, Vec<ConnectionStatus>) {
    let mut output = Vec::new();
    let mut statuses = Vec::new();
    let mut input = input;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);

    // A Unix pty asks nothing, and its line discipline holds input until read.
    #[cfg(not(windows))]
    if let Some(pending) = input.take() {
        let _ = session.write(pending).await;
    }

    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        match event {
            ConnectionEvent::Data(bytes) => {
                if contains(&bytes, DSR_CURSOR_POSITION) {
                    let _ = session.write(CURSOR_AT_ORIGIN).await;
                    if let Some(pending) = input.take() {
                        let _ = session.write(pending).await;
                    }
                }
                output.extend_from_slice(&bytes);
            }
            ConnectionEvent::Status(status) => {
                let terminal = matches!(status, ConnectionStatus::Disconnected(_));
                statuses.push(status);
                if terminal {
                    break;
                }
            }
        }
    }
    (output, statuses)
}

#[tokio::test]
async fn output_reaches_the_channel_and_the_exit_is_reported() {
    let (tx, mut rx) = mpsc::channel(64);
    let mut session = LocalConnector::new(shell(&linger("echo wrustty-marker")))
        .connect(tx)
        .await
        .expect("a shell every machine has should start");

    let (output, statuses) = drive(&mut session, &mut rx, None).await;

    let text = String::from_utf8_lossy(&output);
    assert!(
        text.contains("wrustty-marker"),
        "the child's stdout should reach the event channel, got: {text:?}"
    );
    // An exit is noticed at all. On Unix this also fails if `session.rs` stops
    // dropping the slave; on Windows EOF comes from conhost.
    assert!(
        matches!(
            statuses.last(),
            Some(ConnectionStatus::Disconnected(DisconnectKind::Closed))
        ),
        "a shell that finished should end Closed, got: {statuses:?}"
    );
    assert!(
        statuses.contains(&ConnectionStatus::Connected),
        "Connected should precede the disconnect, got: {statuses:?}"
    );
}

#[tokio::test]
async fn a_non_zero_exit_code_is_reported_and_is_still_closed() {
    let (tx, mut rx) = mpsc::channel(64);
    // No `linger`: the notice comes from the wait thread, not ConPTY's renderer.
    let mut session = LocalConnector::new(shell("exit 3"))
        .connect(tx)
        .await
        .expect("a shell every machine has should start");

    let (output, statuses) = drive(&mut session, &mut rx, None).await;

    let text = String::from_utf8_lossy(&output);
    assert!(
        text.contains("exited with code 3"),
        "the exit code belongs in the scrollback that explains it, got: {text:?}"
    );
    // Decision 5 in docs/LOCAL_SHELL_PLAN.md: a failed command is still finished.
    assert!(
        matches!(
            statuses.last(),
            Some(ConnectionStatus::Disconnected(DisconnectKind::Closed))
        ),
        "a non-zero exit is Closed, not Lost, got: {statuses:?}"
    );
}

#[tokio::test]
async fn input_reaches_the_child() {
    // Echoes one line back, proving the input crossed the pseudoconsole.
    #[cfg(windows)]
    let config = shell(&linger("set /p line= && echo got-!line!"));
    #[cfg(not(windows))]
    let config = shell(&linger("read line && echo got-$line"));

    let (tx, mut rx) = mpsc::channel(64);
    let mut session = LocalConnector::new(config)
        .connect(tx)
        .await
        .expect("a shell every machine has should start");

    let (output, _) = drive(&mut session, &mut rx, Some(b"ping\r\n")).await;

    let text = String::from_utf8_lossy(&output);
    assert!(
        text.contains("got-ping"),
        "input should reach the child, got: {text:?}"
    );
}

#[tokio::test]
async fn a_missing_executable_fails_without_opening_a_pseudoconsole() {
    let config = LocalConfig {
        command: "definitely-not-a-shell-on-this-machine".into(),
        ..Default::default()
    };

    let (tx, mut rx) = mpsc::channel(64);
    // Matched rather than `expect_err`, which would need `LocalSession: Debug`.
    let error = match LocalConnector::new(config).connect(tx).await {
        Ok(_) => panic!("a command that does not exist cannot start"),
        Err(e) => e,
    };

    assert!(
        matches!(error, wr_local::LocalError::NotFound { .. }),
        "a stale profile should be told apart from a spawn failure, got: {error:?}"
    );
    // See `LocalConnector::retryable`.
    assert!(!LocalConnector::retryable(&error));

    let mut statuses = Vec::new();
    while let Ok(ConnectionEvent::Status(status)) = rx.try_recv() {
        statuses.push(status);
    }
    assert!(
        statuses
            .iter()
            .any(|s| matches!(s, ConnectionStatus::Failed(_))),
        "a failed start should say so on the channel, got: {statuses:?}"
    );
}

#[tokio::test]
async fn resize_is_accepted_on_a_live_session() {
    // Still running when the resize lands, without slowing the suite.
    #[cfg(windows)]
    let config = shell("ping -n 3 127.0.0.1 > nul");
    #[cfg(not(windows))]
    let config = shell("sleep 2");

    let (tx, _rx) = mpsc::channel(64);
    let mut session = LocalConnector::new(config)
        .with_size(100, 30)
        .connect(tx)
        .await
        .expect("a shell every machine has should start");

    session
        .resize(120, 40)
        .await
        .expect("resizing a live pseudoconsole should work");

    session
        .disconnect()
        .await
        .expect("disconnecting a live session should work");

    // Disconnect kills rather than waiting on EOF, and everything after refuses.
    assert!(
        session.resize(80, 24).await.is_err(),
        "a disconnected session should refuse further work"
    );
}
