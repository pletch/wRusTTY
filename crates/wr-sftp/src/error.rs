#[derive(Debug, thiserror::Error)]
pub enum SftpError {
    #[error(transparent)]
    Sftp(#[from] russh_sftp::client::error::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
