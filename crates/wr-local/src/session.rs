use std::io::{Read, Write};
use std::path::Path;

use async_trait::async_trait;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;
use wr_core::{ConnectionEvent, ConnectionStatus, Connector, DisconnectKind, Session};

use crate::config::LocalConfig;
use crate::error::LocalError;

/// The size a pseudoconsole opens at before the frontend reports the pane's.
/// A ConPTY needs a size at creation; the registry applies the real one
/// moments later (`Slot::Connecting` replays it), so this only affects a
/// banner printed before the resize.
const INITIAL_SIZE: (u16, u16) = (80, 24);

/// Output taken from the pseudoconsole per read. Backpressure comes from the
/// bounded event channel (see `wr_core::Connector`); this sets its grain.
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

    /// Opens the pseudoconsole at the pane's size, so the first prompt doesn't
    /// reflow on an immediate resize.
    pub fn with_size(mut self, cols: u16, rows: u16) -> Self {
        if cols > 0 && rows > 0 {
            self.size = (cols, rows);
        }
        self
    }

    fn spawn(self, events: &mpsc::Sender<ConnectionEvent>) -> Result<LocalSession, LocalError> {
        let config = self.config;
        let command = config.command.clone();

        // Checked up front: `portable-pty`'s spawn error is a platform-specific
        // `anyhow::Error`, and nothing is allocated yet.
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

        // Without a cwd the shell inherits the app's (an install or system
        // directory), so fall back to home.
        match config.cwd.as_deref() {
            Some(dir) => cmd.cwd(dir),
            None => {
                if let Some(home) = home_dir() {
                    cmd.cwd(home);
                }
            }
        }

        // `CommandBuilder` seeds from this process's environment and `env`
        // overlays it (`LocalConfig::env`). TERM first, so a profile can override it.
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

        // Drop the slave now that the child holds its own handles. On Unix this
        // matters: while the slave fd exists, the reader never sees EOF. On Windows
        // it doesn't: master and slave share the `Inner` that owns the pseudoconsole,
        // and EOF comes from conhost closing the pipe when the child exits.
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

        // `wait` blocks, so the child gets its own thread; `clone_killer` lets
        // `disconnect` reach it. This thread is the only source of a terminal status
        // (the reader's EOF says nothing), so the exit code is never raced.
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
            // `Closed`, not `Lost`, even for a non-zero code: the process finished,
            // and nothing resurrects it (decision 5 in docs/LOCAL_SHELL_PLAN.md).
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

/// The line a pane shows when its shell exits. Written into the output (as
/// Windows Terminal, WezTerm and kitty do) rather than carried on the status,
/// which has no field for it. Dim, so it isn't mistaken for shell output.
fn exit_notice(code: u32) -> Vec<u8> {
    format!("\r\n\x1b[2m[process exited with code {code}]\x1b[0m\r\n").into_bytes()
}

/// Drains the pseudoconsole into the event channel until EOF. Reports nothing
/// at the end; the wait thread reports the exit with its code.
fn spawn_reader(mut reader: Box<dyn Read + Send>, events: mpsc::Sender<ConnectionEvent>) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Blocking on a full channel is the backpressure. A failed send means the
                    // receiver is gone.
                    if events
                        .blocking_send(ConnectionEvent::Data(buf[..n].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => {
                    // A broken pipe is the child exiting, not a fault.
                    tracing::debug!(error = %e, "local shell read ended");
                    break;
                }
            }
        }
    });
}

/// Feeds keystrokes to the pseudoconsole. Ends when the sender is dropped;
/// dropping the writer sends EOF, which is how `disconnect` asks a shell to
/// finish.
fn spawn_writer(mut writer: Box<dyn Write + Send>, mut input_rx: mpsc::Receiver<Vec<u8>>) {
    std::thread::spawn(move || {
        while let Some(data) = input_rx.blocking_recv() {
            if writer.write_all(&data).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });
}

/// The user's home directory, without a `dirs` dependency in this crate.
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
    /// Kept for `resize`; the reader and writer run on their own threads.
    master: Box<dyn MasterPty + Send>,
    /// `Option` so `disconnect` can drop the sender, ending the writer and
    /// sending EOF. Same shape as `SerialSession`.
    input_tx: Option<mpsc::Sender<Vec<u8>>>,
    /// Split off before the child moved into the (blocked) wait thread.
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Kills the shell if the owner never called `disconnect` (early return,
/// panic, canceled task). Matters most for the elevated host
/// (`elevated::host`): an administrator shell must not outlive its tab.
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

    /// Only `Pty` (the OS refused a pseudoconsole) can be transient. `NotFound`
    /// and `Spawn` are structural, so retrying them can't succeed.
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

    /// `ResizePseudoConsole` is what makes the child's next size query return the
    /// new value.
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

    /// Ask, then insist. Dropping the input sender sends EOF, enough for a shell
    /// at a prompt to exit cleanly; the kill that follows handles anything that
    /// won't (an editor, a running command). A closed pane must close. The
    /// terminal status still comes from the wait thread.
    async fn disconnect(&mut self) -> Result<(), LocalError> {
        self.input_tx.take().ok_or(LocalError::NotConnected)?;
        let _ = self.killer.kill();
        Ok(())
    }
}
