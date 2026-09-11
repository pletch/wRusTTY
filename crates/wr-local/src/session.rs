use std::io::{Read, Write};
use std::path::Path;

use async_trait::async_trait;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;
use wr_core::{ConnectionEvent, ConnectionStatus, Connector, DisconnectKind, Session};

use crate::config::LocalConfig;
use crate::error::LocalError;

/// The size a pseudoconsole is opened at before the frontend says what the
/// pane actually is.
///
/// A ConPTY has to be given a size at creation — unlike telnet's NAWS or an
/// SSH pty-req, there is no "decide later". The registry applies the real size
/// moments afterwards (`Slot::Connecting` holds it and replays it on publish),
/// so this is only ever what the shell sees for its first prompt. 80x24
/// because a shell that prints a banner before the resize arrives should wrap
/// it somewhere conventional.
const INITIAL_SIZE: (u16, u16) = (80, 24);

/// How much output is taken from the pseudoconsole in one read.
///
/// The bounded event channel is what applies backpressure (see
/// `wr_core::Connector`), so this only sets how coarsely that happens. 32 KiB
/// keeps a `cat` of something large from being ten thousand channel sends.
const READ_BUF: usize = 32 * 1024;

/// Everything needed to launch a local shell, before one is running.
pub struct LocalConnector {
    config: LocalConfig,
    size: (u16, u16),
}

impl LocalConnector {
    pub fn new(config: LocalConfig) -> Self {
        Self {
            config,
            size: INITIAL_SIZE,
        }
    }

    /// Open the pseudoconsole at the size the pane already is.
    ///
    /// Worth passing when the caller knows it: without this the shell draws
    /// its first prompt at 80 columns and is resized immediately after, which
    /// a shell with a wide prompt renders as a visible reflow on every
    /// connect.
    pub fn with_size(mut self, cols: u16, rows: u16) -> Self {
        if cols > 0 && rows > 0 {
            self.size = (cols, rows);
        }
        self
    }

    fn spawn(self, events: &mpsc::Sender<ConnectionEvent>) -> Result<LocalSession, LocalError> {
        let config = self.config;
        let command = config.command.clone();

        // Checked here rather than recovered from the spawn error, because
        // `portable-pty` reports one as an `anyhow::Error` whose text is
        // platform-specific. This is also the earlier failure: nothing is
        // allocated yet, so a stale profile costs a `stat` rather than a
        // pseudoconsole.
        if !Path::new(&command).is_file() {
            return Err(LocalError::NotFound { command });
        }

        let (cols, rows) = self.size;
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| LocalError::Pty(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&command);
        cmd.args(&config.args);

        // A shell launched with no working directory inherits this process's,
        // which is wherever the app was started from — an installer directory,
        // or the system directory when launched from a shortcut. Neither is
        // what someone opening a terminal means, so the fallback is home.
        match config.cwd.as_deref() {
            Some(dir) => cmd.cwd(dir),
            None => {
                if let Some(home) = home_dir() {
                    cmd.cwd(home);
                }
            }
        }

        // `CommandBuilder` seeds itself from this process's environment
        // (`get_base_env`) and `env` overlays onto that, which is the
        // "additions, not replacement" behaviour `LocalConfig::env` documents.
        // TERM goes down first so a profile can override it like anything
        // else.
        cmd.env("TERM", config.term_type());
        for (key, value) in &config.env {
            cmd.env(key, value);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| LocalError::Spawn {
                command: command.clone(),
                message: e.to_string(),
            })?;

        // Drop the slave now that the child holds its own handles.
        //
        // On Unix this is load-bearing: the slave is an open fd on the pty, and
        // while it exists the reader below never sees EOF, so a shell that has
        // already exited leaves the pane looking connected forever.
        //
        // On Windows it is deliberately *not* load-bearing, and it is worth
        // saying so rather than leaving the next reader to assume the Unix
        // reasoning applies. `portable-pty` gives `ConPtyMasterPty` and
        // `ConPtySlavePty` the same `Arc<Mutex<Inner>>`, and `Inner` is what
        // owns the `PsuedoCon` whose `Drop` calls `ClosePseudoConsole` — so
        // dropping this half only decrements a refcount the master still holds.
        // EOF there comes from conhost closing the pipe when the child exits.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| LocalError::Pty(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| LocalError::Pty(e.to_string()))?;
        let killer = child.clone_killer();

        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(64);

        spawn_reader(reader, events.clone());
        spawn_writer(writer, input_rx);

        // The child is moved into its own thread because `wait` blocks, and
        // `clone_killer` above is what lets `disconnect` still reach it from
        // outside. This thread is the *only* source of a terminal status for
        // the session — the reader hitting EOF deliberately says nothing, so
        // that the status carrying the exit code is never raced by one that
        // does not.
        let label = config.label().to_string();
        let events = events.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            let code = match &status {
                Ok(status) => Some(status.exit_code()),
                Err(e) => {
                    tracing::warn!(shell = %label, error = %e, "waiting on local shell failed");
                    None
                }
            };
            if let Some(code) = code {
                let _ = events.blocking_send(ConnectionEvent::Data(exit_notice(code)));
            }
            // `Closed`, not `Lost`, even for a non-zero code: the process
            // finished, which is what `exit` looks like from here, and
            // `DisconnectKind` exists to keep auto-reconnect from undoing a
            // deliberate one. A shell that crashed is still a shell that is
            // over, and decision 5 in docs/LOCAL_SHELL_PLAN.md is why nothing
            // resurrects it.
            let _ = events.blocking_send(ConnectionEvent::Status(ConnectionStatus::Disconnected(
                DisconnectKind::Closed,
            )));
        });

        Ok(LocalSession {
            master: pair.master,
            input_tx: Some(input_tx),
            killer,
        })
    }
}

/// The line a pane shows when its shell exits.
///
/// Written into the output stream rather than carried on the status, because
/// `ConnectionStatus::Disconnected` has no field for it and giving it one
/// would touch every transport's match arms to serve a case only this one has.
/// Putting it in the stream is also what every other terminal does — Windows
/// Terminal, WezTerm and kitty all print a variation of this line — and it
/// puts the exit code where the user is already looking, in the scrollback
/// that explains it, which survives for as long as the dead pane does.
///
/// Dim rather than coloured: it is a footnote about the session, not output
/// from the command, and it should not be mistaken for something the shell
/// printed.
fn exit_notice(code: u32) -> Vec<u8> {
    format!("\r\n\x1b[2m[process exited with code {code}]\x1b[0m\r\n").into_bytes()
}

/// Drains the pseudoconsole into the event channel until EOF.
///
/// Says nothing when it ends. EOF here means the child's last handle to the
/// pty closed, which the wait thread is about to report with an exit code
/// attached — reporting it from both places would race, and the loser would
/// be the one carrying the information.
fn spawn_reader(mut reader: Box<dyn Read + Send>, events: mpsc::Sender<ConnectionEvent>) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Blocking on a full channel is the backpressure: it slows
                    // this thread, which stops draining the pty, which
                    // eventually blocks the child's own writes. A failed send
                    // means the receiver is gone, so the session is over.
                    if events
                        .blocking_send(ConnectionEvent::Data(buf[..n].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => {
                    // A broken pipe here is the ordinary shape of the child
                    // exiting, not a fault worth reporting at warn.
                    tracing::debug!(error = %e, "local shell read ended");
                    break;
                }
            }
        }
    });
}

/// Feeds keystrokes to the pseudoconsole.
///
/// Ends when the sender is dropped, and dropping the writer as it returns is
/// what sends EOF to the child — which is how `disconnect` asks a shell to
/// finish before it resorts to killing it.
fn spawn_writer(mut writer: Box<dyn Write + Send>, mut input_rx: mpsc::Receiver<Vec<u8>>) {
    std::thread::spawn(move || {
        while let Some(data) = input_rx.blocking_recv() {
            if writer.write_all(&data).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });
}

/// The user's home directory, without taking a dependency to find it.
///
/// `dirs` is already in the graph via the app, but this crate has no other
/// need of it and the answer here is one variable on each platform.
fn home_dir() -> Option<String> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok().filter(|s| !s.is_empty())
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok().filter(|s| !s.is_empty())
    }
}

/// A running local shell.
pub struct LocalSession {
    /// Kept solely for `resize`. The reader and writer were split off it at
    /// connect time and live on their own threads.
    master: Box<dyn MasterPty + Send>,
    /// `Option` only so `disconnect` can drop the sender, which is what ends
    /// the writer thread and sends EOF to the child. Always `Some` on a
    /// freshly connected session — the same shape `SerialSession` uses, for
    /// the same reason.
    input_tx: Option<mpsc::Sender<Vec<u8>>>,
    /// Split from the child before it was moved into the wait thread, since
    /// that thread is blocked in `wait` and cannot be asked for anything.
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// A session going away takes its shell with it.
///
/// `disconnect` already kills the child, and every well-behaved owner calls
/// it. This is for the owner that doesn't get the chance — an early return,
/// a panic, a task cancelled mid-await — where the alternative is a shell
/// left running with nothing attached to it. That matters most for the
/// elevated host (see `elevated::host`): an administrator shell that outlives
/// the tab that asked for it is exactly what that design promises cannot
/// happen. Killing an already-exited child is a harmless error.
impl Drop for LocalSession {
    fn drop(&mut self) {
        let _ = self.killer.kill();
    }
}

#[async_trait]
impl Connector for LocalConnector {
    type Session = LocalSession;
    type Error = LocalError;

    async fn connect(
        self,
        events: mpsc::Sender<ConnectionEvent>,
    ) -> Result<LocalSession, LocalError> {
        let _ = events
            .send(ConnectionEvent::Status(ConnectionStatus::Connecting))
            .await;
        let label = self.config.label().to_string();
        let result = self.spawn(&events);
        match &result {
            Ok(_) => {
                let _ = events
                    .send(ConnectionEvent::Status(ConnectionStatus::Connected))
                    .await;
            }
            Err(e) => {
                let _ = events
                    .send(ConnectionEvent::Status(ConnectionStatus::Failed(
                        e.to_string(),
                    )))
                    .await;
                tracing::warn!(shell = %label, error = %e, "local shell failed to start");
            }
        }
        result
    }

    /// A local shell mostly fails for reasons a retry cannot change.
    ///
    /// `NotFound` and `Spawn` are both structural — the executable is missing,
    /// the arguments are wrong, the distro is not installed — and an
    /// unattended loop over them is a loop that cannot succeed, so it would
    /// spend its whole budget to arrive at the same message with the failure
    /// pushed minutes later. `Pty` is the one that can be transient: it means
    /// the OS refused a pseudoconsole, which is a resource answer rather than
    /// a verdict about the command.
    fn retryable(error: &LocalError) -> bool {
        matches!(error, LocalError::Pty(_) | LocalError::Io(_))
    }
}

#[async_trait]
impl Session for LocalSession {
    type Error = LocalError;

    async fn write(&mut self, data: &[u8]) -> Result<(), LocalError> {
        let tx = self.input_tx.as_ref().ok_or(LocalError::NotConnected)?;
        tx.send(data.to_vec())
            .await
            .map_err(|_| LocalError::NotConnected)
    }

    /// Unlike telnet's NAWS and serial's no-op, this one is the mechanism:
    /// `ResizePseudoConsole` is what makes the child's next size query return
    /// the new value, and every full-screen program repaints against it.
    async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), LocalError> {
        if self.input_tx.is_none() {
            return Err(LocalError::NotConnected);
        }
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| LocalError::Pty(e.to_string()))
    }

    /// Ask, then insist.
    ///
    /// Dropping the input sender closes the writer, which sends EOF to the
    /// child — enough for a shell sitting at a prompt to exit on its own and
    /// run whatever it does on the way out. The kill that follows is for
    /// everything else: a full-screen editor with unsaved changes, a shell
    /// mid-command, anything that will not take EOF for an answer. A pane the
    /// user closed has to actually close, so this does not wait to find out
    /// which case it was.
    ///
    /// The terminal status still comes from the wait thread, which is
    /// unblocked by exactly this.
    async fn disconnect(&mut self) -> Result<(), LocalError> {
        self.input_tx.take().ok_or(LocalError::NotConnected)?;
        let _ = self.killer.kill();
        Ok(())
    }
}
