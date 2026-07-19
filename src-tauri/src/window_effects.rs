//! Window-vibrancy backends for the optional background-transparency
//! setting: acrylic (live blur-behind, but has a documented Microsoft
//! resize/drag performance bug on Win10 1903+/Win11 22000+), mica (no live
//! blur — a one-time wallpaper-color tint — but no such lag), and tabbed
//! (aka "Mica Alt" — the same wallpaper-tint approach as mica, just tuned
//! for windows with a tab strip, like this one's). Their apply/clear
//! functions already no-op with `Error::UnsupportedPlatform` on anything but
//! Windows, so this doesn't need its own `cfg(target_os)` gate; the frontend
//! just eats the error string on platforms where it doesn't apply.

use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn set_window_vibrancy(
    app: AppHandle,
    mode: String,
    tint: Option<(u8, u8, u8, u8)>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;

    // Clear all three unconditionally first — switching modes (or turning
    // off) shouldn't risk leaving the previous effect layered underneath
    // the new one, and clearing an effect that was never applied is a
    // harmless no-op.
    let _ = window_vibrancy::clear_acrylic(&window);
    let _ = window_vibrancy::clear_mica(&window);
    let _ = window_vibrancy::clear_tabbed(&window);

    // `dark: None` (mica/tabbed) follows the system light/dark preference
    // rather than forcing one, matching how the rest of the app doesn't
    // currently offer its own light/dark toggle independent of the OS.
    match mode.as_str() {
        "acrylic" => window_vibrancy::apply_acrylic(&window, tint).map_err(|e| e.to_string()),
        "mica" => window_vibrancy::apply_mica(&window, None).map_err(|e| e.to_string()),
        "tabbed" => window_vibrancy::apply_tabbed(&window, None).map_err(|e| e.to_string()),
        _ => Ok(()),
    }
}
