#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("connection to {host}:{port} timed out")]
    Timeout { host: String, port: u16 },

    #[error("authentication to {host}:{port} timed out")]
    AuthTimeout { host: String, port: u16 },

    /// A command on its own `exec` channel produced nothing within its budget,
    /// as opposed to answering briefly.
    #[error("the remote command did not finish in time")]
    ExecTimeout,

    #[error("failed to connect to {host}:{port}: {source}")]
    Connect {
        host: String,
        port: u16,
        #[source]
        source: russh::Error,
    },

    /// The outbound proxy wouldn't open the tunnel; the SSH server hasn't been
    /// tried yet.
    #[error("proxy {proxy} {source}")]
    Proxy {
        proxy: String,
        #[source]
        source: crate::proxy::ProxyError,
    },

    #[error("host key for {host}:{port} was rejected")]
    HostKeyRejected { host: String, port: u16 },

    #[error("authentication failed")]
    AuthFailed,

    /// The user dismissed an interactive prompt. Not `AuthFailed`: nothing was
    /// rejected.
    #[error("authentication was canceled")]
    AuthCancelled,

    /// The server wants another method on top of keyboard-interactive (partial
    /// success). A server policy question, not a bad credential.
    #[error(
        "the server accepted this credential but requires additional authentication ({remaining})"
    )]
    AuthPartial { remaining: String },

    /// The server refused interactive auth and offers nothing drivable; says what
    /// it will accept (usually a key or the agent).
    #[error("the server refused interactive authentication; it will accept: {remaining}")]
    AuthMethodUnavailable { remaining: String },

    /// The server kept prompting without accepting or rejecting. Bounded, since
    /// prompt replies keep the per-round timeout from firing.
    #[error("authentication did not finish after {rounds} rounds of prompts")]
    AuthTooManyRounds { rounds: usize },

    /// Not `AuthFailed`: the agent was unreachable or had nothing to offer.
    #[error("{0}")]
    AgentUnavailable(String),

    /// Every agent key was refused. Reports the count, since the usual cause is
    /// too many keys for the server's cap (OpenSSH `MaxAuthTries`, default 6).
    #[error(
        "the server rejected all {offered} key(s) offered by the SSH agent — if the agent holds \
         more than a handful, the server may have cut off authentication before reaching the \
         right one"
    )]
    AgentRejected { offered: usize },

    #[error("SSH key file not found: {0}")]
    KeyNotFound(String),

    #[error("failed to load SSH key: {0}")]
    KeyLoad(String),

    #[error("not connected")]
    NotConnected,

    #[error(transparent)]
    Ssh(#[from] russh::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Sftp(#[from] wr_sftp::SftpError),
}
