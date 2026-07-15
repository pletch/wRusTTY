#[derive(Debug, thiserror::Error)]
pub enum TelnetError {
    #[error("connection to {host}:{port} timed out")]
    Timeout { host: String, port: u16 },

    #[error("failed to connect to {host}:{port}: {source}")]
    Connect {
        host: String,
        port: u16,
        #[source]
        source: std::io::Error,
    },

    #[error("not connected")]
    NotConnected,

    #[error(transparent)]
    Io(#[from] std::io::Error),
}
