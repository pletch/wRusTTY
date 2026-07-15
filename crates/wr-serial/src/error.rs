#[derive(Debug, thiserror::Error)]
pub enum SerialError {
    #[error("failed to open serial port {port}: {source}")]
    Open {
        port: String,
        #[source]
        source: tokio_serial::Error,
    },

    #[error("not connected")]
    NotConnected,

    #[error(transparent)]
    Io(#[from] std::io::Error),
}
