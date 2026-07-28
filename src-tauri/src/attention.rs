//! Getting the user's attention when the window isn't the one they're looking
//! at.
//!
//! An in-app toast is the wrong instrument for this and always was: the whole
//! point of "your command finished" is that you alt-tabbed away, so the toast
//! comes and goes unseen. Two mechanisms cover it, and they are complementary
//! rather than alternatives:
//!
//! - **A native notification** (`tauri-plugin-notification`) puts the message
//!   in the Action Center, where it persists until dismissed.
//! - **Flashing the taskbar button** ([`flash_taskbar`]) is the conventional
//!   Windows signal for "this window wants you", and it needs no registration
//!   of any kind — which matters, because the toast half does.
//!
//! The registration caveat is why both exist. Windows only shows a toast for
//! an app with an AppUserModelID matching an installed Start-menu shortcut.
//! The NSIS bundle creates one; `tauri dev` does not. So during development
//! the notification silently does nothing, and the taskbar flash is the only
//! feedback there is. Shipping only the toast would mean a feature that can't
//! be checked without building an installer first.

/// Flashes the window's taskbar button until the user activates it.
///
/// `FLASHW_TRAY | FLASHW_TIMERNOFG` is the well-behaved combination: flash the
/// taskbar button (not the title bar, which is noisier), and stop as soon as
/// the window comes to the foreground. `u32::MAX` as the count means "until
/// then" rather than a fixed number of blinks — a message that stops asking
/// while the user is still away hasn't done its job.
///
/// Deliberately does *not* raise the window. Stealing focus from whatever the
/// user is doing because a background command exited would be a much worse
/// interruption than the thing it's reporting.
#[cfg(windows)]
pub fn flash_taskbar(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        FlashWindowEx, FLASHWINFO, FLASHW_TIMERNOFG, FLASHW_TRAY,
    };

    // Already in front means there is nothing to attract attention to — and a
    // flashing taskbar button on the window you are actively using reads as a
    // fault rather than a notification.
    if window.is_focused().unwrap_or(false) {
        return;
    }

    let Ok(hwnd) = window.hwnd() else { return };
    let info = FLASHWINFO {
        cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
        hwnd: HWND(hwnd.0),
        dwFlags: FLASHW_TRAY | FLASHW_TIMERNOFG,
        uCount: u32::MAX,
        dwTimeout: 0,
    };
    unsafe {
        // The return value reports the window's *previous* flash state, not
        // success or failure — there is nothing here to check or recover from.
        let _ = FlashWindowEx(&info);
    }
}

/// No equivalent outside Windows, and none is wanted — this app's audience is
/// Windows-first, and the notification half works everywhere.
#[cfg(not(windows))]
pub fn flash_taskbar(_window: &tauri::WebviewWindow) {}

#[tauri::command]
pub async fn flash_window(window: tauri::WebviewWindow) -> Result<(), String> {
    flash_taskbar(&window);
    Ok(())
}
