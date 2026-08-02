//! Write-a-file-or-leave-the-old-one-alone.
//!
//! Every store this app owns holds the only copy of something the user can't
//! reconstruct — saved sessions, workspaces, known_hosts, the vault — so a
//! crash or power loss part-way through a write must not be able to leave a
//! half-written file behind. `std::fs::write` truncates the target first and
//! then streams into it, which means the window between "old contents gone"
//! and "new contents complete" is a window in which the data simply doesn't
//! exist anywhere.
//!
//! Writing to a temp file in the same directory, fsyncing it, and renaming it
//! over the target closes that window: the rename is atomic, so a reader (or
//! the next launch) sees either the entire old file or the entire new one.
//! Same-directory matters — a rename across filesystems isn't atomic and
//! degrades to a copy.
//!
//! This lived in three places (`wr-vault`, `wr-ssh`, and the app's own
//! `atomic_file.rs`) on the theory that a shared helper wasn't worth a
//! dependency edge between standalone library crates. The copies then
//! diverged — the app's lost the explicit Unix permission step the other two
//! kept — which is the cost that argument was trading against. Collapsing
//! them into a crate with one function and one dependency is cheaper than
//! keeping three in sync: the signature returns `std::io::Result`, which
//! `VaultError` already wraps via `VaultError::Io`, `wr-ssh` already returned
//! directly, and the app layer maps it to `String` at its own boundary.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

/// How many times `persist` is retried before the error is reported.
const PERSIST_ATTEMPTS: u32 = 5;

/// First backoff step; doubles each retry (10, 20, 40, 80 ms), so the whole
/// ladder is 150 ms — short enough to stay inside a save that feels instant,
/// long enough to outlast a scanner holding a handle.
const PERSIST_BACKOFF: Duration = Duration::from_millis(10);

/// Whether `e` is the kind of failure that goes away on its own.
///
/// `persist` is `MoveFileEx` on Windows, which fails outright if anything holds
/// a handle on the destination — and on a real desktop that is routine and
/// lasts milliseconds:
///
/// - Defender or third-party AV scanning a file just created in `%APPDATA%`
/// - Windows Search indexing `sessions.json`
/// - OneDrive or Dropbox, if the user's profile is redirected — common in a
///   corporate build
/// - any backup agent with an open handle
///
/// Without a retry these surface as "saving a session profile randomly fails",
/// with no pattern the user can describe. Only these two codes are retried;
/// anything else (a full disk, a bad path, a permissions problem that is
/// genuinely permanent) is reported immediately, since retrying it would just
/// add 150 ms to a failure that was never going to succeed.
#[cfg(windows)]
fn is_transient_persist_error(e: &std::io::Error) -> bool {
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    matches!(
        e.raw_os_error(),
        Some(ERROR_ACCESS_DENIED) | Some(ERROR_SHARING_VIOLATION)
    )
}

/// Unix renames don't fail for a held handle — there is nothing transient to
/// wait out, so the retry ladder is skipped entirely rather than delaying a
/// genuine error.
#[cfg(not(windows))]
fn is_transient_persist_error(_e: &std::io::Error) -> bool {
    false
}

/// Atomically replace `path`'s contents, creating the parent directory if it
/// doesn't exist yet (these stores are written before anything guarantees the
/// config directory has been created).
///
/// On Unix the result is owner-only. `tempfile` already creates at `0600` and
/// a rename doesn't alter the mode, so this is belt-and-braces rather than a
/// fix — but it's stated explicitly because the files involved hold every
/// saved credential, hostname and key path, and "it happens to inherit the
/// right mode from a dependency's internals" is not a property worth leaving
/// undeclared. On Windows the per-user `%APPDATA%` ACL covers this.
pub fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(contents)?;
    // Flushes the data itself, not just the directory entry — without it the
    // rename can land while the contents are still only in the page cache,
    // which is exactly the truncated-file outcome this is here to prevent.
    tmp.as_file().sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tmp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    persist_with_retry(tmp, path)?;
    // The rename is atomic, but on Unix the *directory entry* recording it is
    // itself only in the page cache until the directory is fsynced — so on ext4
    // with `data=writeback` a power cut can lose the rename even though the
    // contents were durable. Failure is ignored: some filesystems refuse an
    // fsync on a directory handle, and the write itself has already succeeded.
    #[cfg(unix)]
    if let Ok(handle) = std::fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    Ok(())
}

/// Moves `from` over `to`, with the same backoff ladder [`write_atomic`] uses.
///
/// For contents too large to hold in memory, which is what `write_atomic`'s
/// `&[u8]` assumes: a streamed download writes its own part file and needs
/// only this last step, the atomic swap into place. Both files must already be
/// in the same directory — a rename across filesystems isn't atomic and
/// degrades to a copy.
///
/// Exists as a public function rather than as a fifth open-coded `fs::rename`
/// because the Windows retry is the part everyone forgets, and forgetting it
/// here means a download that occasionally fails at the last step, after every
/// byte has already crossed the network.
///
/// Blocks for up to the length of the ladder (~150 ms), so an async caller
/// should hand it to `spawn_blocking`.
pub fn replace_atomic(from: &Path, to: &Path) -> std::io::Result<()> {
    with_persist_retry((), |()| std::fs::rename(from, to).map_err(|e| (e, ())))
}

/// `persist`, with a short backoff ladder for the transient Windows failures
/// described on [`is_transient_persist_error`].
///
/// `PersistError` hands the `NamedTempFile` back in `.file`, which is what
/// makes this cheap: the contents don't have to be written again, only the
/// rename retried.
fn persist_with_retry(tmp: tempfile::NamedTempFile, path: &Path) -> std::io::Result<()> {
    with_persist_retry(tmp, |tmp| {
        tmp.persist(path).map(|_| ()).map_err(|e| (e.error, e.file))
    })
}

/// The ladder itself, over anything that can be tried again.
///
/// `attempt` hands its state back with the error so a failed `persist` can be
/// retried without rewriting the file it already wrote; a caller with no state
/// to carry passes `()`.
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

    /// The temp file must not survive a successful write — a leftover would
    /// accumulate in the user's config directory on every save.
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

    /// The step a streamed download ends on. Windows' `rename` refuses a
    /// destination that exists under some APIs, and a download that fell over
    /// at the last step — after every byte had crossed the network — would be
    /// the most expensive possible place to fail.
    #[test]
    fn replace_atomic_puts_a_part_file_over_an_existing_one() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("report.log");
        let part = dir.path().join("report.log.wrustty-part");
        std::fs::write(&target, b"the copy already here").unwrap();
        std::fs::write(&part, b"freshly downloaded").unwrap();

        replace_atomic(&part, &target).unwrap();

        assert_eq!(std::fs::read_to_string(&target).unwrap(), "freshly downloaded");
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

    /// A failure that will never clear must not spend the backoff ladder
    /// before being reported.
    #[test]
    fn a_permanent_error_is_not_treated_as_transient() {
        let permanent = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(!is_transient_persist_error(&permanent));
    }

    /// The real thing, on the platform it exists on: hold an exclusive handle
    /// on the destination — which is what AV, Search and OneDrive all do
    /// briefly — release it partway through the ladder, and require the write
    /// to have ridden it out rather than failed.
    #[cfg(windows)]
    #[test]
    fn a_transient_sharing_violation_is_ridden_out() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.json");
        write_atomic(&path, b"first").unwrap();

        // share_mode(0) is FILE_SHARE_NONE: MoveFileEx over this fails with
        // ERROR_SHARING_VIOLATION for as long as the handle is open.
        let blocker = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();

        let released = std::thread::spawn(move || {
            // Inside the 150 ms ladder, past the first attempt.
            std::thread::sleep(Duration::from_millis(25));
            drop(blocker);
        });

        write_atomic(&path, b"second").expect("should have retried past the sharing violation");
        released.join().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
    }

    /// And the other half of that: a handle held for longer than the ladder
    /// still surfaces as an error rather than hanging or silently doing
    /// nothing. The old contents survive, which is the guarantee that matters.
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

        // Released before reading: FILE_SHARE_NONE locks out this test's own
        // read as thoroughly as it locks out the rename.
        drop(blocker);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "first",
            "a failed write must leave the old contents intact"
        );
    }

    /// Pins the permission guarantee rather than inheriting it silently from
    /// `tempfile`. Every caller writes credentials or connection topology.
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
