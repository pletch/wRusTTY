//! Reads a color-scheme file the user picked, for the theme importer.
//!
//! Only a reader: `.itermcolors` (XML plist) and VS Code themes (JSON) are
//! parsed by `src/lib/themeImport.ts`, where `DOMParser` already exists and
//! tests are cheaper.
//!
//! Reading an arbitrary path adds no new capability (`sftp_upload_path`
//! already reads local files), and the path comes from an OS file dialog.
//! Still kept narrow: text only, one file, a size cap.

use std::path::Path;

/// Largest scheme this will read: far above real files (a few KB to a few
/// hundred), but refuses a wrongly picked video.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

#[tauri::command]
pub fn read_theme_file(path: String) -> Result<String, String> {
    read_capped(Path::new(&path), MAX_BYTES)
}

fn read_capped(path: &Path, max_bytes: u64) -> Result<String, String> {
    // Checked before reading, so the bytes never load; `metadata` also gives
    // clearer errors for a missing path or a directory.
    let meta = std::fs::metadata(path).map_err(|e| format!("can't read that file: {e}"))?;
    if meta.is_dir() {
        return Err("that's a folder, not a color scheme file".to_string());
    }
    if meta.len() > max_bytes {
        return Err(format!(
            "that file is {} MB — color schemes are a few kilobytes, so this is probably not one",
            meta.len() / (1024 * 1024)
        ));
    }

    let bytes = std::fs::read(path).map_err(|e| format!("can't read that file: {e}"))?;
    // Not lossy: XML and JSON are text, and replacement characters would turn
    // "binary file" into a confusing parse error.
    let text = String::from_utf8(bytes)
        .map_err(|_| "that file isn't text, so it isn't a color scheme".to_string())?;
    // macOS plists often start with a BOM.
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_file(name: &str, contents: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("wrustty-theme-test-{name}"));
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(contents).unwrap();
        path
    }

    #[test]
    fn reads_a_small_text_file() {
        let path = temp_file("plain.json", b"{\"colors\":{}}");
        assert_eq!(read_capped(&path, MAX_BYTES).unwrap(), "{\"colors\":{}}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn strips_a_byte_order_mark() {
        // macOS plists often carry one, and DOMParser would choke on it.
        let path = temp_file("bom.xml", "\u{feff}<plist/>".as_bytes());
        assert_eq!(read_capped(&path, MAX_BYTES).unwrap(), "<plist/>");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn refuses_a_file_past_the_cap() {
        let path = temp_file("big.json", &vec![b'x'; 512]);
        let err = read_capped(&path, 256).unwrap_err();
        assert!(err.contains("probably not one"), "unexpected error: {err}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn refuses_bytes_that_are_not_text() {
        // Otherwise this surfaces as a parse error far from the cause.
        let path = temp_file("binary.bin", &[0xff, 0xfe, 0x00, 0x80, 0x9f]);
        let err = read_capped(&path, MAX_BYTES).unwrap_err();
        assert!(err.contains("isn't text"), "unexpected error: {err}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn names_a_directory_as_such() {
        let err = read_capped(&std::env::temp_dir(), MAX_BYTES).unwrap_err();
        assert!(err.contains("folder"), "unexpected error: {err}");
    }

    #[test]
    fn reports_a_missing_file_rather_than_panicking() {
        let missing = std::env::temp_dir().join("wrustty-theme-test-does-not-exist");
        let _ = std::fs::remove_file(&missing);
        assert!(read_capped(&missing, MAX_BYTES).is_err());
    }
}
