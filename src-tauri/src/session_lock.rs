//! Locks the vault when the Windows session locks (Win+L, or an RDP
//! disconnect), so anyone reaching an unlocked session doesn't also reach an
//! unlocked vault. Tauri doesn't expose tao's message-loop hook, so the main
//! window is subclassed with `SetWindowSubclass`, as tao does internally.

#[cfg(target_os = "windows")]
pub fn register(app: &tauri::AppHandle) {
    use tauri::Manager;
    use windows::Win32::UI::Shell::SetWindowSubclass;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    // Tauri's HWND may come from a different `windows` crate instance than our
    // pinned `=0.62.2`, so pass it as an isize.
    let hwnd_value = hwnd.0 as isize;
    let hwnd = windows::Win32::Foundation::HWND(hwnd_value as _);

    // The callback can't capture `app`, so leak one AppHandle at startup and
    // pass its address as `dwrefdata`. It lives for the whole process.
    let app_ptr = Box::leak(Box::new(app.clone())) as *mut tauri::AppHandle as usize;

    unsafe {
        let _ = SetWindowSubclass(hwnd, Some(subclass_proc), 1, app_ptr);
        let _ = windows::Win32::System::RemoteDesktop::WTSRegisterSessionNotification(
            hwnd,
            windows::Win32::System::RemoteDesktop::NOTIFY_FOR_THIS_SESSION,
        );
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn subclass_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _uidsubclass: usize,
    dwrefdata: usize,
) -> windows::Win32::Foundation::LRESULT {
    use tauri::{Emitter, Manager};
    use windows::Win32::UI::Shell::DefSubclassProc;
    use windows::Win32::UI::WindowsAndMessaging::{
        WM_WTSSESSION_CHANGE, WTS_REMOTE_DISCONNECT, WTS_SESSION_LOCK,
    };

    if msg == WM_WTSSESSION_CHANGE {
        let reason = wparam.0 as u32;
        if reason == WTS_SESSION_LOCK || reason == WTS_REMOTE_DISCONNECT {
            // Safe: `dwrefdata` is a leaked AppHandle that lives for the process.
            let app = unsafe { &*(dwrefdata as *const tauri::AppHandle) }.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::vault::vault_lock(app.state::<crate::vault::VaultState>()).await;
                // No command triggered this, so tell the frontend, or the vault menu keeps
                // showing "unlocked".
                let _ = app.emit("vault-locked", ());
            });
        }
    }

    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

#[cfg(not(target_os = "windows"))]
pub fn register(_app: &tauri::AppHandle) {}
