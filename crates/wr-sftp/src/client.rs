use std::time::UNIX_EPOCH;

use russh_sftp::client::SftpSession;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::SftpError;

/// How much of a file goes out in one SFTP write.
///
/// 32 KiB because that is the packet size the protocol's own read limit is
/// built around and what servers reliably accept; larger writes are legal but
/// not universally honoured, and this is the size at which the round trips
/// stop dominating anyway.
const UPLOAD_CHUNK: usize = 32 * 1024;

/// Why an upload stopped. A cancelled transfer is not an error — the user
/// asked — but it is emphatically not a completed one either, and a caller
/// that cannot tell them apart will leave a partial file lying around
/// claiming to be the real thing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transferred {
    Complete,
    Cancelled,
}

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

    pub async fn try_exists(&self, path: &str) -> Result<bool, SftpError> {
        Ok(self.inner.try_exists(path).await?)
    }

    pub async fn remove_file(&self, path: &str) -> Result<(), SftpError> {
        Ok(self.inner.remove_file(path).await?)
    }

    /// SFTP v3's rename does **not** replace an existing target — several
    /// servers refuse outright rather than overwriting, so a caller that means
    /// "replace" has to remove the target itself first.
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), SftpError> {
        Ok(self.inner.rename(from, to).await?)
    }

    /// Streams `src` into a remote file, chunk by chunk.
    ///
    /// Deliberately not `write`, which takes the whole file as a `&[u8]`: that
    /// is fine for the few kilobytes of a config file being edited and wrong
    /// for anything a user drops on a pane, where it means the file is held in
    /// memory twice over with no way to report progress and no way to stop.
    ///
    /// `progress` is called with the running byte count after each chunk and
    /// returns whether to keep going, which is the whole of the cancellation
    /// mechanism — a transfer can only stop between chunks, so cancelling is
    /// bounded by one chunk's round trip rather than by the size of the file.
    pub async fn upload<R>(
        &self,
        remote: &str,
        mut src: R,
        mut progress: impl FnMut(u64) -> bool,
    ) -> Result<Transferred, SftpError>
    where
        R: AsyncRead + Unpin,
    {
        let mut file = self.inner.create(remote).await?;
        let mut buf = vec![0u8; UPLOAD_CHUNK];
        let mut sent = 0u64;
        loop {
            let n = src.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).await?;
            sent += n as u64;
            if !progress(sent) {
                // The handle is dropped without `sync_all`; whatever reached
                // the server is the caller's to clean up, which is why this
                // writes to a temporary name.
                return Ok(Transferred::Cancelled);
            }
        }
        // Same reasoning as `write`: close explicitly so a server-side error
        // surfaces here rather than being swallowed by a silent teardown.
        file.sync_all().await?;
        Ok(Transferred::Complete)
    }
}
