//! Write-a-file-or-leave-the-old-one-alone.
//!
//! Every store this app owns holds the only copy of something the user can't
//! reconstruct — saved sessions, workspaces, the vault — so a crash or power
//! loss part-way through a write must not be able to leave a half-written
//! file behind. `std::fs::write` truncates the target first and then streams
//! into it, which means the window between "old contents gone" and "new
//! contents complete" is a window in which the data simply doesn't exist
//! anywhere.
//!
//! Writing to a temp file in the same directory, fsyncing it, and renaming it
//! over the target closes that window: the rename is atomic, so a reader (or
//! the next launch) sees either the entire old file or the entire new one.
//! Same-directory matters — a rename across filesystems isn't atomic and
//! degrades to a copy.
//!
//! The `wr-vault` and `wr-ssh` crates carry their own copies of this pattern
//! rather than depending on it: they're standalone library crates with their
//! own error types, and a shared helper isn't worth a dependency edge between
//! them and the app.

use std::path::Path;

/// Atomically replace `path`'s contents. Creates the parent directory if it
/// doesn't exist yet, since these stores are written before anything
/// guarantees the config directory has been created.
pub(crate) fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let dir = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
    tmp.write_all(contents).map_err(|e| e.to_string())?;
    // Flushes the data itself, not just the directory entry — without it the
    // rename can land while the contents are still only in the page cache,
    // which is exactly the truncated-file outcome this is here to prevent.
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

/// `write_atomic` for anything serialisable, pretty-printed — the shape every
/// caller here actually wants.
pub(crate) fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_atomic(path, contents.as_bytes())
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
        write_json_atomic(&path, &vec!["a", "b"]).unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&std::fs::read_to_string(&path).unwrap()).unwrap(),
            vec!["a", "b"],
        );
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
}
