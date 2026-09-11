//! The elevated host, run for real over a named pipe — unelevated.
//!
//! The host asks for no elevation of its own; it runs as whatever launched it.
//! That is what makes everything but the UAC step testable: these start the
//! host in-process, connect to it the way the tab will, and drive a real
//! `cmd.exe` through it. Only `ShellExecuteEx`'s `runas` needs a human.
//!
//! Two groups. The relay — output, input, resize, exit, a shell that won't
//! start — mirrors `tests/spawn.rs`, through the pipe instead of directly.
//! The refusals are decision 3 of `docs/ELEVATED_TABS_PLAN.md`: the pipe
//! serves one client, that client must be the expected process, and a name
//! someone else got to first means the host does not start at all.
#![cfg(windows)]

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tokio::io::split;
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient, ServerOptions};
use tokio::task::JoinHandle;
use wr_local::elevated::host::{run_host, HostConfig, HostError, PIPE_PREFIX};
use wr_local::elevated::protocol::{read_frame, write_frame, Frame};
use wr_local::LocalConfig;

/// A name no other test — or other run — is using.
fn pipe_name() -> String {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!(
        "{PIPE_PREFIX}test-{}-{nanos}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// `cmd.exe /v:on /c <command>` — delayed expansion for the same reason as in
/// `tests/spawn.rs`, where it is explained.
fn cmd(command: &str) -> LocalConfig {
    LocalConfig {
        command: std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into()),
        args: vec!["/v:on".into(), "/c".into(), command.into()],
        ..Default::default()
    }
}

/// Keeps a command alive past the pseudoconsole's first repaint. See
/// `tests/spawn.rs`'s `linger` for the ConPTY behaviour this works around.
fn linger(command: &str) -> String {
    format!("{command} & ping -n 2 127.0.0.1 > nul")
}

/// Starts a host for `shell` that will accept this test process as its client.
fn start_host(name: &str, shell: LocalConfig) -> JoinHandle<Result<(), HostError>> {
    start_host_for(name, shell, std::process::id())
}

fn start_host_for(
    name: &str,
    shell: LocalConfig,
    client_pid: u32,
) -> JoinHandle<Result<(), HostError>> {
    tokio::spawn(run_host(HostConfig {
        pipe_name: name.to_string(),
        client_pid,
        shell,
    }))
}

/// Connects the way the tab will, retrying while the host is still creating
/// the pipe.
async fn connect(name: &str) -> NamedPipeClient {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match ClientOptions::new().open(name) {
            Ok(client) => return client,
            Err(_) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(20)).await
            }
            Err(e) => panic!("could not connect to {name}: {e}"),
        }
    }
}

/// What a session looked like from the tab's side.
#[derive(Default, Debug)]
struct Seen {
    ready: bool,
    output: Vec<u8>,
    exited: bool,
    error: Option<String>,
}

/// Drives a session to its end as a minimal tab would: sends its size first,
/// answers the pseudoconsole's cursor query, optionally sends `input` once the
/// shell is up and `resize` once it is ready, and records what came back.
async fn drive(client: NamedPipeClient, input: Option<&[u8]>, resize: Option<(u16, u16)>) -> Seen {
    let (mut reader, mut writer) = split(client);
    write_frame(
        &mut writer,
        &Frame::Resize {
            cols: 100,
            rows: 30,
        },
    )
    .await
    .unwrap();

    let mut seen = Seen::default();
    let mut input = input;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let frame = match tokio::time::timeout_at(deadline, read_frame(&mut reader)).await {
            Ok(Ok(Some(frame))) => frame,
            _ => break,
        };
        match frame {
            Frame::Ready => {
                seen.ready = true;
                if let Some((cols, rows)) = resize {
                    write_frame(&mut writer, &Frame::Resize { cols, rows })
                        .await
                        .unwrap();
                }
            }
            Frame::Data(bytes) => {
                if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                    write_frame(&mut writer, &Frame::Data(b"\x1b[1;1R".to_vec()))
                        .await
                        .unwrap();
                    if let Some(pending) = input.take() {
                        write_frame(&mut writer, &Frame::Data(pending.to_vec()))
                            .await
                            .unwrap();
                    }
                }
                seen.output.extend_from_slice(&bytes);
            }
            Frame::Exit => {
                seen.exited = true;
                break;
            }
            Frame::Error(message) => {
                seen.error = Some(message);
                break;
            }
            Frame::Resize { .. } => panic!("the host sent a Resize"),
        }
    }
    seen
}

fn text(seen: &Seen) -> String {
    String::from_utf8_lossy(&seen.output).into_owned()
}

/// The width `mode con` reported, read off its `Columns:` line rather than by
/// looking for the number anywhere in the output, where it could turn up for
/// some other reason.
fn columns(seen: &Seen) -> Option<u32> {
    let out = text(seen);
    let at = out.find("Columns:")? + "Columns:".len();
    out[at..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

async fn finish(host: JoinHandle<Result<(), HostError>>) -> Result<(), HostError> {
    tokio::time::timeout(Duration::from_secs(10), host)
        .await
        .expect("the host should finish once its session is over")
        .expect("the host task should not panic")
}

// --- the relay ------------------------------------------------------------

#[tokio::test]
async fn output_and_the_exit_travel_through_the_pipe() {
    let name = pipe_name();
    let host = start_host(&name, cmd(&linger("echo elevated-marker")));
    let seen = drive(connect(&name).await, None, None).await;

    assert!(
        seen.ready,
        "the host should say when the shell is up: {seen:?}"
    );
    assert!(
        text(&seen).contains("elevated-marker"),
        "got: {:?}",
        text(&seen)
    );
    // The exit code arrives as wr-local's own notice, relayed like any output.
    assert!(
        text(&seen).contains("exited with code 0"),
        "got: {:?}",
        text(&seen)
    );
    assert!(seen.exited, "the host should say when the shell exits");
    finish(host)
        .await
        .expect("a shell that ran and exited is a clean finish");
}

#[tokio::test]
async fn input_reaches_the_shell_through_the_pipe() {
    let name = pipe_name();
    let host = start_host(&name, cmd(&linger("set /p line= && echo got-!line!")));
    let seen = drive(connect(&name).await, Some(b"ping\r\n"), None).await;

    assert!(text(&seen).contains("got-ping"), "got: {:?}", text(&seen));
    finish(host).await.unwrap();
}

/// The first Resize is the size the pseudoconsole is created at; `mode con`
/// reports it back from inside the shell.
#[tokio::test]
async fn the_first_resize_sizes_the_console() {
    let name = pipe_name();
    let host = start_host(&name, cmd(&linger("mode con")));
    let seen = drive(connect(&name).await, None, None).await;

    assert_eq!(columns(&seen), Some(100), "got: {:?}", text(&seen));
    finish(host).await.unwrap();
}

/// A resize while the shell runs reaches the pseudoconsole too.
#[tokio::test]
async fn a_later_resize_reaches_the_console() {
    let name = pipe_name();
    let host = start_host(
        &name,
        cmd("ping -n 2 127.0.0.1 > nul & mode con & ping -n 2 127.0.0.1 > nul"),
    );
    let seen = drive(connect(&name).await, None, Some((123, 40))).await;

    assert_eq!(columns(&seen), Some(123), "got: {:?}", text(&seen));
    finish(host).await.unwrap();
}

/// The host has no window of its own, so a shell that cannot start has to be
/// reported to the tab, not merely logged.
#[tokio::test]
async fn a_shell_that_cannot_start_is_reported_to_the_tab() {
    let name = pipe_name();
    let missing = LocalConfig {
        command: r"C:\definitely\not\a\shell.exe".into(),
        ..Default::default()
    };
    let host = start_host(&name, missing);
    let seen = drive(connect(&name).await, None, None).await;

    let error = seen.error.expect("the tab should be told why");
    assert!(error.contains("no such executable"), "got: {error}");
    assert!(!seen.ready);
    finish(host).await.unwrap();
}

/// The tab closing its end is how a tab being closed — or wRusTTY crashing —
/// looks from the host. The shell must not outlive it.
#[tokio::test]
async fn closing_the_tab_ends_the_host_and_its_shell() {
    let name = pipe_name();
    let host = start_host(&name, cmd("ping -n 60 127.0.0.1 > nul"));
    let client = connect(&name).await;
    let (mut reader, mut writer) = split(client);
    write_frame(&mut writer, &Frame::Resize { cols: 80, rows: 24 })
        .await
        .unwrap();
    // Wait until the shell is actually running before walking away from it.
    loop {
        match read_frame(&mut reader).await.unwrap() {
            Some(Frame::Ready) => break,
            Some(_) => continue,
            None => panic!("the host closed before the shell started"),
        }
    }
    drop(reader);
    drop(writer);

    // A sixty-second ping would keep the host alive for a minute if closing
    // the pipe did not end the session.
    finish(host)
        .await
        .expect("the tab closing is a clean finish, not an error");
}

// --- the refusals ---------------------------------------------------------

/// The protocol has no way to be re-aimed, and a host must not accept a name
/// that isn't one of its own.
#[tokio::test]
async fn a_foreign_pipe_name_is_refused() {
    let result = run_host(HostConfig {
        pipe_name: r"\\.\pipe\some-other-application".into(),
        client_pid: std::process::id(),
        shell: cmd("echo never"),
    })
    .await;
    assert!(
        matches!(result, Err(HostError::BadPipeName)),
        "got: {result:?}"
    );
}

/// If something else created the name first, the host must not talk to it or
/// alongside it — it refuses to start.
#[tokio::test]
async fn a_name_someone_else_created_first_stops_the_host() {
    let name = pipe_name();
    let _squatter = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&name)
        .expect("the squatter creates the name first");

    let result = run_host(HostConfig {
        pipe_name: name,
        client_pid: std::process::id(),
        shell: cmd("echo never"),
    })
    .await;
    assert!(
        matches!(result, Err(HostError::Create(_))),
        "got: {result:?}"
    );
}

/// Only the process the host was launched for may connect.
#[tokio::test]
async fn a_client_that_is_not_the_expected_process_is_refused() {
    let name = pipe_name();
    // Any id other than ours: this test process is the one that connects.
    let host = start_host_for(&name, cmd("echo never"), std::process::id() ^ 0x4000_0000);
    let seen = drive(connect(&name).await, None, None).await;

    assert!(
        !seen.ready,
        "a refused client must never see the shell start"
    );
    let result = finish(host).await;
    assert!(
        matches!(result, Err(HostError::ClientRejected(_))),
        "got: {result:?}"
    );
}

/// One tab per host. A second connection is refused by the pipe itself,
/// which was created for exactly one instance.
#[tokio::test]
async fn a_second_client_is_refused() {
    let name = pipe_name();
    let host = start_host(&name, cmd("ping -n 3 127.0.0.1 > nul"));
    let first = connect(&name).await;

    let second = ClientOptions::new().open(&name);
    assert!(
        second.is_err(),
        "a second client must not be able to connect"
    );

    drive(first, None, None).await;
    finish(host).await.unwrap();
}

/// Ready, Exit and Error are the host's to send. A tab sending one is not a
/// peer the host should keep serving — and the shell ends with it.
#[tokio::test]
async fn a_host_only_frame_from_the_tab_ends_the_session() {
    let name = pipe_name();
    let host = start_host(&name, cmd("ping -n 60 127.0.0.1 > nul"));
    let client = connect(&name).await;
    let (mut reader, mut writer) = split(client);
    write_frame(&mut writer, &Frame::Resize { cols: 80, rows: 24 })
        .await
        .unwrap();
    loop {
        if let Some(Frame::Ready) = read_frame(&mut reader).await.unwrap() {
            break;
        }
    }
    write_frame(&mut writer, &Frame::Ready).await.unwrap();

    let result = finish(host).await;
    assert!(
        matches!(result, Err(HostError::UnexpectedFrame("Ready"))),
        "got: {result:?}"
    );
}

/// The size has to come first: the pseudoconsole cannot be created without
/// one, and a client that opens with anything else is not following the
/// protocol.
#[tokio::test]
async fn a_client_that_does_not_send_its_size_first_is_refused() {
    let name = pipe_name();
    let host = start_host(&name, cmd("echo never"));
    let client = connect(&name).await;
    let (_reader, mut writer) = split(client);
    write_frame(&mut writer, &Frame::Data(b"hello".to_vec()))
        .await
        .unwrap();

    let result = finish(host).await;
    assert!(matches!(result, Err(HostError::NoHello)), "got: {result:?}");
}
