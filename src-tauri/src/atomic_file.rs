//! The app layer's boundary onto `wr_fs::write_atomic`.
//!
//! The durability reasoning lives in `wr_fs`; this exists only to adapt it to
//! what the command layer wants — `Result<(), String>`, since that's what
//! crosses the Tauri IPC boundary, and a pretty-printed JSON form, which is
//! the shape every caller here actually uses.
//!
//! This module used to carry its own copy of the write. The copy had lost the
//! explicit Unix permission step that the `wr-vault` and `wr-ssh` copies kept,
//! which is exactly the drift three copies produce.

use std::path::Path;

/// Atomically replace `path`'s contents. Creates the parent directory if it
/// doesn't exist yet, since these stores are written before anything
/// guarantees the config directory has been created.
pub(crate) fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    wr_fs::write_atomic(path, contents).map_err(|e| e.to_string())
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

    /// `wr_fs` owns the atomicity and permission tests; what's worth pinning
    /// here is that the JSON wrapper round-trips through it, parent-directory
    /// creation included.
    #[test]
    fn writes_pretty_json_through_the_shared_helper() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-yet").join("store.json");
        write_json_atomic(&path, &vec!["a", "b"]).unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&std::fs::read_to_string(&path).unwrap()).unwrap(),
            vec!["a", "b"],
        );
    }
}
