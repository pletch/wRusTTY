#[derive(Debug, thiserror::Error)]
pub enum SftpError {
    #[error(transparent)]
    Sftp(#[from] russh_sftp::client::error::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl SftpError {
    /// Whether retrying the same operation could plausibly succeed.
    ///
    /// Conservative: only the cases the protocol names as timing count. A wrong
    /// "permanent" costs a click on Retry; a wrong "transient" delays the real
    /// message. The catch-all `Failure` (full disk, read-only mount) is permanent.
    /// A dropped connection is absent too: the session's `OnceCell` client would
    /// return the same dead channel, so resuming the transfer later is the answer.
    pub fn is_transient(&self) -> bool {
        match self {
            SftpError::Sftp(russh_sftp::client::error::Error::Timeout) => true,
            SftpError::Sftp(_) => false,
            SftpError::Io(e) => matches!(
                e.kind(),
                std::io::ErrorKind::Interrupted
                    | std::io::ErrorKind::TimedOut
                    | std::io::ErrorKind::WouldBlock
            ),
        }
    }
}
