//! Write a file or leave the old one alone.
//!
//! Every store this app owns (saved sessions, workspaces, known_hosts, the
//! vault) holds data the user can't reconstruct, and `std::fs::write`
//! truncates before writing. Writing a temp file in the same directory,
//! fsyncing it and renaming it over the target means a reader sees either the
//! whole old file or the whole new one. Same directory, because a rename
//! across filesystems degrades to a copy.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

/// How many times `persist` is retried before the error is reported.
const PERSIST_ATTEMPTS: u32 = 5;

/// First backoff step; doubles each retry (10, 20, 40, 80 ms, 150 ms total),
/// enough to outlast a scanner holding a handle.
const PERSIST_BACKOFF: Duration = Duration::from_millis(10);

/// Whether `e` is a failure that clears on its own.
///
/// `persist` is `MoveFileEx` on Windows, which fails if anything holds a
/// handle on the destination, routinely and for milliseconds: Defender or
/// other AV, Windows Search, OneDrive/Dropbox profile redirection, backup
/// agents. Only these two codes are retried; anything else is reported
/// immediately.
#[cfg(windows)]
fn is_transient_persist_error(e: &std::io::Error) -> bool {
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    matches!(
        e.raw_os_error(),
        Some(ERROR_ACCESS_DENIED) | Some(ERROR_SHARING_VIOLATION)
    )
}

/// Unix renames don't fail for a held handle, so nothing is retried.
#[cfg(not(windows))]
fn is_transient_persist_error(_e: &std::io::Error) -> bool {
    false
}

/// Atomically replaces `path`'s contents, creating the parent directory if
/// needed (these stores can be written before the config directory exists).
///
/// On Unix the result is owner-only. `tempfile` already creates at `0600`, but
/// these files hold credentials and hostnames, so it's stated explicitly. On
/// Windows the per-user `%APPDATA%` ACL covers this.
pub fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(contents)?;
    // Flush the data, or the rename can land while contents are only in the page
    // cache.
    tmp.as_file().sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tmp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    persist_with_retry(tmp, path)?;
    // On Unix the rename's directory entry is only in the page cache until the
    // directory is fsynced (ext4 `data=writeback` can lose it). Failure is
    // ignored: some filesystems refuse a directory fsync.
    #[cfg(unix)]
    if let Ok(handle) = std::fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    Ok(())
}

/// Moves `from` over `to`, with the same backoff ladder as [`write_atomic`].
///
/// For contents too large for memory: a streamed download writes its own part
/// file and needs only the swap. Both files must be in the same directory.
/// Public so nobody open-codes `fs::rename` without the Windows retry. Blocks
/// for up to ~150 ms, so async callers should use `spawn_blocking`.
pub fn replace_atomic(from: &Path, to: &Path) -> std::io::Result<()> {
    with_persist_retry((), |()| std::fs::rename(from, to).map_err(|e| (e, ())))
}

/// `persist` with the backoff ladder (see [`is_transient_persist_error`]).
/// `PersistError` returns the `NamedTempFile`, so only the rename is retried.
fn persist_with_retry(tmp: tempfile::NamedTempFile, path: &Path) -> std::io::Result<()> {
    with_persist_retry(tmp, |tmp| {
        tmp.persist(path).map(|_| ()).map_err(|e| (e.error, e.file))
    })
}

/// The ladder itself. `attempt` returns its state with the error so a retry
/// needn't redo work; a caller with no state passes `()`.
fn with_persist_retry<S>(
    mut state: S,
    mut attempt: impl FnMut(S) -> Result<(), (std::io::Error, S)>,
) -> std::io::Result<()> {
    let mut delay = PERSIST_BACKOFF;
    for i in 0..PERSIST_ATTEMPTS {
        match attempt(state) {
            Ok(()) => return Ok(()),
            Err((e, back)) if i + 1 < PERSIST_ATTEMPTS && is_transient_persist_error(&e) => {
                state = back;
                std::thread::sleep(delay);
                delay *= 2;
            }
            Err((e, _)) => return Err(e),
        }
    }
    unreachable!("the last attempt always returns")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_existing_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.json");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
    }

    #[test]
    fn creates_missing_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-yet").join("store.json");
        write_atomic(&path, b"contents").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "contents");
    }

    /// The temp file doesn't survive a successful write.
    #[test]
    fn leaves_no_temp_files_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.json");
        write_atomic(&path, b"contents").unwrap();
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("store.json")]);
    }

    /// The step a streamed download ends on: replacing an existing destination.
    #[test]
    fn replace_atomic_puts_a_part_file_over_an_existing_one() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("report.log");
        let part = dir.path().join("report.log.wrustty-part");
        std::fs::write(&target, b"the copy already here").unwrap();
        std::fs::write(&part, b"freshly downloaded").unwrap();

        replace_atomic(&part, &target).unwrap();

        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "freshly downloaded"
        );
        assert!(!part.exists(), "the part file must not survive the rename");
    }

    #[test]
    fn replace_atomic_creates_a_target_that_was_not_there() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("new.log");
        let part = dir.path().join("new.log.wrustty-part");
        std::fs::write(&part, b"contents").unwrap();

        replace_atomic(&part, &target).unwrap();

        assert_eq!(std::fs::read_to_string(&target).unwrap(), "contents");
    }

    /// A permanent failure is reported without spending the backoff ladder.
    #[test]
    fn a_permanent_error_is_not_treated_as_transient() {
        let permanent = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(!is_transient_persist_error(&permanent));
    }

    /// Holds an exclusive handle on the destination (as AV, Search and OneDrive
    /// do briefly), releases it partway through the ladder, and requires the
    /// write to succeed.
    #[cfg(windows)]
    #[test]
    fn a_transient_sharing_violation_is_ridden_out() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.json");
        write_atomic(&path, b"first").unwrap();

        // FILE_SHARE_NONE: MoveFileEx fails with ERROR_SHARING_VIOLATION while open.
        let blocker = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();

        let released = std::thread::spawn(move || {
            // Inside the ladder, past the first attempt.
            std::thread::sleep(Duration::from_millis(25));
            drop(blocker);
        });

        write_atomic(&path, b"second").expect("should have retried past the sharing violation");
        released.join().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
    }

    /// A handle held past the ladder surfaces as an error, and the old contents
    /// survive.
    #[cfg(windows)]
    #[test]
    fn a_handle_held_past_the_ladder_still_fails_cleanly() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.json");
        write_atomic(&path, b"first").unwrap();

        let blocker = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();

        assert!(write_atomic(&path, b"second").is_err());

        // Released first: FILE_SHARE_NONE blocks this test's read too.
        drop(blocker);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "first",
            "a failed write must leave the old contents intact"
        );
    }

    /// Pins the owner-only mode rather than inheriting it from `tempfile`.
    #[cfg(unix)]
    #[test]
    fn result_is_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.json");
        write_atomic(&path, b"secret").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "expected 0600, got {:o}", mode & 0o777);
    }
}
