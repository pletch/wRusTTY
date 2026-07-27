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
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
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
