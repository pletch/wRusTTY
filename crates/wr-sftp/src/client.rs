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

/// How much of a file comes back in one SFTP read. Same size and the same
/// reasoning as `UPLOAD_CHUNK`, in the other direction.
const DOWNLOAD_CHUNK: usize = 32 * 1024;

/// Why a transfer stopped. A cancelled transfer is not an error — the user
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
    /// The permission bits alone — `0o755`, not the raw mode.
    ///
    /// The file-type bits are masked off because the type is already carried by
    /// `is_dir`/`is_symlink`, and leaving them in makes every consumer either
    /// mask again or accidentally render `100755`. `None` if the server didn't
    /// report permissions, which is rarer than a missing mtime but not
    /// impossible — several appliance SFTP servers report almost nothing.
    pub mode: Option<u32>,
    /// The owner and group *names*, when the server sends them.
    ///
    /// Only the numeric uid/gid are guaranteed by the protocol, and a bare `0`
    /// tells the user nothing they can act on — so these are the names or
    /// nothing. Populated from the same attribute block as everything else, at
    /// no extra round trip.
    ///
    /// In practice, over SFTP v3 — which is what OpenSSH speaks — these are
    /// always `None`. The protocol carries names only from v4, and
    /// `russh_sftp` hardcodes them to `None` when decoding attributes. Kept
    /// because a v4 server would fill them in and they are the nicer thing to
    /// show; **not** something to make a decision from. `uid`/`gid` below are
    /// the fields that actually arrive.
    pub owner: Option<String>,
    pub group: Option<String>,
    /// The numeric owner and group, which SFTP v3 does carry.
    ///
    /// These exist because a name that is always absent cannot answer "could
    /// this user write this file", and that question is what decides whether
    /// an edit needs to go through sudo. Numbers compare exactly and need no
    /// name resolution on either end.
    pub uid: Option<u32>,
    pub gid: Option<u32>,
}

/// What a `stat` on one remote file says. The same two facts `RemoteEntry`
/// carries, without the name — asked about a path the caller already has.
///
/// `size` is a transfer's total, which is the difference between a progress
/// bar and a spinner. `modified` is what conflict detection will compare
/// against on the way back up: remember it at download, and a remote file that
/// changed underneath an edit can be noticed instead of silently clobbered.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStat {
    pub size: u64,
    /// Unix seconds; `None` if the server didn't report an mtime.
    pub modified: Option<i64>,
    /// Asking here rather than trusting a directory listing the caller may
    /// have taken minutes ago — and because opening a directory as a file is
    /// a failure each server words differently.
    pub is_dir: bool,
    /// Permission bits alone, as on [`RemoteEntry`].
    pub mode: Option<u32>,
}

/// The permission bits of a raw mode, with the file-type bits removed.
///
/// `0o7777` rather than `0o777`: setuid, setgid and the sticky bit are real
/// permissions a user may need to see and set — `/tmp` is `1777` and dropping
/// the leading `1` would make this panel quietly misreport it.
const PERMISSION_BITS: u32 = 0o7777;

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
                    mode: metadata.permissions.map(|p| p & PERMISSION_BITS),
                    owner: metadata.user.clone(),
                    group: metadata.group.clone(),
                    uid: metadata.uid,
                    gid: metadata.gid,
                }
            })
            .collect())
    }

    // There is deliberately no `read`. It returned the whole file as a
    // `Vec<u8>`, which meant every download — including the one behind each
    // remote *edit* — was held in memory, reported no progress and could not be
    // stopped, for a file whose size is whatever the remote host says it is.
    // `download` replaced its last caller; leaving it here would only be
    // somewhere for the next one to land.

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

    /// Removes an **empty** directory. SFTP's `rmdir` is POSIX's: it will not
    /// touch a directory with anything in it, and there is no recursive form.
    /// A caller that means "delete this tree" has to walk it, which is the
    /// recursive queue that does not exist yet — so for now a non-empty
    /// directory comes back as the server's own error, which is the honest
    /// answer rather than a silent no-op.
    pub async fn remove_dir(&self, path: &str) -> Result<(), SftpError> {
        Ok(self.inner.remove_dir(path).await?)
    }

    pub async fn create_dir(&self, path: &str) -> Result<(), SftpError> {
        Ok(self.inner.create_dir(path).await?)
    }

    /// Sets the permission bits on a remote path.
    ///
    /// `mode` is masked to the permission bits before it goes out. SFTP's
    /// `SETSTAT` carries the same `permissions` field a `STAT` returns — which
    /// includes the file-type bits — so a caller round-tripping a raw mode
    /// could otherwise ask the server to change what *kind* of thing the file
    /// is. OpenSSH masks it again on arrival; plenty of other servers do not,
    /// and the ones this app is aimed at are exactly the unusual ones.
    ///
    /// Every other attribute is left unset, which is what keeps this a `chmod`
    /// rather than a truncate: `size` is in the same structure, and a `Metadata`
    /// built from a stat and sent back wholesale would carry it.
    pub async fn chmod(&self, path: &str, mode: u32) -> Result<(), SftpError> {
        let attrs = russh_sftp::protocol::FileAttributes {
            permissions: Some(mode & PERMISSION_BITS),
            ..Default::default()
        };
        Ok(self.inner.set_metadata(path, attrs).await?)
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

    /// Streams a remote file into `dst`, chunk by chunk — `upload` in reverse,
    /// and deliberately the same shape.
    ///
    /// The counterpart to `read`, which returns a `Vec<u8>`: that means a
    /// download is held whole in memory, reports no progress, and cannot be
    /// stopped once it has started. Tolerable for the config file behind an
    /// edit; not for the log file someone asks to save, which is exactly the
    /// case where the size is unknown until it is too late.
    ///
    /// `progress` is called with the running byte count after each chunk and
    /// returns whether to keep going — the whole of the cancellation
    /// mechanism, bounded by one chunk rather than by what is left of the file.
    ///
    /// `dst` is flushed but not synced: durability belongs to the caller, who
    /// owns the handle and knows whether the bytes are going to a file worth
    /// `sync_all`ing or somewhere that has no such notion.
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
                // Whatever reached `dst` is the caller's to clean up, which is
                // why this writes to a temporary name too.
                dst.flush().await?;
                return Ok(Transferred::Cancelled);
            }
        }
        dst.flush().await?;
        Ok(Transferred::Complete)
    }
}
