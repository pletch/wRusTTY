//! Picks and reads a color-scheme file, for the theme importer.
//!
//! Only a reader: `.itermcolors` (XML plist) and VS Code themes (JSON) are
//! parsed by `src/lib/themeImport.ts`, where `DOMParser` already exists and
//! tests are cheaper.
//!
//! The file dialog is opened here rather than by the page, so the page never
//! names a path for this to read: the file the user picked is the only one it
//! can return. Still kept narrow: text only, one file, a size cap.

use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

/// Largest scheme this will read: far above real files (a few KB to a few
/// hundred), but refuses a wrongly picked video.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// The picked scheme: its file name, for naming the theme, and its text.
#[derive(Serialize)]
pub struct PickedTheme {
    name: String,
    text: String,
}

/// Opens the file dialog and reads the scheme picked in it. `None` when the
/// dialog was dismissed.
#[tauri::command]
pub async fn pick_theme_file(app: AppHandle) -> Result<Option<PickedTheme>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        // `json` covers a VS Code theme and a settings.json alike; `txt`
        // because a scheme downloaded from a browser often arrives as one,
        // and the parser sniffs the content anyway.
        .add_filter("Color schemes", &["itermcolors", "json", "jsonc", "txt"])
        .add_filter("All files", &["*"])
        .pick_file(|picked| {
            let _ = tx.send(picked);
        });
    // A dropped sender is a cancel.
    let Some(picked) = rx.await.ok().flatten() else {
        return Ok(None);
    };

    // The picker hands back a `content://` link on Android, not a path.
    #[cfg(target_os = "android")]
    {
        let uri = picked.to_string();
        if crate::android_files::is_content_uri(&uri) {
            let file = crate::android_files::describe(&app, &uri).await?;
            if let Some(size) = file.size.filter(|&size| size > MAX_BYTES) {
                return Err(too_big(size));
            }
            let bytes = crate::android_files::read(&app, &uri).await?;
            return Ok(Some(PickedTheme {
                name: file.name,
                text: decode(bytes)?,
            }));
        }
    }

    let path = picked.into_path().map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let text = tokio::task::spawn_blocking(move || read_capped(&path, MAX_BYTES))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Some(PickedTheme { name, text }))
}

fn too_big(len: u64) -> String {
    format!(
        "that file is {} MB — color schemes are a few kilobytes, so this is probably not one",
        len / (1024 * 1024)
    )
}

fn read_capped(path: &Path, max_bytes: u64) -> Result<String, String> {
    // Checked before reading, so the bytes never load; `metadata` also gives
    // clearer errors for a missing path or a directory.
    let meta = std::fs::metadata(path).map_err(|e| format!("can't read that file: {e}"))?;
    if meta.is_dir() {
        return Err("that's a folder, not a color scheme file".to_string());
    }
    if meta.len() > max_bytes {
        return Err(too_big(meta.len()));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("can't read that file: {e}"))?;
    decode(bytes)
}

fn decode(bytes: Vec<u8>) -> Result<String, String> {
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
