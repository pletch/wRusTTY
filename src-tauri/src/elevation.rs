//! Elevated tabs, on the app's side: launching the host through UAC, and the
//! Tauri commands a pane talks to. See `docs/ELEVATED_TABS_PLAN.md`.
//!
//! Everything protocol-shaped lives in `wr_local::elevated`. What is here is
//! the part that needs the app: `ShellExecuteEx`'s `runas`, the main window to
//! hang the UAC prompt off, and a session registry for the pane's commands.
//!
//! Host mode — what `wrustty.exe --elevated-host` does when it starts — is
//! [`elevated_entry_point`], which `main` calls before Tauri exists. Debug
//! builds also have `--elevated-smoke`, a manual check of the whole path
//! through a real UAC prompt. Nothing in the frontend calls these commands yet;
//! that is Phase 4.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use wr_local::elevated::connector::{
    ElevatedConnector, LaunchError, LaunchRequest, LaunchedHost, Launcher,
};

use crate::connection_status::status_label;
use crate::local::LocalEvent;
use crate::session_registry::{
    NoPrepare, NoReconnect, NoRestore, ReconnectPolicy, SessionRegistry,
};

/// The shells that may be run as administrator. Decision 2: only detected
/// shells, and not WSL — elevating `wsl.exe` elevates only what WSL runs back
/// on the Windows side, which is more confusing than useful.
pub const ELEVATABLE_SHELLS: &[&str] = &["pwsh", "powershell", "cmd", "git-bash"];

/// Launches the host by running this executable again, as administrator.
pub struct RunasLauncher {
    /// The main window, as a plain integer, so the UAC prompt opens in front
    /// of it rather than wherever the shell decides. See `session_lock.rs` for
    /// why an HWND crosses crate boundaries as an `isize`.
    owner: Option<isize>,
    /// Where to hand keyboard focus back once the prompt closes. `None` in the
    /// smoke test, which has no window.
    app: Option<AppHandle>,
}

impl Launcher for RunasLauncher {
    fn launch(
        &self,
        request: LaunchRequest,
    ) -> Pin<Box<dyn Future<Output = Result<LaunchedHost, LaunchError>> + Send>> {
        let owner = self.owner;
        let app = self.app.clone();
        Box::pin(async move {
            // ShellExecuteEx blocks until the UAC prompt is answered, which
            // can take as long as the user likes.
            let launched = tokio::task::spawn_blocking(move || runas(owner, &request))
                .await
                .map_err(|e| LaunchError::Failed(format!("the launch thread failed: {e}")))?;
            // Whatever the answer — a declined prompt strands focus just as
            // thoroughly as an approved one.
            restore_focus(app.as_ref(), owner);
            launched
        })
    }
}

/// Gives the window its keyboard focus back after the UAC prompt.
///
/// The prompt runs on the secure desktop in a higher-integrity process, and
/// when it closes focus does not come back to us on its own — the same problem
/// the Windows Hello and vault consent prompts have, which is what
/// `win_focus::restore_after_broker_prompt` exists to solve. Without it the
/// user approves the prompt and then types into nothing.
#[cfg(windows)]
fn restore_focus(app: Option<&AppHandle>, owner: Option<isize>) {
    let (Some(app), Some(owner)) = (app, owner) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let hwnd = windows::Win32::Foundation::HWND(owner as *mut std::ffi::c_void);
    crate::win_focus::restore_after_broker_prompt(&window, hwnd);
}

#[cfg(not(windows))]
fn restore_focus(_app: Option<&AppHandle>, _owner: Option<isize>) {}

/// The host's command line. Nothing in it needs quoting, and that is checked
/// rather than assumed: the shell id comes from [`ELEVATABLE_SHELLS`] and the
/// pipe name is a fixed prefix plus hex.
fn host_arguments(request: &LaunchRequest) -> Result<String, LaunchError> {
    if !ELEVATABLE_SHELLS.contains(&request.shell_id.as_str()) {
        return Err(LaunchError::Failed(format!(
            "{} cannot be run as administrator",
            request.shell_id
        )));
    }
    let plain = |s: &str| s.chars().all(|c| c.is_ascii_graphic() && c != '"');
    if !plain(&request.pipe_name) {
        return Err(LaunchError::Failed("unexpected pipe name".into()));
    }
    Ok(format!(
        "--elevated-host --shell {} --pipe {} --client-pid {}",
        request.shell_id, request.pipe_name, request.client_pid
    ))
}

#[cfg(windows)]
fn runas(owner: Option<isize>, request: &LaunchRequest) -> Result<LaunchedHost, LaunchError> {
    use std::ffi::c_void;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, HANDLE, HWND};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::System::Threading::{GetProcessId, WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let parameters = host_arguments(request)?;
    let exe = std::env::current_exe()
        .map_err(|e| LaunchError::Failed(format!("could not find our own executable: {e}")))?;

    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let verb = wide("runas");
    let file = wide(&exe.to_string_lossy());
    let params = wide(&parameters);

    // ShellExecuteEx may hand off to shell extensions, which expect COM;
    // this is a fresh blocking thread, so it has none until it is given some.
    let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        // NOCLOSEPROCESS: keep the host's handle, which is how the tab learns
        // it has exited. NOASYNC: this thread waits out the launch itself.
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        hwnd: HWND(owner.unwrap_or(0) as *mut c_void),
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        // The host has no window to show; this keeps a console from flashing
        // up for it in a debug build, which is a console-subsystem executable.
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    let launched = unsafe { ShellExecuteExW(&mut info) };
    if com.is_ok() {
        unsafe { CoUninitialize() };
    }

    match launched {
        Ok(()) => {}
        Err(e) if e.code() == ERROR_CANCELLED.to_hresult() => return Err(LaunchError::Declined),
        Err(e) => {
            return Err(LaunchError::Failed(format!(
                "could not start the elevated host: {e}"
            )))
        }
    }
    if info.hProcess.is_invalid() {
        return Err(LaunchError::Failed(
            "the elevated host started without a process".into(),
        ));
    }

    let pid = unsafe { GetProcessId(info.hProcess) };
    // Waited on from a thread of its own, started now, so the handle is
    // closed when the host exits whether or not anything is still listening.
    // A future that only waited when polled would leak it on every successful
    // connect, where the tab stops caring about the host's exit.
    let handle = info.hProcess.0 as usize;
    let (gone_tx, gone_rx) = tokio::sync::oneshot::channel::<()>();
    std::thread::spawn(move || {
        let process = HANDLE(handle as *mut c_void);
        unsafe {
            WaitForSingleObject(process, INFINITE);
            let _ = CloseHandle(process);
        }
        let _ = gone_tx.send(());
    });

    Ok(LaunchedHost {
        pid,
        exited: Box::pin(async move {
            let _ = gone_rx.await;
        }),
    })
}

#[cfg(not(windows))]
fn runas(_owner: Option<isize>, _request: &LaunchRequest) -> Result<LaunchedHost, LaunchError> {
    Err(LaunchError::Failed("elevated tabs are Windows-only".into()))
}

pub struct ElevatedState {
    sessions: SessionRegistry<ElevatedConnector>,
}

impl Default for ElevatedState {
    fn default() -> Self {
        Self {
            // Its own prefix, so an elevated session id can never be mistaken
            // for an ordinary local one by any command that routes on it.
            sessions: SessionRegistry::new("elevated"),
        }
    }
}

// Same reason `local_connect` allows it: the argument list is the IPC contract.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn elevated_connect(
    app: AppHandle,
    shell_id: String,
    channel: Channel<LocalEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    cols: u16,
    rows: u16,
    state: State<'_, ElevatedState>,
) -> Result<String, String> {
    // Checked here as well as in the launcher, so a bad id fails before a
    // session id is issued rather than after.
    if !ELEVATABLE_SHELLS.contains(&shell_id.as_str()) {
        return Err(format!("{shell_id} cannot be run as administrator"));
    }
    let owner = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize);

    let launcher = Arc::new(RunasLauncher {
        owner,
        app: Some(app.clone()),
    });

    let session_id = state.sessions.next_session_id();
    state
        .sessions
        .spawn_connect(
            app,
            session_id.clone(),
            ElevatedConnector::new(launcher, shell_id).with_size(cols, rows),
            channel,
            data_channel,
            |status| LocalEvent::Status {
                status: status_label(status),
            },
            None::<NoPrepare>,
            // Never rebuilt unattended, and not only because the policy says
            // so: there is no factory to rebuild it with (decision 4).
            None::<NoReconnect<ElevatedConnector>>,
            None::<NoRestore>,
            ReconnectPolicy {
                enabled: false,
                ..Default::default()
            },
        )
        .await;
    Ok(session_id)
}

#[tauri::command]
pub async fn elevated_write(
    session_id: String,
    data: Vec<u8>,
    state: State<'_, ElevatedState>,
) -> Result<(), String> {
    state.sessions.write(&session_id, &data).await
}

#[tauri::command]
pub async fn elevated_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, ElevatedState>,
    logging: State<'_, crate::logging::LoggingState>,
) -> Result<(), String> {
    crate::logging::note_resize(&logging, &session_id, cols, rows);
    state.sessions.resize(&session_id, cols, rows).await
}

#[tauri::command]
pub async fn elevated_disconnect(
    session_id: String,
    state: State<'_, ElevatedState>,
) -> Result<(), String> {
    state.sessions.disconnect(&session_id).await
}

/// What `main` checks before anything else. `Some(exit code)` when this
/// process was started in one of the elevated modes; `None` for an ordinary
/// launch, which then carries on into [`crate::run`].
///
/// This has to run **before** Tauri, and in particular before
/// `tauri_plugin_single_instance` (see `lib.rs`), which would otherwise see a
/// second `wrustty.exe`, hand its arguments to the running window and exit —
/// quietly turning every elevated tab into a host that never started.
pub fn elevated_entry_point() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--elevated-host") => Some(host_main(&args[1..])),
        // A manual check of the whole path through a real UAC prompt. Debug
        // builds only: a release binary has no business carrying a mode whose
        // purpose is to raise a prompt on demand.
        #[cfg(debug_assertions)]
        Some("--elevated-smoke") => Some(smoke::main(&args[1..])),
        _ => None,
    }
}

/// The host's command line, parsed strictly: exactly these three options, in
/// this order, and nothing else. It is only ever written by
/// [`host_arguments`], so anything that does not match it exactly was not
/// written by us.
#[derive(Debug, PartialEq, Eq)]
struct HostArgs {
    shell_id: String,
    pipe_name: String,
    client_pid: u32,
}

fn parse_host_args(args: &[String]) -> Result<HostArgs, String> {
    match args {
        [shell_flag, shell_id, pipe_flag, pipe_name, pid_flag, pid]
            if shell_flag == "--shell" && pipe_flag == "--pipe" && pid_flag == "--client-pid" =>
        {
            Ok(HostArgs {
                shell_id: shell_id.clone(),
                pipe_name: pipe_name.clone(),
                client_pid: pid.parse().map_err(|_| format!("bad client pid {pid:?}"))?,
            })
        }
        _ => Err("expected --shell <id> --pipe <name> --client-pid <pid>".into()),
    }
}

/// What an elevatable shell id runs, resolved by this — elevated — process's
/// own detection. Nothing the tab sent chooses the executable: only the id
/// travels, and only the ids in [`ELEVATABLE_SHELLS`] resolve at all.
fn resolve_elevatable(shell_id: &str) -> Option<wr_local::LocalConfig> {
    if !ELEVATABLE_SHELLS.contains(&shell_id) {
        return None;
    }
    let shell = crate::local_shells::detect(&crate::local_shells::SystemMachine)
        .into_iter()
        .find(|s| s.id == shell_id)?;
    Some(wr_local::LocalConfig {
        command: shell.command,
        args: shell.args,
        ..Default::default()
    })
}

/// Host mode: serve one elevated shell to one tab, then exit.
///
/// Exit codes are for the record only — the tab learns what happened over the
/// pipe, or from the host's exit, never from the code. There is no window and,
/// in a release build, no console, so there is nowhere else to report to.
fn host_main(args: &[String]) -> i32 {
    let Ok(parsed) = parse_host_args(args) else {
        return 2;
    };
    let Some(shell) = resolve_elevatable(&parsed.shell_id) else {
        return 3;
    };
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    else {
        return 4;
    };
    let outcome = runtime.block_on(wr_local::elevated::host::run_host(
        wr_local::elevated::host::HostConfig {
            pipe_name: parsed.pipe_name,
            client_pid: parsed.client_pid,
            shell,
        },
    ));
    match outcome {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

/// `wrustty.exe --elevated-smoke [shell]`: opens an elevated shell through the
/// real launcher — a real UAC prompt, a real elevated host — runs
/// `whoami /groups` in it, and says whether that shell is actually running at
/// high integrity.
///
/// It exists because the one thing the automated tests cannot cover is the
/// thing most likely to be wrong: whether an unelevated tab can reach an
/// elevated host through the pipe's security descriptor. It has to be
/// `wrustty.exe` itself, because the host refuses any client that is not the
/// same executable as it is.
#[cfg(debug_assertions)]
mod smoke {
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::sync::mpsc;
    use wr_core::{ConnectionEvent, ConnectionStatus, Connector, Session};
    use wr_local::elevated::connector::ElevatedConnector;

    use super::RunasLauncher;

    /// The Mandatory Label SID for High integrity. Looked for rather than the
    /// words "High Mandatory Level", which are localised.
    const HIGH_INTEGRITY_SID: &str = "S-1-16-12288";

    pub(super) fn main(args: &[String]) -> i32 {
        let shell = args.first().cloned().unwrap_or_else(|| "cmd".into());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("a runtime");
        runtime.block_on(run(shell))
    }

    async fn run(shell: String) -> i32 {
        println!("opening an elevated {shell} — approve the UAC prompt to continue");
        let (tx, mut events) = mpsc::channel(256);
        let launcher = Arc::new(RunasLauncher {
            owner: None,
            app: None,
        });
        let mut session = match ElevatedConnector::new(launcher, shell)
            .with_size(120, 30)
            .connect(tx)
            .await
        {
            Ok(session) => session,
            Err(e) => {
                println!("RESULT: could not open the elevated shell: {e}");
                return 1;
            }
        };
        println!("connected to the elevated host; running whoami /groups");

        let mut output = Vec::new();
        let mut sent = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        while let Ok(Some(event)) = tokio::time::timeout_at(deadline, events.recv()).await {
            match event {
                ConnectionEvent::Data(bytes) => {
                    // Stands in for the pane's engine: answer the
                    // pseudoconsole's cursor query, then type.
                    if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                        let _ = session.write(b"\x1b[1;1R").await;
                        if !sent {
                            sent = true;
                            let _ = session.write(b"whoami /groups\r\n").await;
                            tokio::time::sleep(Duration::from_millis(800)).await;
                            let _ = session.write(b"exit\r\n").await;
                        }
                    }
                    output.extend_from_slice(&bytes);
                }
                ConnectionEvent::Status(ConnectionStatus::Disconnected(_)) => break,
                ConnectionEvent::Status(_) => {}
            }
        }

        let text = String::from_utf8_lossy(&output);
        let elevated = text.contains(HIGH_INTEGRITY_SID);
        println!("----- shell output -----\n{text}\n------------------------");
        if elevated {
            println!("RESULT: the shell is running at High integrity — elevated.");
            0
        } else {
            println!("RESULT: no High integrity label in the output — NOT elevated.");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    /// Whatever `host_arguments` writes, `parse_host_args` must read back —
    /// they are the two ends of the host's command line.
    #[test]
    fn the_host_reads_back_exactly_what_the_launcher_writes() {
        let written = host_arguments(&request("pwsh", r"\\.\pipe\wrustty-elevated-ab12")).unwrap();
        let args: Vec<String> = written.split(' ').map(String::from).collect();
        assert_eq!(args[0], "--elevated-host");
        assert_eq!(
            parse_host_args(&args[1..]).unwrap(),
            HostArgs {
                shell_id: "pwsh".into(),
                pipe_name: r"\\.\pipe\wrustty-elevated-ab12".into(),
                client_pid: 4242,
            }
        );
    }

    /// Strict on purpose: anything but the exact form was not written by the
    /// launcher, so the host does not try to make sense of it.
    #[test]
    fn a_host_command_line_in_any_other_shape_is_refused() {
        for args in [
            strings(&[]),
            strings(&["--shell", "cmd"]),
            strings(&["--pipe", "p", "--shell", "cmd", "--client-pid", "1"]),
            strings(&["--shell", "cmd", "--pipe", "p", "--client-pid", "x"]),
            strings(&[
                "--shell",
                "cmd",
                "--pipe",
                "p",
                "--client-pid",
                "1",
                "--extra",
            ]),
        ] {
            assert!(
                parse_host_args(&args).is_err(),
                "{args:?} should be refused"
            );
        }
    }

    /// Only the allowlist resolves — an id the tab could not have sent must not
    /// become something to run as administrator.
    #[test]
    fn only_allowed_shell_ids_resolve() {
        assert!(resolve_elevatable("wsl:Debian").is_none());
        assert!(resolve_elevatable(r"C:\Windows\System32\cmd.exe").is_none());
        assert!(resolve_elevatable("").is_none());
        // cmd.exe is on every Windows machine.
        #[cfg(windows)]
        assert!(resolve_elevatable("cmd").is_some());
    }

    fn request(shell_id: &str, pipe_name: &str) -> LaunchRequest {
        LaunchRequest {
            shell_id: shell_id.into(),
            pipe_name: pipe_name.into(),
            client_pid: 4242,
        }
    }

    #[test]
    fn the_host_command_line_names_the_shell_the_pipe_and_the_client() {
        let args = host_arguments(&request("pwsh", r"\\.\pipe\wrustty-elevated-abc123")).unwrap();
        assert_eq!(
            args,
            r"--elevated-host --shell pwsh --pipe \\.\pipe\wrustty-elevated-abc123 --client-pid 4242"
        );
    }

    /// Decision 2: only detected, non-WSL shells, and never an arbitrary path.
    #[test]
    fn only_the_allowed_shells_can_be_elevated() {
        for id in ["pwsh", "powershell", "cmd", "git-bash"] {
            assert!(host_arguments(&request(id, r"\\.\pipe\wrustty-elevated-1")).is_ok());
        }
        for id in ["wsl:Ubuntu", r"C:\evil.exe", "", "pwsh --command x"] {
            assert!(
                host_arguments(&request(id, r"\\.\pipe\wrustty-elevated-1")).is_err(),
                "{id:?} must not be elevatable"
            );
        }
    }

    /// Nothing on the command line may need quoting, so nothing can smuggle an
    /// extra argument in.
    #[test]
    fn a_pipe_name_that_would_need_quoting_is_refused() {
        for name in [r"\\.\pipe\a b", r#"\\.\pipe\a"b"#] {
            assert!(host_arguments(&request("cmd", name)).is_err(), "{name:?}");
        }
    }
}
