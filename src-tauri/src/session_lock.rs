//! Auto-locks the vault when the Windows session locks (Win+L, or an RDP
//! client disconnecting without an explicit lock) — otherwise a vault
//! unlocked once stays unlocked indefinitely, even across a screen lock,
//! which defeats the point of gating it with Windows Hello in the first
//! place: anyone who reaches the already-unlocked session reaches the vault
//! too.
//!
//! Tauri doesn't expose tao's internal message-loop hook to application
//! code (it's wired up only for Tauri's own accelerator handling), so the
//! only workable route is subclassing the main window ourselves via
//! `SetWindowSubclass`, the same Win32 mechanism tao already uses
//! internally on its own window.

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
    // `window.hwnd()` returns tauri's own copy of `windows::Win32::Foundation::HWND`,
    // which isn't guaranteed to be the same crate instance as this crate's
    // pinned `windows = "=0.62.2"` dependency — passing it directly into a
    // function typed against our own copy is a hard type mismatch (the
    // exact issue the Windows Hello feature's HWND handling already works
    // around). Round-trip through a plain isize instead.
    let hwnd_value = hwnd.0 as isize;
    let hwnd = windows::Win32::Foundation::HWND(hwnd_value as _);

    // SetWindowSubclass's callback is a plain `extern "system" fn` — it
    // can't capture `app`. `dwrefdata` exists exactly for this: leak an
    // AppHandle once at startup and pass its address through. Nothing ever
    // frees it, but there's only ever one for the process's whole lifetime,
    // and process exit reclaims it regardless.
    let app_ptr = Box::leak(Box::new(app.clone())) as *mut tauri::AppHandle as usize;

    unsafe {
        SetWindowSubclass(hwnd, Some(subclass_proc), 1, app_ptr);
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
    use tauri::Manager;
    use windows::Win32::UI::Shell::DefSubclassProc;
    use windows::Win32::UI::WindowsAndMessaging::{
        WM_WTSSESSION_CHANGE, WTS_REMOTE_DISCONNECT, WTS_SESSION_LOCK,
    };

    if msg == WM_WTSSESSION_CHANGE {
        let reason = wparam.0 as u32;
        if reason == WTS_SESSION_LOCK || reason == WTS_REMOTE_DISCONNECT {
            // Safe: `dwrefdata` is the address of a `Box::leak`'d AppHandle
            // that lives for the process's whole lifetime.
            let app = unsafe { &*(dwrefdata as *const tauri::AppHandle) }.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::vault::vault_lock(app.state::<crate::vault::VaultState>()).await;
            });
        }
    }

    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

#[cfg(not(target_os = "windows"))]
pub fn register(_app: &tauri::AppHandle) {}
