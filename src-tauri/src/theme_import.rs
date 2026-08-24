//! Reads a colour-scheme file the user picked, for the theme importer.
//!
//! # Why this is only a reader
//!
//! The other importers here (`putty_import`, `ssh_config_import`) parse on
//! this side, and this one deliberately does not. Both formats it has to read
//! are ones the webview already has a parser for and Rust does not: an
//! `.itermcolors` file is an XML property list, which `DOMParser` handles
//! natively, and a VS Code theme is JSON. Parsing here would mean taking on
//! an XML dependency to reimplement something already in the process.
//!
//! So this hands back text and `src/lib/themeImport.ts` does the rest, where
//! the parsing is also far cheaper to test.
//!
//! # What this does and does not add
//!
//! It reads an arbitrary path the webview names. That is not a new capability
//! in this app — `sftp_upload_path` already reads any local file and sends it
//! to a remote host — so the marginal exposure is nil, and the path still
//! comes from an OS file dialog the user drove. It is kept narrow anyway:
//! text only, one file, and a size cap, so it cannot be turned into a way to
//! stream something large out of the machine a chunk at a time.

use std::path::Path;

/// Largest colour scheme this will read.
///
/// Generous by three orders of magnitude for what these files actually are —
/// an `.itermcolors` is a few KB, and even a full VS Code theme carrying
/// every `tokenColors` rule is a couple of hundred — while still refusing to
/// pull a video into a string because someone picked the wrong file.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

#[tauri::command]
pub fn read_theme_file(path: String) -> Result<String, String> {
    read_capped(Path::new(&path), MAX_BYTES)
}

fn read_capped(path: &Path, max_bytes: u64) -> Result<String, String> {
    // Checked before reading rather than after: the point is not to have the
    // bytes in memory at all. `metadata` also gives the clearer error for the
    // ordinary mistakes — a path that is gone, or a directory.
    let meta = std::fs::metadata(path).map_err(|e| format!("can't read that file: {e}"))?;
    if meta.is_dir() {
        return Err("that's a folder, not a colour scheme file".to_string());
    }
    if meta.len() > max_bytes {
        return Err(format!(
            "that file is {} MB — colour schemes are a few kilobytes, so this is probably not one",
            meta.len() / (1024 * 1024)
        ));
    }

    let bytes = std::fs::read(path).map_err(|e| format!("can't read that file: {e}"))?;
    // Not `from_utf8_lossy`: a scheme file is XML or JSON, both of which are
    // text by definition, and replacement characters would turn "you picked a
    // binary file" into a parse error further away from the cause.
    let text = String::from_utf8(bytes)
        .map_err(|_| "that file isn't text, so it isn't a colour scheme".to_string())?;
    // A plist written on macOS often carries one, and it would otherwise be
    // the first character the XML parser sees.
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
        // Plists written by macOS tooling routinely carry one, and it is the
        // first thing DOMParser would choke on.
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
        // The failure this produces otherwise is a parse error, which points
        // at the format rather than at the file being a JPEG.
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
