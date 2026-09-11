//! The elevated end: a pipe server that runs one shell for one tab.
//!
//! Everything here serves the promises in `docs/ELEVATED_TABS_PLAN.md`:
//!
//! - **It runs only what it was launched with.** The shell arrives as a
//!   [`LocalConfig`] from the caller — resolved from a detected shell id on the
//!   host's command line — and the protocol has no message that could change
//!   it.
//! - **It serves exactly one client**, the wRusTTY that launched it: the pipe
//!   is created as the first and only instance of its name, rejects remote
//!   clients, is open to the current user alone, and the one process that
//!   connects must have the expected process id and be the same executable.
//! - **It never outlives its tab.** When the pipe closes for any reason —
//!   the tab closed, wRusTTY crashed — the shell is killed and the host
//!   returns. `LocalSession`'s `Drop` covers any path that returns early.
//!
//! Nothing here asks for elevation. The host runs as whatever started it, which
//! is what lets `tests/elevated_host.rs` exercise all of it unelevated.

use std::time::Duration;

use tokio::io::split;
use tokio::net::windows::named_pipe::{NamedPipeServer, PipeMode, ServerOptions};
use tokio::sync::mpsc;
use wr_core::{ConnectionEvent, ConnectionStatus, Connector, Session};

use super::protocol::{read_frame, write_frame, Frame, ProtocolError};
use crate::{LocalConfig, LocalConnector};

/// Every elevated-host pipe name starts with this. The rest is 128 random bits
/// chosen by the tab; the host refuses any name that doesn't have the prefix,
/// so it cannot be pointed at some other application's pipe.
pub const PIPE_PREFIX: &str = r"\\.\pipe\wrustty-elevated-";

/// How long the host waits for its tab to connect. The UAC prompt has already
/// been answered by the time the host runs, so the tab connects immediately;
/// this only ends a host whose tab went away in between.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the host waits for the tab's first message, its size.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to keep relaying output after the shell has exited. Its last
/// output and the exit notice come from different threads in `wr-local`, so
/// the notice can arrive a moment before the final bytes do.
const DRAIN_AFTER_EXIT: Duration = Duration::from_millis(250);

pub struct HostConfig {
    /// Must start with [`PIPE_PREFIX`].
    pub pipe_name: String,
    /// The process id of the wRusTTY that launched this host. Only that
    /// process may connect.
    pub client_pid: u32,
    /// What to run. Resolved by the caller from a detected shell id.
    pub shell: LocalConfig,
}

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("pipe name must start with {PIPE_PREFIX}")]
    BadPipeName,
    #[error("could not set up the pipe's security: {0}")]
    Security(String),
    /// Includes the case where something else already owns the name — the
    /// pipe is created as the first instance or not at all.
    #[error("could not create the pipe: {0}")]
    Create(std::io::Error),
    #[error("no client connected within {} seconds", CONNECT_TIMEOUT.as_secs())]
    NoClient,
    #[error("refused a client: {0}")]
    ClientRejected(String),
    #[error("the client did not send its size first")]
    NoHello,
    #[error("the client sent a {0} frame, which only the host may send")]
    UnexpectedFrame(&'static str),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
}

/// Runs the host until its tab is finished with it.
///
/// Returns `Ok` when the shell exited or the tab closed the pipe; either way the
/// shell is gone by the time this returns.
pub async fn run_host(config: HostConfig) -> Result<(), HostError> {
    if !config.pipe_name.starts_with(PIPE_PREFIX) {
        return Err(HostError::BadPipeName);
    }

    // In a block of its own so the descriptor — raw pointers, and so not
    // `Send` — is gone before the first `await`. Dropping it explicitly is not
    // enough: the compiler still counts it as held across the awaits below.
    let server = {
        let security = security::current_user_only()?;
        // SAFETY: `security` outlives the call, and CreateNamedPipe copies
        // what it needs from the attributes before returning.
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .max_instances(1)
                .pipe_mode(PipeMode::Byte)
                .create_with_security_attributes_raw(&config.pipe_name, security.as_ptr())
        }
        .map_err(HostError::Create)?
    };

    tokio::time::timeout(CONNECT_TIMEOUT, server.connect())
        .await
        .map_err(|_| HostError::NoClient)?
        .map_err(HostError::Create)?;
    verify::client(&server, config.client_pid)?;

    let (mut reader, mut writer) = split(server);

    // Frames are read on their own task and handed over on a channel, because
    // `read_frame` is not cancel-safe and the relay below has to `select!`
    // between the pipe and the shell.
    let (frames_tx, mut frames_rx) = mpsc::channel(64);
    tokio::spawn(async move {
        loop {
            let frame = read_frame(&mut reader).await;
            let finished = !matches!(frame, Ok(Some(_)));
            if frames_tx.send(frame).await.is_err() || finished {
                break;
            }
        }
    });

    let (cols, rows) = match tokio::time::timeout(HELLO_TIMEOUT, frames_rx.recv()).await {
        Ok(Some(Ok(Some(Frame::Resize { cols, rows })))) => (cols, rows),
        _ => return Err(HostError::NoHello),
    };

    let (events_tx, mut events_rx) = mpsc::channel(256);
    let mut session = match LocalConnector::new(config.shell)
        .with_size(cols, rows)
        .connect(events_tx)
        .await
    {
        Ok(session) => session,
        Err(e) => {
            // Told to the tab rather than only returned, so the pane can say
            // why — the host has no window of its own to say it in.
            let _ = write_frame(&mut writer, &Frame::Error(e.to_string())).await;
            return Ok(());
        }
    };
    write_frame(&mut writer, &Frame::Ready).await?;

    let outcome = loop {
        tokio::select! {
            event = events_rx.recv() => match event {
                Some(ConnectionEvent::Data(bytes)) => {
                    if let Err(e) = write_frame(&mut writer, &Frame::Data(bytes)).await {
                        break Err(e.into());
                    }
                }
                Some(ConnectionEvent::Status(ConnectionStatus::Disconnected(_))) | None => {
                    drain_output(&mut events_rx, &mut writer).await;
                    let _ = write_frame(&mut writer, &Frame::Exit).await;
                    break Ok(());
                }
                Some(ConnectionEvent::Status(_)) => {}
            },
            frame = frames_rx.recv() => match frame {
                Some(Ok(Some(Frame::Data(bytes)))) => {
                    let _ = session.write(&bytes).await;
                }
                Some(Ok(Some(Frame::Resize { cols, rows }))) => {
                    let _ = session.resize(cols, rows).await;
                }
                // The tab closed its end: it is finished with the shell.
                Some(Ok(None)) | None => break Ok(()),
                Some(Ok(Some(Frame::Ready))) => break Err(HostError::UnexpectedFrame("Ready")),
                Some(Ok(Some(Frame::Exit))) => break Err(HostError::UnexpectedFrame("Exit")),
                Some(Ok(Some(Frame::Error(_)))) => break Err(HostError::UnexpectedFrame("Error")),
                Some(Err(e)) => break Err(e.into()),
            },
        }
    };

    // Whatever ended the relay, the shell ends with it.
    let _ = session.disconnect().await;
    outcome
}

/// Relays whatever output is still arriving after the shell has exited, until
/// it goes quiet.
async fn drain_output<W: tokio::io::AsyncWrite + Unpin>(
    events: &mut mpsc::Receiver<ConnectionEvent>,
    writer: &mut W,
) {
    while let Ok(Some(event)) = tokio::time::timeout(DRAIN_AFTER_EXIT, events.recv()).await {
        if let ConnectionEvent::Data(bytes) = event {
            if write_frame(writer, &Frame::Data(bytes)).await.is_err() {
                return;
            }
        }
    }
}

/// Deciding whether the process that connected is the one that may.
mod verify {
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};

    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    use super::{HostError, NamedPipeServer};

    /// The client must be the expected process, running the same executable as
    /// this host.
    ///
    /// The process id alone would do while that process is alive — ids are not
    /// reused until it exits — but checking the image too means a host launched
    /// with a stale or wrong id cannot end up serving an unrelated program.
    pub(super) fn client(server: &NamedPipeServer, expected_pid: u32) -> Result<(), HostError> {
        let handle = HANDLE(server.as_raw_handle());
        let mut pid = 0u32;
        unsafe { GetNamedPipeClientProcessId(handle, &mut pid) }
            .map_err(|e| HostError::ClientRejected(format!("could not identify it: {e}")))?;
        if pid != expected_pid {
            return Err(HostError::ClientRejected(format!(
                "expected process {expected_pid}, but process {pid} connected"
            )));
        }

        let theirs = image_of(pid)?;
        let ours = std::env::current_exe()
            .map_err(|e| HostError::ClientRejected(format!("could not find our own image: {e}")))?;
        if !same_file(&theirs, &ours) {
            return Err(HostError::ClientRejected(format!(
                "process {pid} is {}, not {}",
                theirs.display(),
                ours.display()
            )));
        }
        Ok(())
    }

    fn image_of(pid: u32) -> Result<PathBuf, HostError> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            .map_err(|e| HostError::ClientRejected(format!("could not open process {pid}: {e}")))?;
        let mut buf = vec![0u16; 32 * 1024];
        let mut len = buf.len() as u32;
        let result = unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
        };
        unsafe {
            let _ = CloseHandle(process);
        }
        result.map_err(|e| {
            HostError::ClientRejected(format!("could not read process {pid}'s image: {e}"))
        })?;
        Ok(PathBuf::from(String::from_utf16_lossy(
            &buf[..len as usize],
        )))
    }

    /// Paths compared after resolving them, and without regard to case, which
    /// is how the filesystem compares them.
    fn same_file(a: &Path, b: &Path) -> bool {
        let resolve = |p: &Path| {
            std::fs::canonicalize(p)
                .unwrap_or_else(|_| p.to_path_buf())
                .to_string_lossy()
                .to_lowercase()
        };
        resolve(a) == resolve(b)
    }
}

/// The pipe's security descriptor.
mod security {
    use std::ffi::c_void;

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    use super::HostError;

    /// Attributes for a pipe that only the current user can open, and that a
    /// normal (medium-integrity) process can write to.
    ///
    /// Both halves are needed because of who creates the pipe. An elevated
    /// process's objects default to a *high* integrity label, and Windows'
    /// no-write-up rule then stops the unelevated tab from writing to its own
    /// pipe. Their default permissions also go to the elevated token's owner —
    /// usually the Administrators group, which the tab's filtered token only
    /// holds as deny-only. So the defaults would lock out the one client this
    /// pipe exists for, while granting read access to Everyone.
    ///
    /// `D:P(A;;GA;;;<you>)` — a protected DACL giving full access to the
    /// current user and no one else. `S:(ML;;NW;;;ME)` — a medium mandatory
    /// label with no-write-up, so a medium process may write and a low one may
    /// not. Lowering an object's label below the creator's own is allowed.
    pub(super) struct PipeSecurity {
        attrs: SECURITY_ATTRIBUTES,
        descriptor: PSECURITY_DESCRIPTOR,
    }

    impl PipeSecurity {
        pub(super) fn as_ptr(&self) -> *mut c_void {
            &self.attrs as *const SECURITY_ATTRIBUTES as *mut c_void
        }
    }

    impl Drop for PipeSecurity {
        fn drop(&mut self) {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.descriptor.0)));
            }
        }
    }

    pub(super) fn current_user_only() -> Result<PipeSecurity, HostError> {
        let sid = current_user_sid()?;
        let sddl = format!("D:P(A;;GA;;;{sid})S:(ML;;NW;;;ME)");
        let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(wide.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .map_err(|e| HostError::Security(format!("could not build the descriptor: {e}")))?;
        Ok(PipeSecurity {
            attrs: SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                bInheritHandle: false.into(),
            },
            descriptor,
        })
    }

    /// The current user's SID as a string, from this process's own token.
    ///
    /// The elevated token belongs to the same user as the tab's filtered one,
    /// so the SID read here is the tab's too.
    fn current_user_sid() -> Result<String, HostError> {
        let fail =
            |what: &str, e: windows::core::Error| HostError::Security(format!("{what}: {e}"));

        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
            .map_err(|e| fail("could not open the process token", e))?;

        // Asked for its size first. `u64` elements so the buffer is aligned for
        // the TOKEN_USER read out of it.
        let mut len = 0u32;
        let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut len) };
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        let read = unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                Some(buf.as_mut_ptr() as *mut c_void),
                len,
                &mut len,
            )
        };
        unsafe {
            let _ = CloseHandle(token);
        }
        read.map_err(|e| fail("could not read the token's user", e))?;

        let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
        let mut text = PWSTR::null();
        unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) }
            .map_err(|e| fail("could not format the SID", e))?;
        let sid = unsafe { text.to_string() };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(text.0 as *mut c_void)));
        }
        sid.map_err(|e| HostError::Security(format!("SID was not valid text: {e}")))
    }
}
