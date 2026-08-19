#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("connection to {host}:{port} timed out")]
    Timeout { host: String, port: u16 },

    #[error("authentication to {host}:{port} timed out")]
    AuthTimeout { host: String, port: u16 },

    /// A command run on its own `exec` channel produced nothing within its
    /// budget. Distinct from a short read: a host that accepts the channel and
    /// then says nothing must not be mistaken for one that answered briefly.
    #[error("the remote command did not finish in time")]
    ExecTimeout,

    #[error("failed to connect to {host}:{port}: {source}")]
    Connect {
        host: String,
        port: u16,
        #[source]
        source: russh::Error,
    },

    #[error("host key for {host}:{port} was rejected")]
    HostKeyRejected { host: String, port: u16 },

    #[error("authentication failed")]
    AuthFailed,

    /// The user dismissed an interactive authentication prompt. Distinct from
    /// `AuthFailed` because nothing was rejected — reporting "authentication
    /// failed" for a cancelled dialog sends people hunting for a wrong
    /// password that was never sent.
    #[error("authentication was cancelled")]
    AuthCancelled,

    /// The server accepted the interactive exchange but wants another method
    /// on top of it (SSH's `partial success`). Only keyboard-interactive is
    /// driven here, so there is nothing further to offer — but this is a
    /// server policy question, not a bad credential, and says so.
    #[error(
        "the server accepted this credential but requires additional authentication ({remaining})"
    )]
    AuthPartial { remaining: String },

    /// The server refused interactive authentication outright and offers
    /// nothing this can drive instead. Says what it *will* take, because the
    /// answer is almost always "switch this session to a key or the agent" and
    /// a bare "authentication failed" hides that completely.
    #[error("the server refused interactive authentication; it will accept: {remaining}")]
    AuthMethodUnavailable { remaining: String },

    /// The server kept asking without ever accepting or rejecting. Bounded
    /// rather than trusted: a round trip that always returns another prompt
    /// would otherwise park the handshake forever, and the per-round timeout
    /// can't catch it because the server is answering promptly every time.
    #[error("authentication did not finish after {rounds} rounds of prompts")]
    AuthTooManyRounds { rounds: usize },

    /// Distinct from `AuthFailed` because the fix is completely different:
    /// the server never rejected anything, we couldn't reach an agent or it
    /// had nothing to offer.
    #[error("{0}")]
    AgentUnavailable(String),

    /// Every key the agent holds was refused. Reports the count because the
    /// usual cause is not "wrong key" but too many keys — servers cap
    /// authentication attempts (OpenSSH `MaxAuthTries`, default 6), so a
    /// well-stocked agent can be cut off before it reaches the right one.
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
