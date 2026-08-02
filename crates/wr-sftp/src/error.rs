#[derive(Debug, thiserror::Error)]
pub enum SftpError {
    #[error(transparent)]
    Sftp(#[from] russh_sftp::client::error::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl SftpError {
    /// Whether running the same operation again could plausibly succeed.
    ///
    /// **Conservative on purpose: anything not recognised is permanent.** The
    /// cost of the two mistakes is not symmetric. Retrying a permission error
    /// three times delays the real message by a second and teaches the user
    /// nothing; failing to retry a genuine hiccup costs one manual click on a
    /// Retry button that exists anyway. So this only claims the cases the
    /// protocol itself names as timing, and treats the catch-all `Failure` —
    /// which servers return for everything from a full disk to a read-only
    /// mount — as permanent.
    ///
    /// Note what is deliberately absent: a dropped *connection*. Nothing here
    /// can recover from one, because the session holds its SFTP client in a
    /// `OnceCell` and would hand back the same dead channel on every attempt.
    /// Surviving a reconnect needs reconnection, which this app does not do
    /// yet; resuming the transfer afterwards is the answer it does have.
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
