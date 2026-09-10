/// What can go wrong opening or running a local shell.
///
/// The split that matters is between an error a retry could fix and one it
/// cannot — see `LocalConnector::retryable`. A missing executable is permanent
/// as far as an unattended loop is concerned, and retrying it is a loop that
/// cannot succeed.
///
/// `portable-pty` reports failures as `anyhow::Error`, which is a report
/// rather than a type to match on, so the variants below carry its rendering
/// as a string instead of chaining to it. The one distinction worth having
/// back — "the command is not there" — is recovered by checking for the
/// executable ourselves before spawning, which is both more precise than
/// inspecting an error after the fact and the case a stale saved profile
/// actually produces.
#[derive(Debug, thiserror::Error)]
pub enum LocalError {
    /// No executable at that path. Routine rather than exceptional: a profile
    /// outlives the shell it names, so this is what a PowerShell 7 uninstall
    /// or a profile copied from another machine looks like.
    #[error("cannot run {command}: no such executable")]
    NotFound { command: String },

    /// The pseudoconsole itself could not be created. Nothing to do with the
    /// command — the OS refused the ConPTY.
    #[error("failed to open a pseudoconsole: {0}")]
    Pty(String),

    /// The pseudoconsole opened but the child would not start.
    #[error("failed to start {command}: {message}")]
    Spawn { command: String, message: String },

    /// Writing to, resizing, or disconnecting a session whose I/O threads
    /// have already shut down — which is what every method looks like once
    /// the child has exited.
    #[error("not connected")]
    NotConnected,

    #[error(transparent)]
    Io(#[from] std::io::Error),
}
