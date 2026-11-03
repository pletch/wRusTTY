//! Android only: asks the window to stay out of screenshots and screen sharing. The Kotlin
//! half is `ScreenSecurityPlugin`.

use serde::Serialize;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, Wry};

struct ScreenSecurity<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
struct SetSecure {
    on: bool,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("screen-security")
        .setup(|app, api| {
            let handle = api.register_android_plugin("sh.wrustty.app", "ScreenSecurityPlugin")?;
            app.manage(ScreenSecurity(handle));
            Ok(())
        })
        .build()
}

/// `async` so it isn't on the main thread, where the Kotlin side replies.
#[tauri::command]
pub async fn set_secure_screen(app: AppHandle, on: bool) -> Result<(), String> {
    app.state::<ScreenSecurity<Wry>>()
        .0
        .run_mobile_plugin::<serde_json::Value>("setSecure", SetSecure { on })
        .map(|_| ())
        .map_err(|e| e.to_string())
}
