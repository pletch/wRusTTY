//! The parts of a local shell that only a real pseudoconsole can prove.
//!
//! The unit tests in `config.rs` cover the serde shape and nothing else. What
//! matters about this crate is the loop: that output reaches the event channel,
//! that a child exiting is noticed at all, that its exit code arrives, and that
//! the status which follows is `Closed` rather than `Lost` — because the last
//! of those is what keeps auto-reconnect from resurrecting a shell somebody
//! deliberately left.
//!
//! These spawn actual processes, using only what every machine of their
//! platform already has. Two ConPTY behaviours shape how they are written, and
//! both were found by writing them the obvious way first and watching them
//! fail.
//!
//! # They answer a cursor-position query
//!
//! ConPTY opens by writing `ESC [ 6 n` — "where is the cursor?" — and **waits
//! for the answer before it will pump anything else**. Attach nothing to the
//! other end and a shell that should print one word and exit produces exactly
//! six bytes and then hangs.
//!
//! Answering is the emulator's job, not this crate's: in the app the bytes
//! reach Ghostty's VT core, which generates the reply and sends it back out
//! through the same channel as keystrokes (see the comment at
//! `GhosttyEngine.ts:1702`, which calls out that the output channel carries
//! query replies alongside typing). Doing it in `wr-local` would mean answering
//! queries a real terminal should answer differently, and racing the engine to
//! do it. So [`drive`] is a deliberately minimal stand-in for that terminal: it
//! answers the one query ConPTY blocks on and nothing else.
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

/// A shell that is always present, and the flags that make it run one command
/// and leave.
///
/// `cmd.exe` gets `/v:on` for delayed expansion. Without it `%var%` in a
/// command is substituted when the whole line is parsed — *before* any of it
/// runs — so a variable set by one part of the line reads as empty in the next,
/// and a test that round-trips input through the child silently asserts on the
/// wrong thing.
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
/// ConPTY emits a *rendered view* of the console screen buffer, not the child's
/// byte stream, and it paints on its own schedule. A process that writes a line
/// and exits within a millisecond can be gone before the first paint, and its
/// output is then never emitted at all — the session still reports the right
/// exit code, but the text is simply not there. Measured here: `echo` alone
/// produced only ConPTY's own init sequences; the same `echo` followed by a
/// one-second wait produced the text.
///
/// This is ConPTY's behaviour rather than something this crate can fix, and
/// every Windows terminal has it. It does not reach the app, where a shell
/// someone is typing at lives for minutes and is painted continuously. It
/// reaches these tests only because they run commands that would otherwise
/// finish faster than the renderer, so the wait below buys determinism rather
/// than papering over a defect.
fn linger(command: &str) -> String {
    // `&` rather than `&&`: the wait has to happen even when the command
    // failed, or a test asserting on a non-zero exit loses its output again.
    #[cfg(windows)]
    return format!("{command} & ping -n 2 127.0.0.1 > nul");
    #[cfg(not(windows))]
    return format!("{command}; sleep 1");
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Runs a session to its end, standing in for the terminal that would normally
/// be on the other side.
///
/// Returns everything the child wrote and every status it reported. Bounded by
/// a deadline rather than by draining until the channel closes: a session that
/// never reports its exit is exactly the bug worth failing on, and without a
/// deadline that bug hangs the suite instead of failing it.
///
/// `input` is written once the pseudoconsole is known to be up — that is, right
/// after its opening query is answered. Writing before that point is a race:
/// the bytes go into the pty either way, but whether the child has started
/// reading yet is not something the test can know.
async fn drive(
    session: &mut LocalSession,
    rx: &mut mpsc::Receiver<ConnectionEvent>,
    input: Option<&[u8]>,
) -> (Vec<u8>, Vec<ConnectionStatus>) {
    let mut output = Vec::new();
    let mut statuses = Vec::new();
    let mut input = input;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);

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
    // The assertion that a shell exiting is noticed at all. On Unix it is also
    // what fails if `session.rs` stops dropping the slave; on Windows EOF comes
    // from conhost instead, so there it guards the wait thread rather than the
    // handle discipline.
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
    // No `linger` needed: the notice this asserts on is generated here from the
    // wait thread's exit status, not painted by ConPTY, so it cannot be lost to
    // the renderer race.
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
    // Decision 5 in docs/LOCAL_SHELL_PLAN.md: a failed command is still a
    // finished one. `Lost` here would let auto-reconnect respawn a shell that
    // crashed, which is precisely the case where the scrollback is evidence.
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
    // Reads one line and echoes it back, so the only way the assertion passes
    // is if the bytes written below actually crossed the pseudoconsole.
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
    // Matched rather than `expect_err`, which would need `LocalSession: Debug`
    // — and a session holding two trait objects has nothing useful to print.
    let error = match LocalConnector::new(config).connect(tx).await {
        Ok(_) => panic!("a command that does not exist cannot start"),
        Err(e) => e,
    };

    assert!(
        matches!(error, wr_local::LocalError::NotFound { .. }),
        "a stale profile should be told apart from a spawn failure, got: {error:?}"
    );
    // Retrying this on a timer would spend the whole reconnect budget to
    // arrive at the same message later — see `LocalConnector::retryable`.
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
    // Long enough to still be running when the resize lands, short enough not
    // to slow the suite if something goes wrong.
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

    // A pane the user closed has to actually close, so disconnect kills rather
    // than waiting to see whether EOF was enough — and everything afterwards
    // has to refuse rather than look alive.
    assert!(
        session.resize(80, 24).await.is_err(),
        "a disconnected session should refuse further work"
    );
}
