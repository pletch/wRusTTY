//! Opening a file path that was clicked in a local pane.
//!
//! The local counterpart to the files panel reveal an SSH pane gets: the
//! frontend has found text that looks like a path, and this resolves it on
//! this machine and hands it to whatever Windows has associated with its type
//! — or, when nothing is, to the "How do you want to open this file?" picker.
//!
//! # What the text is not trusted to do
//!
//! A local pane's output is not local in any sense that matters: `ssh`, `cat`
//! of a downloaded file and `curl` all put someone else's bytes on the screen.
//! So the path is attacker-chosen, and three things follow:
//!
//! - **No network paths.** `\\host\share\x`, `//host/x` and the `\\?\` / `\\.\`
//!   device forms are refused before anything touches the filesystem. Merely
//!   *looking up* a UNC path makes Windows try to authenticate to that host,
//!   which hands it an NTLM exchange — the same leak `isOpenableUrl` exists to
//!   stop on the URL side. A working directory that is one is refused too.
//! - **Nothing runs.** Opening by association means *executing* a `.exe`,
//!   `.bat`, `.js` or `.lnk`, so anything Windows considers dangerous — its
//!   own `AssocIsDangerous` list, `PATHEXT`, and a list of shell-handled types
//!   that are neither — is shown selected in Explorer instead. The user can
//!   still run it from there; a Ctrl+click just cannot do it for them.
//! - **It has to exist.** Resolution only returns a path that is there, so
//!   `and/or` in prose is "not found" rather than a picker for a file that
//!   isn't.
//!
//! Windows only, like the panes it serves. Elsewhere `open_local_path`
//! refuses up front, which leaves everything below it unreached outside the
//! tests — hence the allow, rather than gating each piece and its tests
//! separately.
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::{Path, PathBuf};

use serde::Serialize;

/// What happened, for the pane to report. `NotFound` is an outcome rather
/// than an error because it is the ordinary answer for text that only looked
/// like a path.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenOutcome {
    /// Handed to its associated program, or to the program picked for it.
    Opened {
        path: String,
    },
    /// A directory, opened in Explorer.
    Folder {
        path: String,
    },
    /// A program or script, shown selected in Explorer rather than run.
    Revealed {
        path: String,
    },
    /// The "Open with" picker was dismissed.
    Cancelled,
    NotFound,
}

/// Whether a path, or working directory, names somewhere off this machine or
/// a device rather than a file — the forms that are refused outright.
fn is_remote_or_device(p: &str) -> bool {
    p.starts_with(r"\\") || p.starts_with("//") || p.starts_with(r"\/") || p.starts_with(r"/\")
}

/// Rewrites a path into Windows form, or None if it cannot be one of ours.
///
/// Git Bash and MSYS print `/c/Users/tim` for `C:\Users\tim`, so that form is
/// translated. Any other root-relative path (`/etc/hosts`, `\Windows`) is
/// refused: under Windows it would quietly mean "on whichever drive is
/// current", which is not what whoever printed it meant.
fn to_windows_form(p: &str) -> Option<String> {
    if p.is_empty() || p.chars().any(|c| c.is_control()) || is_remote_or_device(p) {
        return None;
    }
    let b = p.as_bytes();
    let converted = if b[0] == b'/' {
        if b.len() >= 2 && b[1].is_ascii_alphabetic() && (b.len() == 2 || b[2] == b'/') {
            format!(
                "{}:\\{}",
                (b[1] as char).to_ascii_uppercase(),
                p.get(3..).unwrap_or("")
            )
        } else {
            return None;
        }
    } else if b[0] == b'\\' {
        return None;
    } else {
        p.to_string()
    };
    let converted = converted.replace('/', "\\");
    // A colon anywhere but after a drive letter is an NTFS alternate data
    // stream (`notes.txt:hidden`) — not a file anyone meant to click.
    if converted
        .char_indices()
        .any(|(i, c)| c == ':' && !(i == 1 && converted.as_bytes()[0].is_ascii_alphabetic()))
    {
        return None;
    }
    Some(converted)
}

/// `C:\…` — as opposed to `C:foo`, which is relative to whatever directory
/// drive C happens to have, and is refused for the same reason as `\foo`.
fn is_drive_absolute(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\'
}

/// `CON`, `NUL`, `COM1` and friends are devices in every directory. Opening
/// one is at best a hang.
fn names_a_device(path: &Path) -> bool {
    const DEVICES: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM1", "COM2", "COM3", "COM4", "COM5",
        "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7",
        "LPT8", "LPT9",
    ];
    path.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        let stem = name
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end()
            .to_ascii_uppercase();
        DEVICES.contains(&stem.as_str())
    })
}

fn expand_home(p: &str, home: Option<&Path>) -> Option<String> {
    if p == "~" {
        return home.map(|h| h.to_string_lossy().into_owned());
    }
    if let Some(rest) = p.strip_prefix(r"~\") {
        return home.map(|h| h.join(rest).to_string_lossy().into_owned());
    }
    Some(p.to_string())
}

/// Where a clicked path points on this machine, if it exists.
///
/// `cwds` are the directories a relative path might be relative to, best
/// first: the one the shell last reported, then the one the pane was started
/// in. The home directory is tried after them — it is where a pane with no
/// configured directory starts. The first place the path actually exists
/// wins, which is what makes a stale or missing report cost a lookup rather
/// than the wrong file.
pub(crate) fn resolve(raw: &str, cwds: &[String], home: Option<&Path>) -> Option<PathBuf> {
    let p = expand_home(&to_windows_form(raw)?, home)?;
    let exists = |c: &Path| !names_a_device(c) && std::fs::metadata(c).is_ok();

    if is_drive_absolute(&p) {
        let c = PathBuf::from(&p);
        return exists(&c).then_some(c);
    }
    // `C:foo` — drive-relative, see `is_drive_absolute`.
    if p.as_bytes().get(1) == Some(&b':') {
        return None;
    }
    let bases = cwds
        .iter()
        .filter_map(|c| expand_home(&to_windows_form(c)?, home))
        .filter(|c| is_drive_absolute(c))
        .map(PathBuf::from)
        .chain(home.map(Path::to_path_buf));
    for base in bases {
        let c = base.join(&p);
        if exists(&c) {
            return Some(c);
        }
    }
    None
}

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
];

fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
}

/// Whether opening this file by association would run it.
fn runs_when_opened(path: &Path) -> bool {
    let Some(ext) = extension_of(path) else {
        return false;
    };
    if RUNS_SOMETHING.contains(&ext.as_str()) {
        return true;
    }
    if let Ok(pathext) = std::env::var("PATHEXT") {
        if pathext
            .split(';')
            .any(|e| e.trim_start_matches('.').eq_ignore_ascii_case(&ext))
        {
            return true;
        }
    }
    assoc_is_dangerous(&ext)
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

/// Shows a file selected in an Explorer window. `explorer.exe` always exits
/// non-zero, so its status says nothing and is not read.
#[cfg(windows)]
fn reveal(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // Raw, because `/select,` has to be one token with the path quoted inside
    // it, which is not a quoting std's argument escaping produces. A Windows
    // filename cannot contain `"`, so the path cannot close the quote early.
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not start Explorer: {e}"))
}

/// Opens a path by association. A file with no associated program gets the
/// system's "Open with" picker, which can also remember the choice.
#[cfg(windows)]
fn shell_open(owner: Option<isize>, path: &Path, is_dir: bool) -> Result<bool, String> {
    use std::ffi::c_void;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_CANCELLED, ERROR_NO_ASSOCIATION, HWND};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::{
        SHOpenWithDialog, ShellExecuteExW, OAIF_ALLOW_REGISTRATION, OAIF_EXEC, OAIF_REGISTER_EXT,
        OPENASINFO, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file: Vec<u16> = path
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let hwnd = HWND(owner.unwrap_or(0) as *mut c_void);

    // Shell extensions expect COM, and this is a fresh blocking thread.
    let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    let result = (|| {
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            // NO_UI so a missing association comes back as an error this can
            // act on, rather than as whatever the shell decides to show.
            fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
            hwnd,
            // The default verb, whatever the type's handler registered.
            lpVerb: PCWSTR::null(),
            lpFile: PCWSTR(file.as_ptr()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        match unsafe { ShellExecuteExW(&mut info) } {
            Ok(()) => return Ok(true),
            Err(e) if !is_dir && e.code() == ERROR_NO_ASSOCIATION.to_hresult() => {}
            Err(e) => return Err(format!("Windows could not open it: {e}")),
        }
        // No program for this type. The picker is what Explorer shows for a
        // double-click on the same file; EXEC opens it once chosen, and
        // REGISTER_EXT offers "always use this app".
        let open_as = OPENASINFO {
            pcszFile: PCWSTR(file.as_ptr()),
            pcszClass: PCWSTR::null(),
            oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_REGISTER_EXT | OAIF_EXEC,
        };
        match unsafe { SHOpenWithDialog(Some(hwnd), &open_as) } {
            Ok(()) => Ok(true),
            Err(e) if e.code() == ERROR_CANCELLED.to_hresult() => Ok(false),
            Err(e) => Err(format!("Windows could not offer a program for it: {e}")),
        }
    })();
    if com.is_ok() {
        unsafe { CoUninitialize() };
    }
    result
}

#[tauri::command]
pub async fn open_local_path(
    app: tauri::AppHandle,
    path: String,
    cwds: Vec<String>,
) -> Result<OpenOutcome, String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        // HWND is not Send; carried across as a plain integer, as hello.rs
        // does. Owning the picker to our window keeps it in front of us.
        let owner = app
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as isize);
        tokio::task::spawn_blocking(move || {
            let home = dirs::home_dir();
            let Some(found) = resolve(&path, &cwds, home.as_deref()) else {
                return Ok(OpenOutcome::NotFound);
            };
            let shown = found.to_string_lossy().into_owned();
            let is_dir = std::fs::metadata(&found)
                .map(|m| m.is_dir())
                .unwrap_or(false);
            if is_dir {
                shell_open(owner, &found, true)?;
                return Ok(OpenOutcome::Folder { path: shown });
            }
            if runs_when_opened(&found) {
                reveal(&found)?;
                return Ok(OpenOutcome::Revealed { path: shown });
            }
            Ok(if shell_open(owner, &found, false)? {
                OpenOutcome::Opened { path: shown }
            } else {
                OpenOutcome::Cancelled
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, path, cwds);
        Err("Opening files from a local pane is only supported on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_network_and_device_paths() {
        for p in [
            r"\\evil\share\x.txt",
            "//evil/share/x.txt",
            r"\\?\C:\x",
            r"\\.\PhysicalDrive0",
            r"\/evil/x",
        ] {
            assert_eq!(to_windows_form(p), None, "{p}");
        }
    }

    #[test]
    fn translates_msys_paths_and_refuses_other_roots() {
        assert_eq!(
            to_windows_form("/c/Users/tim").as_deref(),
            Some(r"C:\Users\tim")
        );
        assert_eq!(to_windows_form("/d").as_deref(), Some(r"D:\"));
        assert_eq!(to_windows_form("/etc/hosts"), None);
        assert_eq!(to_windows_form(r"\Windows"), None);
        assert_eq!(
            to_windows_form("src/main.rs").as_deref(),
            Some(r"src\main.rs")
        );
    }

    #[test]
    fn refuses_alternate_data_streams() {
        assert_eq!(to_windows_form(r"C:\x\notes.txt:hidden"), None);
        assert!(to_windows_form(r"C:\x\notes.txt").is_some());
    }

    // The filesystem cases need a drive-absolute temporary directory, which
    // only Windows has: `resolve` refuses any other base by design.
    #[cfg(windows)]
    #[test]
    fn resolves_against_the_first_directory_it_exists_in() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        std::fs::create_dir(b.path().join("src")).unwrap();
        std::fs::write(b.path().join("src").join("main.rs"), "").unwrap();
        let cwds = vec![
            a.path().to_string_lossy().into_owned(),
            b.path().to_string_lossy().into_owned(),
        ];
        let got = resolve("src/main.rs", &cwds, None).unwrap();
        assert_eq!(got, b.path().join(r"src\main.rs"));
        assert_eq!(resolve("src/missing.rs", &cwds, None), None);
    }

    #[test]
    fn ignores_a_working_directory_that_is_a_network_path() {
        let cwds = vec![r"\\evil\share".to_string()];
        assert_eq!(resolve("x.txt", &cwds, None), None);
    }

    #[cfg(windows)]
    #[test]
    fn expands_home() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("notes.txt"), "").unwrap();
        assert_eq!(
            resolve("~/notes.txt", &[], Some(home.path())),
            Some(home.path().join("notes.txt"))
        );
    }

    #[test]
    fn refuses_devices() {
        let d = tempfile::tempdir().unwrap();
        let cwds = vec![d.path().to_string_lossy().into_owned()];
        assert_eq!(resolve("con", &cwds, None), None);
        assert_eq!(resolve(r"sub\nul.txt", &cwds, None), None);
    }

    #[test]
    fn treats_programs_and_scripts_as_running() {
        for f in ["a.exe", "b.BAT", "c.js", "d.lnk", "e.ps1", "f.url", "g.hta"] {
            assert!(runs_when_opened(Path::new(f)), "{f}");
        }
        for f in ["a.txt", "b.rs", "c.md", "Makefile"] {
            assert!(!runs_when_opened(Path::new(f)), "{f}");
        }
    }
}
