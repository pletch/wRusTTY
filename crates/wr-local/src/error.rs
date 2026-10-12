/// What can go wrong opening or running a local shell. What matters is
/// whether a retry could fix it (see `LocalConnector::retryable`).
///
/// `portable-pty` reports `anyhow::Error`, so variants carry its rendering as
/// a string. "The command isn't there" is detected by checking the executable
/// before spawning.
#[derive(Debug, thiserror::Error)]
pub enum LocalError {
    /// No executable at that path: routine when a profile outlives its shell
    /// (an uninstall, a profile from another machine).
    #[error("cannot run {command}: no such executable")]
    NotFound { command: String },

    /// The OS refused to create the pseudoconsole.
    #[error("failed to open a pseudoconsole: {0}")]
    Pty(String),

    /// The pseudoconsole opened but the child would not start.
    #[error("failed to start {command}: {message}")]
    Spawn { command: String, message: String },

    /// The session's I/O threads have shut down, as after the child exits.
    #[error("not connected")]
    NotConnected,

    /// The user answered No to UAC: an answer, not a failure, and never retried.
    #[error("elevation was declined")]
    ElevationDeclined,

    /// The elevated host couldn't be started or reached, or wasn't who it should
    /// be. See `elevated::connector`.
    #[error("could not start the elevated shell: {0}")]
    Elevation(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}
