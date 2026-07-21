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
