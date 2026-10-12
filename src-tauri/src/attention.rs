//! Getting the user's attention when the window isn't the one they're looking
//! at (an in-app toast goes unseen after alt-tabbing away). Two complementary
//! mechanisms:
//!
//! - **A native notification** (`tauri-plugin-notification`) in the Action
//!   Center, which persists until dismissed.
//! - **Flashing the taskbar button** ([`flash_taskbar`]), the usual Windows
//!   signal, which needs no registration.
//!
//! Windows only shows toasts for an AppUserModelID with an installed
//! Start-menu shortcut. The NSIS bundle creates one; `tauri dev` doesn't, so in
//! development the flash is the only feedback.

/// Flashes the window's taskbar button until the user activates it.
/// `FLASHW_TRAY | FLASHW_TIMERNOFG` flashes the button (not the title bar) and
/// stops once the window is in front; `u32::MAX` means "until then". Never
/// raises the window, which would steal focus.
#[cfg(windows)]
pub fn flash_taskbar(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        FlashWindowEx, FLASHWINFO, FLASHW_TIMERNOFG, FLASHW_TRAY,
    };

    // Already in front: flashing the window in use would look like a fault.
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
        // Returns the previous flash state, not success; nothing to check.
        let _ = FlashWindowEx(&info);
    }
}

/// No equivalent outside Windows; the notification half works everywhere.
#[cfg(not(windows))]
pub fn flash_taskbar(_window: &tauri::WebviewWindow) {}

#[tauri::command]
pub async fn flash_window(window: tauri::WebviewWindow) -> Result<(), String> {
    flash_taskbar(&window);
    Ok(())
}
