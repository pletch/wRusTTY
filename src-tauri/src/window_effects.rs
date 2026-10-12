//! Window-vibrancy backends for background transparency: acrylic (live blur,
//! with a documented resize/drag lag on Win10 1903+/Win11 22000+), mica (a
//! one-time wallpaper tint, no lag) and tabbed ("Mica Alt", tuned for tab
//! strips). They return `Error::UnsupportedPlatform` off Windows, which the
//! frontend ignores, so no `cfg` gate is needed.

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

    // Clear all three first, so switching never layers effects; clearing an
    // unapplied effect is harmless.
    let _ = window_vibrancy::clear_acrylic(&window);
    let _ = window_vibrancy::clear_mica(&window);
    let _ = window_vibrancy::clear_tabbed(&window);

    // `dark: None` follows the system light/dark preference.
    match mode.as_str() {
        "acrylic" => window_vibrancy::apply_acrylic(&window, tint).map_err(|e| e.to_string()),
        "mica" => window_vibrancy::apply_mica(&window, None).map_err(|e| e.to_string()),
        "tabbed" => window_vibrancy::apply_tabbed(&window, None).map_err(|e| e.to_string()),
        _ => Ok(()),
    }
}
