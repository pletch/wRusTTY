//! Which files may be handed to the OS opener without asking: one policy for
//! every place that opens a file whose name someone else chose, a remote file
//! from the files panel (`sftp.rs`) and a path clicked in a local pane
//! (`local_open.rs`).
//!
//! An allowlist, not a denylist. The opener dispatches on the extension to
//! whatever program the machine has associated with it, and the set of types
//! that run something (`.pyw` with Python installed, `.sh` with Git for
//! Windows, `.iso` mounting past Mark of the Web, `.rdp` connecting out) is
//! open-ended and differs per machine. The types known to be inert open
//! directly; anything else asks first, and the types known to run something
//! are never opened at all from a local pane (see [`runs_when_opened`]).
#![cfg_attr(not(desktop), allow(dead_code))]

/// Extensions handed to the OS opener without asking: text, source and
/// configuration, plus images and PDFs, which open in a viewer.
///
/// Deliberately absent, though they are text: `.js`, `.py`, `.sh`, `.bash`,
/// `.pl`, `.rb` and `.php`, which an interpreter's installer commonly
/// associates with running the script (Git for Windows does it for `.sh` by
/// default). `.svg` is absent too: Windows opens it in a browser, and SVG can
/// carry `<script>`. So are `.html` and `.htm`.
const INERT_EXTENSIONS: &[&str] = &[
    "txt",
    "md",
    "markdown",
    "rst",
    "log",
    "text",
    "conf",
    "cfg",
    "ini",
    "yaml",
    "yml",
    "toml",
    "json",
    "xml",
    "csv",
    "tsv",
    "properties",
    "env",
    "diff",
    "patch",
    "sql",
    "zsh",
    "fish",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "rs",
    "go",
    "java",
    "kt",
    "lua",
    "ts",
    "tsx",
    "jsx",
    "css",
    "scss",
    "gitignore",
    // These reach the extension branch; `Dockerfile` has no dot and is
    // already inert.
    "service",
    "repo",
    "list",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "bmp",
    "webp",
    "pdf",
];

/// Types that run something when opened, beyond what `AssocIsDangerous` and
/// `PATHEXT` already cover on a given machine. Kept deliberately broad: the
/// cost of a false entry is one extra click in Explorer.
const RUNS_SOMETHING: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "psd1",
    "ps1xml",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "msc",
    "msi",
    "msp",
    "mst",
    "scr",
    "pif",
    "lnk",
    "url",
    "website",
    "scf",
    "hta",
    "cpl",
    "reg",
    "inf",
    "jar",
    "jnlp",
    "appref-ms",
    "application",
    "gadget",
    "library-ms",
    "search-ms",
    "searchconnector-ms",
    "settingcontent-ms",
    "diagcab",
    "xll",
    "chm",
    "appx",
    "appxbundle",
    "msix",
    "msixbundle",
    "sys",
    "dll",
    "ocx",
    "theme",
    "themepack",
    "desktopthemepack",
    "py",
    "pyw",
    "pyz",
    "pyzw",
    "rdp",
    "iso",
    "img",
    "vhd",
    "vhdx",
];

/// The extension the opener dispatches on, lowercased: only the last one
/// counts (`notes.txt.exe` is an exe), and a leading dot is part of the stem
/// (`.bashrc` has none). `None` for a name with no extension.
fn extension_of(basename: &str) -> Option<String> {
    let (stem, ext) = basename.rsplit_once('.')?;
    if stem.is_empty() {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// Whether `basename` can go straight to the OS opener. A name with no
/// extension is inert: the opener has nothing to dispatch on and offers a
/// picker.
pub fn is_inert_to_open(basename: &str) -> bool {
    match extension_of(basename) {
        None => true,
        Some(ext) => INERT_EXTENSIONS.contains(&ext.as_str()) && !ext_runs(&ext),
    }
}

/// Whether opening `basename` by association is known to run it. Not the
/// complement of [`is_inert_to_open`]: most types are neither, and ask first.
/// Only the local-pane opener uses it, and that is Windows only.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn runs_when_opened(basename: &str) -> bool {
    extension_of(basename).is_some_and(|ext| ext_runs(&ext))
}

fn ext_runs(ext: &str) -> bool {
    if RUNS_SOMETHING.contains(&ext) {
        return true;
    }
    // Only ever adds to the list, so a user-set PATHEXT can't make anything
    // more trusted than it was.
    if let Ok(pathext) = std::env::var("PATHEXT") {
        if pathext
            .split(';')
            .any(|e| e.trim_start_matches('.').eq_ignore_ascii_case(ext))
        {
            return true;
        }
    }
    assoc_is_dangerous(ext)
}

#[cfg(windows)]
fn assoc_is_dangerous(ext: &str) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::AssocIsDangerous;
    let wide: Vec<u16> = format!(".{ext}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe { AssocIsDangerous(PCWSTR(wide.as_ptr())) }.as_bool()
}

#[cfg(not(windows))]
fn assoc_is_dangerous(_ext: &str) -> bool {
    false
}

/// Asks before opening a file that isn't known to be inert. `provenance`
/// finishes the sentence "… can run code when it is opened, and …".
pub async fn confirm_open(
    app: &tauri::AppHandle,
    title: &str,
    basename: &str,
    provenance: &str,
) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "\"{basename}\" is a type of file that can run code when it is opened, \
             and {provenance}.\n\n\
             Only open it if you trust where it came from. Open anyway?"
        ))
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });

    rx.await.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_source_and_documents_open_directly() {
        for name in [
            "notes.txt",
            "nginx.conf",
            "Config.YAML",
            "main.rs",
            "README",
            ".bashrc",
            "app.tsx",
            "photo.JPG",
            "manual.pdf",
        ] {
            assert!(is_inert_to_open(name), "{name} should open without asking");
        }
    }

    /// Text, but an installer commonly associates these with running them.
    #[test]
    fn scripts_an_interpreter_may_run_are_not_inert() {
        for name in [
            "deploy.sh",
            "setup.bash",
            "tool.pl",
            "tool.rb",
            "index.php",
            "script.py",
            "dropper.js",
            "logo.svg",
            "page.html",
        ] {
            assert!(!is_inert_to_open(name), "{name} should ask first");
        }
    }

    #[test]
    fn programs_scripts_and_mountable_images_run_when_opened() {
        for name in [
            "a.exe", "b.BAT", "c.js", "d.lnk", "e.ps1", "f.url", "g.hta", "h.pyw", "i.iso",
            "j.vhdx", "k.rdp", "l.jnlp",
        ] {
            assert!(runs_when_opened(name), "{name}");
            assert!(!is_inert_to_open(name), "{name}");
        }
        for name in ["a.txt", "b.rs", "c.md", "Makefile", "d.docx"] {
            assert!(!runs_when_opened(name), "{name}");
        }
    }

    /// The OS dispatches on the last extension.
    #[test]
    fn double_extension_is_judged_by_the_last_one() {
        assert!(!is_inert_to_open("invoice.txt.exe"));
        assert!(runs_when_opened("invoice.txt.exe"));
        assert!(is_inert_to_open("archive.tar.md"));
    }
}
