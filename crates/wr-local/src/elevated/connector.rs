//! The tab's end: a `Connector`/`Session` that reaches an elevated host.
//!
//! Starting the host is not done here. A [`Launcher`] is handed in: the app's
//! runs `wrustty.exe` through `ShellExecuteEx`/`runas` (and so owns the
//! `windows` UI APIs that needs), and the tests' starts the host in-process,
//! unelevated. Everything else — the pipe, the checks, the relay — is the same
//! code either way, which is what lets it be tested without a UAC prompt.
//!
//! The one check that lives here rather than in the host is the mirror of the
//! host's own: **the tab confirms the pipe it reached is served by the process
//! it launched.** Without that there is a window where something that created
//! the pipe name first — which makes the real host refuse to start — gets the
//! tab's connection instead, and with it everything typed into what the user
//! believes is an administrator shell.

use std::future::Future;
use std::os::windows::io::AsRawHandle;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::split;
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
use wr_core::{ConnectionEvent, ConnectionStatus, Connector, DisconnectKind, Session};

use super::host::PIPE_PREFIX;
use super::protocol::{read_frame, write_frame, Frame};
use crate::LocalError;

/// How long the tab waits for the shell to start once it has reached the host.
/// The UAC prompt is already behind it by then; this only bounds a host that
/// connected and then never said anything.
const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// What the tab asks the launcher to start.
pub struct LaunchRequest {
    /// A detected shell id. The launcher puts it on the host's command line,
    /// where it is fixed at the moment the UAC prompt is approved.
    pub shell_id: String,
    pub pipe_name: String,
    /// This process: the only one the host will accept.
    pub client_pid: u32,
}

/// A host that has been started.
pub struct LaunchedHost {
    /// The host's process id: the only server the tab will accept on the pipe.
    pub pid: u32,
    /// Resolves when the host process ends. Lets the tab stop waiting for a
    /// pipe that is never going to appear, instead of guessing a timeout —
    /// there is no sensible one, since the user may take any time over the
    /// UAC prompt.
    pub exited: Pin<Box<dyn Future<Output = ()> + Send>>,
}

#[derive(Debug)]
pub enum LaunchError {
    /// The user said No to the UAC prompt.
    Declined,
    Failed(String),
}

/// Starts an elevated host. See the module comment for why this is injected.
pub trait Launcher: Send + Sync + 'static {
    fn launch(
        &self,
        request: LaunchRequest,
    ) -> Pin<Box<dyn Future<Output = Result<LaunchedHost, LaunchError>> + Send>>;
}

/// Everything needed to open an elevated tab, before one is open.
pub struct ElevatedConnector {
    launcher: Arc<dyn Launcher>,
    shell_id: String,
    size: (u16, u16),
}

impl ElevatedConnector {
    pub fn new(launcher: Arc<dyn Launcher>, shell_id: impl Into<String>) -> Self {
        Self {
            launcher,
            shell_id: shell_id.into(),
            size: (80, 24),
        }
    }

    /// The pane's size, sent to the host as the tab's first message. See
    /// `LocalConnector::with_size` for why it matters at creation.
    pub fn with_size(mut self, cols: u16, rows: u16) -> Self {
        if cols > 0 && rows > 0 {
            self.size = (cols, rows);
        }
        self
    }

    async fn establish(
        self,
        events: &mpsc::Sender<ConnectionEvent>,
    ) -> Result<ElevatedSession, LocalError> {
        let pipe_name = random_pipe_name()?;
        let LaunchedHost {
            pid: host_pid,
            mut exited,
        } = self
            .launcher
            .launch(LaunchRequest {
                shell_id: self.shell_id.clone(),
                pipe_name: pipe_name.clone(),
                client_pid: std::process::id(),
            })
            .await
            .map_err(|e| match e {
                LaunchError::Declined => LocalError::ElevationDeclined,
                LaunchError::Failed(message) => LocalError::Elevation(message),
            })?;

        let client = connect(&pipe_name, &mut exited).await?;
        verify_server(&client, host_pid)?;

        let (mut reader, mut writer) = split(client);
        let (cols, rows) = self.size;
        write_frame(&mut writer, &Frame::Resize { cols, rows })
            .await
            .map_err(|e| LocalError::Elevation(format!("could not reach the host: {e}")))?;

        // Only the pipe is watched from here, not the host's exit. Once
        // connected, the host going away shows up on the pipe itself — what it
        // wrote stays readable, then the pipe ends — and watching the exit as
        // well was a race: a host that could not start the shell writes its
        // `Error` and exits at once, and when the exit won, the reason sitting
        // in the pipe was thrown away for a vaguer one. Found by repeating the
        // test for exactly that case; it failed about one run in three.
        //
        // Cancelling `read_frame` on the timeout loses a partial frame, which
        // is fine: nothing more is read from this pipe after it.
        drop(exited);
        let first = tokio::select! {
            frame = read_frame(&mut reader) => frame,
            _ = tokio::time::sleep(READY_TIMEOUT) => {
                return Err(LocalError::Elevation("the elevated host never started the shell".into()));
            }
        };
        match first {
            Ok(Some(Frame::Ready)) => {}
            Ok(Some(Frame::Error(message))) => {
                return Err(LocalError::Spawn {
                    command: self.shell_id,
                    message,
                })
            }
            Ok(Some(other)) => {
                return Err(LocalError::Elevation(format!(
                    "the host sent {other:?} before the shell started"
                )))
            }
            Ok(None) => {
                return Err(LocalError::Elevation(
                    "the host closed the pipe before the shell started".into(),
                ))
            }
            Err(e) => {
                return Err(LocalError::Elevation(format!(
                    "could not read from the host: {e}"
                )))
            }
        }

        // From here the pipe *is* the session: output flows to the pane, and
        // the pipe ending — the shell exiting, or the host going away — ends it.
        let output = events.clone();
        let reader = tokio::spawn(async move {
            loop {
                match read_frame(&mut reader).await {
                    Ok(Some(Frame::Data(bytes))) => {
                        if output.send(ConnectionEvent::Data(bytes)).await.is_err() {
                            return;
                        }
                    }
                    // Everything else ends the session: the shell exiting, the
                    // host going away, or the host sending something only a tab
                    // sends. Always `Closed`, never `Lost`: an elevated tab is
                    // never reconnected (decision 4), and `Lost` is what would
                    // invite the registry to try.
                    _ => {
                        let _ = output
                            .send(ConnectionEvent::Status(ConnectionStatus::Disconnected(
                                DisconnectKind::Closed,
                            )))
                            .await;
                        return;
                    }
                }
            }
        });

        let (input, mut queued) = mpsc::channel::<Frame>(64);
        let writer = tokio::spawn(async move {
            while let Some(frame) = queued.recv().await {
                if write_frame(&mut writer, &frame).await.is_err() {
                    return;
                }
            }
        });

        Ok(ElevatedSession {
            input: Some(input),
            reader,
            writer,
        })
    }
}

/// Reaches the host's pipe, waiting for it to appear.
///
/// Retries while the pipe does not exist yet, which is the normal state for
/// the moment between the host starting and it creating the pipe — and gives
/// up the moment the host exits, rather than on a timer.
async fn connect(
    pipe_name: &str,
    exited: &mut Pin<Box<dyn Future<Output = ()> + Send>>,
) -> Result<NamedPipeClient, LocalError> {
    /// `ERROR_FILE_NOT_FOUND`: the host has not created the pipe yet.
    const NOT_YET: i32 = 2;
    loop {
        match ClientOptions::new().open(pipe_name) {
            Ok(client) => return Ok(client),
            Err(e) if e.raw_os_error() == Some(NOT_YET) => {
                tokio::select! {
                    _ = &mut *exited => {
                        return Err(LocalError::Elevation(
                            "the elevated host exited before it was ready".into(),
                        ));
                    }
                    _ = tokio::time::sleep(Duration::from_millis(20)) => {}
                }
            }
            Err(e) => {
                return Err(LocalError::Elevation(format!(
                    "could not reach the elevated host: {e}"
                )))
            }
        }
    }
}

/// The pipe must be served by the host this tab launched. See the module
/// comment for what this closes.
fn verify_server(client: &NamedPipeClient, host_pid: u32) -> Result<(), LocalError> {
    let mut pid = 0u32;
    unsafe { GetNamedPipeServerProcessId(HANDLE(client.as_raw_handle()), &mut pid) }
        .map_err(|e| LocalError::Elevation(format!("could not identify the pipe's server: {e}")))?;
    if pid != host_pid {
        return Err(LocalError::Elevation(format!(
            "the pipe is served by process {pid}, not the host that was launched ({host_pid})"
        )));
    }
    Ok(())
}

/// `PIPE_PREFIX` plus 128 random bits, from the OS's own generator. The name
/// is not a secret the design leans on — the checks either side are — but a
/// guessable one would let anything that wanted to race the host do so.
fn random_pipe_name() -> Result<String, LocalError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|e| LocalError::Elevation(format!("no randomness for the pipe name: {e}")))?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("{PIPE_PREFIX}{hex}"))
}

/// A running elevated tab.
pub struct ElevatedSession {
    /// `Option` so closing can drop it, which ends the writer.
    input: Option<mpsc::Sender<Frame>>,
    reader: JoinHandle<()>,
    writer: JoinHandle<()>,
}

impl ElevatedSession {
    /// Closes the pipe, which is how the host learns its tab is gone — and
    /// the host kills the shell when it does. Both halves have to go for the
    /// pipe to close, so both tasks are ended rather than left to wind down.
    fn close(&mut self) {
        self.input.take();
        self.reader.abort();
        self.writer.abort();
    }
}

/// Dropping the session closes the pipe, so no path out of a tab — including
/// one that never calls `disconnect` — leaves an administrator shell behind.
impl Drop for ElevatedSession {
    fn drop(&mut self) {
        self.close();
    }
}

#[async_trait]
impl Connector for ElevatedConnector {
    type Session = ElevatedSession;
    type Error = LocalError;

    async fn connect(
        self,
        events: mpsc::Sender<ConnectionEvent>,
    ) -> Result<ElevatedSession, LocalError> {
        let _ = events
            .send(ConnectionEvent::Status(ConnectionStatus::Connecting))
            .await;
        let result = self.establish(&events).await;
        let status = match &result {
            Ok(_) => ConnectionStatus::Connected,
            Err(e) => ConnectionStatus::Failed(e.to_string()),
        };
        let _ = events.send(ConnectionEvent::Status(status)).await;
        result
    }

    /// Never. Every attempt is a UAC prompt, and a prompt nobody asked for
    /// trains people to click Yes (decision 4).
    fn retryable(_error: &LocalError) -> bool {
        false
    }
}

#[async_trait]
impl Session for ElevatedSession {
    type Error = LocalError;

    async fn write(&mut self, data: &[u8]) -> Result<(), LocalError> {
        let input = self.input.as_ref().ok_or(LocalError::NotConnected)?;
        input
            .send(Frame::Data(data.to_vec()))
            .await
            .map_err(|_| LocalError::NotConnected)
    }

    async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), LocalError> {
        let input = self.input.as_ref().ok_or(LocalError::NotConnected)?;
        input
            .send(Frame::Resize { cols, rows })
            .await
            .map_err(|_| LocalError::NotConnected)
    }

    async fn disconnect(&mut self) -> Result<(), LocalError> {
        if self.input.is_none() {
            return Err(LocalError::NotConnected);
        }
        self.close();
        Ok(())
    }
}
