//! Reclaiming focus around Windows credential prompts hosted by a separate
//! broker process (the `UserConsentVerifier` consent dialog and the Windows
//! Hello prompt from `RequestSignAsync`). Focus doesn't return on its own when
//! they close.
//!
//! # Limits
//!
//! The Hello prompt can't be given an owner HWND (`KeyCredentialManager` has no
//! interop for it), so it may open behind us with its own generic taskbar
//! button. Its window runs at a higher integrity level, so UIPI silently drops
//! attempts to change it (`WM_SETICON`, `AttachThreadInput`, reparenting, or
//! setting its AppUserModelID). That's by design; leave the prompt alone.
//!
//! The taskbar button belongs to Explorer, at our integrity level, so
//! `ITaskbarList::DeleteTab` can remove it (`hide_broker_taskbar_button`). The
//! prompt stays reachable via Alt-Tab.
//!
//! Removing the button is only safe if the prompt is in front; otherwise it
//! hides a hidden modal. So `allow_broker_foreground` reports whether it took
//! the foreground, and the caller only hides the button when it did.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::HWND;

/// Forces `hwnd` to the foreground although the broker, not us, received the
/// last input event (so a plain `SetForegroundWindow` is silently refused).
/// Attaches our input queue to the foreground thread's for the duration, which
/// the foreground lock accepts; Windows Terminal uses the same trick.
fn force_foreground(hwnd: HWND) {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    };

    unsafe {
        let foreground = GetForegroundWindow();
        let foreground_thread = GetWindowThreadProcessId(foreground, None);
        let current_thread = GetCurrentThreadId();
        let attached = foreground_thread != current_thread
            && AttachThreadInput(current_thread, foreground_thread, true).as_bool();

        let _ = SetForegroundWindow(hwnd);
        let _ = BringWindowToTop(hwnd);
        // Activation doesn't restore keyboard focus inside the WebView2 child;
        // set it explicitly while still attached.
        let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(Some(hwnd));

        if attached {
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        }
    }
}

/// Call immediately before raising a broker prompt we can't parent. Grants the
/// next process the right to take the foreground (`AllowSetForegroundWindow`),
/// which is only honored if we hold the foreground, so we take it first.
///
/// Best-effort: if we don't hold the foreground already, nothing here can take
/// it (the foreground lock defeats the `AttachThreadInput` workaround too).
/// Returns whether we hold it, so the caller can adapt.
#[must_use]
pub(crate) fn allow_broker_foreground(hwnd: HWND) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, GetForegroundWindow, IsIconic, SetForegroundWindow, ShowWindow,
        ASFW_ANY, SW_RESTORE,
    };

    unsafe {
        // A minimized window can't take the foreground (e.g. an unlock at startup).
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }

        let _ = SetForegroundWindow(hwnd);

        // A denied `SetForegroundWindow` doesn't report failure; check directly.
        let held = GetForegroundWindow() == hwnd;
        let _ = AllowSetForegroundWindow(ASFW_ANY);

        if !held {
            // Logged so a "prompt opened behind" report has something to match.
            log::warn!(
                "could not take foreground before the Windows Hello prompt; \
                 it may open behind other windows"
            );
        }
        held
    }
}

/// Window class of the Windows Hello prompt (`CredentialUIBroker.exe`); the
/// title is localized.
const BROKER_WINDOW_CLASS: PCWSTR = w!("Credential Dialog Xaml Host");

/// How long to look for the prompt window, so a future renamed class degrades
/// to a brief search rather than polling while the prompt is open.
const BROKER_SEARCH_TIMEOUT: Duration = Duration::from_secs(20);

const BROKER_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// How long to keep re-deleting the taskbar button: the window may appear
/// before Explorer adds its button, and Explorer re-adds it whenever the prompt
/// is activated. Neither event is observable, so keep sweeping.
const BUTTON_SWEEP_DURATION: Duration = Duration::from_secs(10);

const BUTTON_SWEEP_INTERVAL: Duration = Duration::from_millis(150);

/// Stops the watcher thread when dropped (it exits within one poll).
pub(crate) struct BrokerEscort {
    stop: Arc<AtomicBool>,
}

impl Drop for BrokerEscort {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Finds the broker's prompt window once it's visible (Explorer adds the
/// button only after that).
fn find_broker_window() -> Option<HWND> {
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, IsWindowVisible};

    unsafe { FindWindowW(BROKER_WINDOW_CLASS, PCWSTR::null()) }
        .ok()
        .filter(|hwnd| !hwnd.is_invalid() && unsafe { IsWindowVisible(*hwnd) }.as_bool())
}

/// Repeatedly removes `broker`'s taskbar button until the prompt closes, the
/// guard drops, or the sweep window ends.
fn sweep_taskbar_button(broker: HWND, stop: &AtomicBool) {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{ITaskbarList, TaskbarList};

    unsafe {
        // STA: `TaskbarList` is apartment-threaded, and this thread never blocks
        // on another apartment.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    let taskbar: Option<ITaskbarList> =
        unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER) }.ok();
    if let Some(taskbar) = taskbar {
        if unsafe { taskbar.HrInit() }.is_ok() {
            let deadline = Instant::now() + BUTTON_SWEEP_DURATION;
            while !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
                // The prompt is gone, and its button with it.
                if find_broker_window().is_none() {
                    break;
                }
                let _ = unsafe { taskbar.DeleteTab(broker) };
                std::thread::sleep(BUTTON_SWEEP_INTERVAL);
            }
        }
    }

    unsafe { CoUninitialize() };
}

/// Call immediately before raising the Hello prompt, keeping the guard alive
/// until it closes. Watches for the prompt window and keeps its taskbar button
/// deleted; see the module docs. Polls rather than using `SetWinEventHook`,
/// which would need a message pump on a thread that's blocked in WinRT.
pub(crate) fn hide_broker_taskbar_button() -> BrokerEscort {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);

    std::thread::spawn(move || {
        // A prompt already on screen belongs to someone else.
        let preexisting = find_broker_window().map(|hwnd| hwnd.0 as isize);
        let deadline = Instant::now() + BROKER_SEARCH_TIMEOUT;

        while !thread_stop.load(Ordering::Relaxed) && Instant::now() < deadline {
            if let Some(broker) = find_broker_window() {
                if Some(broker.0 as isize) != preexisting {
                    sweep_taskbar_button(broker, &thread_stop);
                    return;
                }
            }
            std::thread::sleep(BROKER_POLL_INTERVAL);
        }
    });

    BrokerEscort { stop }
}

/// Call once a broker prompt has closed, whatever the outcome.
pub(crate) fn restore_after_broker_prompt(window: &tauri::WebviewWindow, hwnd: HWND) {
    force_foreground(hwnd);
    // WebView2 has its own focus manager; MoveFocus hands focus back to the
    // element that had it.
    let _ = window.with_webview(|webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
        unsafe {
            let _ = webview
                .controller()
                .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        }
    });
}
