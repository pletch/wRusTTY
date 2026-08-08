//! Reclaiming keyboard focus after a Windows broker process has shown a
//! modal prompt over us.
//!
//! Both credential prompts we raise — the `UserConsentVerifier` consent
//! dialog and the Windows Hello gesture prompt that `RequestSignAsync`
//! triggers — are hosted by a *separate broker process*, not by us. When one
//! closes, focus does not come back on its own, and the obvious fixes don't
//! work either. Hence this module, which exists solely so the two call sites
//! share one correct implementation rather than each growing their own
//! subtly-wrong copy.
//!
//! # What cannot be done to the Hello prompt, and why
//!
//! The consent dialog behaves because `IUserConsentVerifierInterop` takes an
//! owner HWND. `KeyCredentialManager` has no such interop, so the Hello
//! prompt's window is *unowned* — which is why it opens behind us and earns
//! its own taskbar button wearing the generic executable icon
//! (`CredentialUIBroker.exe` carries no icon resource of its own).
//!
//! Reaching over and fixing that window directly is the obvious next idea. It
//! does not work, and the reason is worth recording so nobody spends the
//! afternoon rediscovering it: **the broker runs at a higher integrity level
//! than we do.** Measured against a live prompt, its token carries
//! `S-1-16-8202` against our `S-1-16-8192`, and UIPI compares those
//! numerically before delivering anything. Everything in the obvious toolkit
//! is therefore silently dropped — not failed, *dropped*, with a success-ish
//! return value and no error to notice:
//!
//! - `WM_SETICON` to re-icon its taskbar button. Verified inert: after
//!   sending it, `WM_GETICON` on that window still reads back 0.
//! - `AttachThreadInput` onto its thread, which is the trick
//!   `force_foreground` below relies on. Fails outright with
//!   `ERROR_ACCESS_DENIED`.
//! - `SetParent` / `GWLP_HWNDPARENT` to give it an owner after the fact —
//!   these don't work across processes at all, integrity aside.
//!
//! This is deliberate on Windows' part: a credential prompt that any
//! medium-integrity process could re-skin or drive would not be worth much.
//! Treat the elevated integrity level as load-bearing rather than as an
//! obstacle, and leave the prompt's own window alone.
//!
//! # What can be done instead
//!
//! The taskbar button is not the broker's to defend — it belongs to Explorer,
//! which runs at our own integrity level. `ITaskbarList::DeleteTab` therefore
//! goes straight through, and `hide_broker_taskbar_button` uses it to drop
//! the stray button without ever touching the prompt itself. Confirmed
//! against a live prompt by reading the taskbar back over UI Automation: the
//! `Credential Manager UI Host` entry is present before the call and gone
//! after it.
//!
//! What that buys is the button's *absence*, not a wRusTTY-branded button.
//! Re-branding would mean giving the window our AppUserModelID (Explorer keys
//! buttons by AUMID, and the broker's window carries none, which is why it
//! falls back to a generic per-executable entry) — plausible via
//! `SHGetPropertyStoreForWindow`, untested here, and moot while absence is
//! the desired outcome anyway.
//!
//! The window stays in the Alt-Tab list either way, so a prompt that opened
//! behind something is still reachable.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::HWND;

/// Forces `hwnd` to the foreground even though we didn't receive the last
/// input event (the credential broker did).
///
/// A plain `SetForegroundWindow(hwnd)` — tried first — doesn't help: the
/// prompt is hosted by a separate broker process, so it (not us) received the
/// last input event, which is exactly the condition Windows' foreground-lock
/// heuristic checks before honoring an unsolicited `SetForegroundWindow`
/// call. Denied requests don't error, they just silently no-op (or flash the
/// taskbar icon), which is why this looked fixed in the code but never
/// actually took effect.
///
/// The standard workaround: temporarily attach our thread's input queue to
/// the current foreground thread's. Shared input state is one of the
/// conditions the heuristic *does* accept, so `SetForegroundWindow` starts
/// working for the duration of the attachment. This is the same trick
/// Windows Terminal and other apps use to reclaim focus after a native
/// dialog closes.
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
        // SetForegroundWindow activates the top-level window, but that's a
        // different thing from keyboard focus actually landing back inside
        // it — WebView2 is a child control, and reactivating its parent
        // doesn't reliably re-establish which child/element had focus once
        // that tracking was blown away by a separate process's window
        // taking over. An explicit SetFocus (only meaningful now, while
        // still attached to the foreground thread's input queue) targets
        // keyboard focus directly instead of relying on activation to
        // imply it.
        let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(Some(hwnd));

        if attached {
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        }
    }
}

/// Call immediately *before* raising a broker-hosted prompt that we cannot
/// parent to our own window.
///
/// `KeyCredentialManager` has no interop interface for supplying an owner
/// HWND — unlike `IUserConsentVerifierInterop`, which is why the consent
/// dialog behaves and this one doesn't. Left alone, the broker's window
/// opens *behind* the app: Windows' foreground lock stops a process that
/// didn't receive the last input event from taking foreground, and the
/// broker didn't — we did, when the user clicked.
///
/// `AllowSetForegroundWindow(ASFW_ANY)` is the documented way to hand that
/// right over: the current foreground process voluntarily grants the next
/// process to ask permission to steal it. The `SetForegroundWindow` first is
/// not redundant — the grant is only honoured when the process making it
/// actually holds foreground, which may have lapsed if a prompt from an
/// earlier attempt is still on screen.
pub(crate) fn allow_broker_foreground(hwnd: HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, SetForegroundWindow, ASFW_ANY,
    };

    unsafe {
        let _ = SetForegroundWindow(hwnd);
        let _ = AllowSetForegroundWindow(ASFW_ANY);
    }
}

/// Window class of the Windows Hello gesture prompt, hosted by
/// `CredentialUIBroker.exe`. Its title is localized ("Windows Security" in
/// English), so the class is the identifier to match on.
const BROKER_WINDOW_CLASS: PCWSTR = w!("Credential Dialog Xaml Host");

/// How long to keep looking for the prompt window before giving up.
///
/// A bound on the *search*, not on the prompt — the user may take as long as
/// they like to answer. It exists so that a renamed window class in some
/// future Windows build degrades to "polls briefly, finds nothing, exits"
/// rather than spinning for as long as the prompt is open.
const BROKER_SEARCH_TIMEOUT: Duration = Duration::from_secs(20);

const BROKER_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// How long to keep re-deleting the taskbar button once the prompt is up.
///
/// One `DeleteTab` is not enough, for two reasons. We find the window the
/// moment it becomes visible, which may be *before* Explorer has added its
/// button — deleting a button that doesn't exist yet accomplishes nothing and
/// the button then appears anyway. And Explorer re-adds a button when its
/// window is activated, which happens every time the user clicks back to a
/// prompt they had clicked away from. Since there is no notification for
/// either event and no way to read the button back cheaply, the honest
/// implementation is to keep sweeping for a while.
const BUTTON_SWEEP_DURATION: Duration = Duration::from_secs(10);

const BUTTON_SWEEP_INTERVAL: Duration = Duration::from_millis(150);

/// Stops the watcher thread when dropped. Nothing is joined — the thread
/// notices the flag within one poll interval and exits on its own.
pub(crate) struct BrokerEscort {
    stop: Arc<AtomicBool>,
}

impl Drop for BrokerEscort {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Finds the broker's prompt window, but only once it is actually on screen.
///
/// The visibility filter matters: the window exists as soon as the broker
/// creates it, a moment before it is shown, and Explorer has certainly not
/// given it a taskbar button yet at that point.
fn find_broker_window() -> Option<HWND> {
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, IsWindowVisible};

    unsafe { FindWindowW(BROKER_WINDOW_CLASS, PCWSTR::null()) }
        .ok()
        .filter(|hwnd| !hwnd.is_invalid() && unsafe { IsWindowVisible(*hwnd) }.as_bool())
}

/// Repeatedly asks Explorer to drop `broker`'s taskbar button, until the
/// prompt closes, the guard is dropped, or the sweep window expires.
fn sweep_taskbar_button(broker: HWND, stop: &AtomicBool) {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{ITaskbarList, TaskbarList};

    unsafe {
        // Apartment-threaded rather than multi-threaded: `TaskbarList` is an
        // in-proc shell object registered `ThreadingModel=Apartment`, so an
        // STA gets it created directly with no proxy in the way. This thread
        // does nothing else and never blocks on another apartment, which is
        // what would otherwise make an STA without a message pump a hazard.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    let taskbar: Option<ITaskbarList> =
        unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER) }.ok();
    if let Some(taskbar) = taskbar {
        if unsafe { taskbar.HrInit() }.is_ok() {
            let deadline = Instant::now() + BUTTON_SWEEP_DURATION;
            while !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
                // Stop as soon as the prompt is gone: with the window
                // destroyed there is no button left to chase, and Explorer
                // has already cleaned up after it.
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

/// Call immediately *before* raising the Hello prompt, keeping the returned
/// guard alive until it has closed.
///
/// Watches for the prompt's window and, once it appears, keeps its stray
/// taskbar button deleted for as long as it plausibly matters. See the module
/// docs for why this is the one lever that works and why the more obvious
/// ones don't.
///
/// Polling rather than `SetWinEventHook`: the hook would need a thread
/// running a message pump to receive `WINEVENT_OUTOFCONTEXT` callbacks, and
/// the thread that raises the prompt is blocked inside the WinRT call with no
/// pump of its own. A 50ms `FindWindowW` on a fixed class is much less
/// machinery for the same answer.
pub(crate) fn hide_broker_taskbar_button() -> BrokerEscort {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);

    std::thread::spawn(move || {
        // A prompt already on screen when we arm belongs to somebody else —
        // ours cannot exist yet, since the call that raises it hasn't been
        // made. Deleting its button would be meddling with another app's
        // window.
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

/// Call once a broker-hosted credential prompt has closed, whatever its
/// outcome — a cancelled prompt strands focus just as thoroughly as a
/// successful one.
pub(crate) fn restore_after_broker_prompt(window: &tauri::WebviewWindow, hwnd: HWND) {
    force_foreground(hwnd);
    // Being the OS foreground window still isn't the same thing as WebView2
    // actually having keyboard focus on some element inside it — WebView2
    // keeps its own internal focus manager, and there's no guarantee
    // reactivating the parent HWND alone reaches into it correctly after a
    // different process's window (the prompt) held focus. MoveFocus is
    // WebView2's own API for exactly this: hand focus back in directly,
    // landing on whichever element had it before (or the default one),
    // instead of going through Win32 activation and hoping it cascades down
    // into the webview correctly.
    let _ = window.with_webview(|webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
        unsafe {
            let _ = webview
                .controller()
                .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        }
    });
}
