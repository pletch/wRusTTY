//! The app layer's boundary onto `wr_fs::write_atomic`, adapting it to
//! `Result<(), String>` for IPC and adding a pretty-printed JSON form.

use std::path::Path;

/// Atomically replaces `path`'s contents, creating the parent directory if
/// needed.
pub(crate) fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    wr_fs::write_atomic(path, contents).map_err(|e| e.to_string())
}

/// `write_atomic` for anything serializable, pretty-printed.
pub(crate) fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_atomic(path, contents.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `wr_fs` owns atomicity and permission tests; this pins the JSON wrapper's
    /// round trip, parent-directory creation included.
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
