use std::time::UNIX_EPOCH;

use russh_sftp::client::SftpSession;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::SftpError;

/// How much of a file goes out in one SFTP write: the packet size servers
/// reliably accept, and past which round trips stop dominating.
const UPLOAD_CHUNK: usize = 32 * 1024;

/// How much of a file comes back in one SFTP read; see `UPLOAD_CHUNK`.
const DOWNLOAD_CHUNK: usize = 32 * 1024;

/// Why a transfer stopped. Canceled isn't an error, but it isn't complete
/// either, and a caller must not leave the partial file posing as the real one.
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
    /// The permission bits alone (`0o755`, not the raw mode); the type is in
    /// `is_dir`/`is_symlink`. `None` if the server didn't report permissions
    /// (some appliance servers report almost nothing).
    pub mode: Option<u32>,
    /// The owner and group names, when the server sends them. Over SFTP v3
    /// (OpenSSH) these are always `None`: names arrive only from v4, and
    /// `russh_sftp` doesn't decode them. Display only; use `uid`/`gid` for
    /// decisions.
    pub owner: Option<String>,
    pub group: Option<String>,
    /// The numeric owner and group, which SFTP v3 carries. Used to decide whether
    /// an edit needs sudo.
    pub uid: Option<u32>,
    pub gid: Option<u32>,
}

/// What a `stat` on one remote file says. `size` gives a transfer its total;
/// `modified`, remembered at download, lets an upload notice a remote change
/// instead of clobbering it.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStat {
    pub size: u64,
    /// Unix seconds; `None` if the server didn't report an mtime.
    pub modified: Option<i64>,
    /// Asked fresh rather than trusted from an old listing; opening a directory
    /// as a file fails differently on each server.
    pub is_dir: bool,
    /// Permission bits alone, as on [`RemoteEntry`].
    pub mode: Option<u32>,
}

/// The permission bits of a raw mode, with the file-type bits removed.
/// `0o7777` keeps setuid, setgid and sticky (`/tmp` is `1777`).
const PERMISSION_BITS: u32 = 0o7777;

/// Thin wrapper around `russh_sftp`'s high-level client, generic over the byte
/// stream carrying the subsystem channel.
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
                    mode: metadata.permissions.map(|p| p & PERMISSION_BITS),
                    owner: metadata.user.clone(),
                    group: metadata.group.clone(),
                    uid: metadata.uid,
                    gid: metadata.gid,
                }
            })
            .collect())
    }

    pub async fn stat(&self, path: &str) -> Result<RemoteStat, SftpError> {
        let metadata = self.inner.metadata(path).await?;
        Ok(RemoteStat {
            size: metadata.len(),
            is_dir: metadata.is_dir(),
            mode: metadata.permissions.map(|p| p & PERMISSION_BITS),
            modified: metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64),
        })
    }

    /// Replaces a remote file's contents outright.
    ///
    /// Not `SftpSession::write`, which opens with `WRITE` alone: saving something
    /// shorter leaves the old tail past the new end, with no error. `create` is
    /// `CREATE | TRUNCATE | WRITE`, and can create new files. `sync_all` before
    /// dropping the handle so a server-side close error surfaces here.
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

    /// Removes an empty directory. SFTP's `rmdir` is POSIX's, with no recursive
    /// form; a non-empty directory returns the server's error.
    pub async fn remove_dir(&self, path: &str) -> Result<(), SftpError> {
        Ok(self.inner.remove_dir(path).await?)
    }

    pub async fn create_dir(&self, path: &str) -> Result<(), SftpError> {
        Ok(self.inner.create_dir(path).await?)
    }

    /// Sets the permission bits on a remote path.
    ///
    /// `mode` is masked first: `SETSTAT` carries the same field `STAT` returns,
    /// file-type bits included, and not every server masks it (OpenSSH does).
    /// Every other attribute is left unset, so this can't become a truncate via
    /// `size`.
    pub async fn chmod(&self, path: &str, mode: u32) -> Result<(), SftpError> {
        let attrs = russh_sftp::protocol::FileAttributes {
            permissions: Some(mode & PERMISSION_BITS),
            ..Default::default()
        };
        Ok(self.inner.set_metadata(path, attrs).await?)
    }

    /// SFTP v3's rename doesn't replace an existing target (several servers
    /// refuse), so a caller meaning "replace" removes the target first.
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), SftpError> {
        Ok(self.inner.rename(from, to).await?)
    }

    /// Streams `src` into a remote file, chunk by chunk, rather than holding it
    /// in memory like `write`.
    ///
    /// `progress` gets the running byte count after each chunk and returns
    /// whether to continue; cancellation is bounded by one chunk's round trip.
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
                // Dropped without `sync_all`; the partial file is the caller's to clean
                // up, which is why it writes to a temporary name.
                return Ok(Transferred::Cancelled);
            }
        }
        // As in `write`: close explicitly so a server-side error surfaces.
        file.sync_all().await?;
        Ok(Transferred::Complete)
    }

    /// Streams a remote file into `dst`, chunk by chunk: `upload` in reverse.
    ///
    /// `progress` gets the running byte count after each chunk and returns
    /// whether to continue. `dst` is flushed but not synced; durability is the
    /// caller's call.
    pub async fn download<W>(
        &self,
        remote: &str,
        mut dst: W,
        mut progress: impl FnMut(u64) -> bool,
    ) -> Result<Transferred, SftpError>
    where
        W: AsyncWrite + Unpin,
    {
        let mut file = self.inner.open(remote).await?;
        let mut buf = vec![0u8; DOWNLOAD_CHUNK];
        let mut received = 0u64;
        loop {
            let n = file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await?;
            received += n as u64;
            if !progress(received) {
                // The partial output is the caller's to clean up (a temporary name).
                dst.flush().await?;
                return Ok(Transferred::Cancelled);
            }
        }
        dst.flush().await?;
        Ok(Transferred::Complete)
    }
}
