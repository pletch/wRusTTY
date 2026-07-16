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
