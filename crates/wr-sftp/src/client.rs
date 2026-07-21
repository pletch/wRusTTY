use std::time::UNIX_EPOCH;

use russh_sftp::client::SftpSession;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

use crate::error::SftpError;

/// A single remote directory entry, ready to hand to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Unix seconds; `None` if the server didn't report an mtime for this entry.
    pub modified: Option<i64>,
}

/// Thin wrapper around `russh_sftp`'s high-level client, generic over
/// whatever byte stream carries the SFTP subsystem channel — this crate
/// never needs to know it's actually an SSH channel.
pub struct SftpClient {
    inner: SftpSession,
}

impl SftpClient {
    pub async fn new<S>(stream: S) -> Result<Self, SftpError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        Ok(Self {
            inner: SftpSession::new(stream).await?,
        })
    }

    pub async fn list_dir(&self, path: &str) -> Result<Vec<RemoteEntry>, SftpError> {
        let entries = self.inner.read_dir(path).await?;
        Ok(entries
            .map(|entry| {
                let metadata = entry.metadata();
                RemoteEntry {
                    name: entry.file_name(),
                    is_dir: metadata.is_dir(),
                    is_symlink: metadata.is_symlink(),
                    size: metadata.len(),
                    modified: metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64),
                }
            })
            .collect())
    }

    pub async fn read(&self, path: &str) -> Result<Vec<u8>, SftpError> {
        Ok(self.inner.read(path).await?)
    }

    /// Replaces a remote file's contents outright.
    ///
    /// Deliberately not `SftpSession::write`, which opens with `OpenFlags::WRITE`
    /// alone — no `CREATE`, no `TRUNCATE`. That overwrites from byte 0 without
    /// shortening the file, so saving anything smaller than what was already
    /// there leaves the tail of the old contents stranded past the end of the
    /// new data. The result isn't a truncated file, it's a corrupt hybrid, and
    /// nothing reports an error. `create` is the same crate's
    /// `CREATE | TRUNCATE | WRITE`, which is what "save this file" actually
    /// means — and it can create new remote files, which the other path can't.
    ///
    /// `sync_all` before dropping the handle so the close is acknowledged
    /// (and any server-side error surfaces here) rather than being left to a
    /// silent teardown.
    pub async fn write(&self, path: &str, data: &[u8]) -> Result<(), SftpError> {
        let mut file = self.inner.create(path).await?;
        file.write_all(data).await?;
        file.sync_all().await?;
        Ok(())
    }

    pub async fn canonicalize(&self, path: &str) -> Result<String, SftpError> {
        Ok(self.inner.canonicalize(path).await?)
    }
}
