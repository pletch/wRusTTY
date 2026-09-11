//! Elevated tabs, on the app's side: launching the host through UAC, and the
//! Tauri commands a pane talks to. See `docs/ELEVATED_TABS_PLAN.md`.
//!
//! Everything protocol-shaped lives in `wr_local::elevated`. What is here is
//! the part that needs the app: `ShellExecuteEx`'s `runas`, the main window to
//! hang the UAC prompt off, and a session registry for the pane's commands.
//!
//! Host mode itself — what `wrustty.exe --elevated-host` does when it starts —
//! is not here yet; it is Phase 3. Until then a launch reaches the UAC prompt
//! and the host exits without serving the pipe, which the tab reports as the
//! host having gone away. Nothing in the frontend calls these commands yet.

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
}

impl Launcher for RunasLauncher {
    fn launch(
        &self,
        request: LaunchRequest,
    ) -> Pin<Box<dyn Future<Output = Result<LaunchedHost, LaunchError>> + Send>> {
        let owner = self.owner;
        Box::pin(async move {
            // ShellExecuteEx blocks until the UAC prompt is answered, which
            // can take as long as the user likes.
            tokio::task::spawn_blocking(move || runas(owner, &request))
                .await
                .map_err(|e| LaunchError::Failed(format!("the launch thread failed: {e}")))?
        })
    }
}

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

    let session_id = state.sessions.next_session_id();
    state
        .sessions
        .spawn_connect(
            app,
            session_id.clone(),
            ElevatedConnector::new(Arc::new(RunasLauncher { owner }), shell_id)
                .with_size(cols, rows),
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

#[cfg(test)]
mod tests {
    use super::*;

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
