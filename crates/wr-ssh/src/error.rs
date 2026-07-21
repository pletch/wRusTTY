#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("connection to {host}:{port} timed out")]
    Timeout { host: String, port: u16 },

    #[error("authentication to {host}:{port} timed out")]
    AuthTimeout { host: String, port: u16 },

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
