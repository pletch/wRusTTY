//! Android only: tells `SessionKeepAliveService` how many sessions are open, so
//! a backgrounded app keeps its connections. The Kotlin half is in
//! `gen/android/app/src/main/java/sh/wrustty/app/`.

use serde::Serialize;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, Wry};

struct KeepAlive<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
struct SetSessions {
    count: u32,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("keep-alive")
        .setup(|app, api| {
            let handle = api.register_android_plugin("sh.wrustty.app", "KeepAlivePlugin")?;
            app.manage(KeepAlive(handle));
            Ok(())
        })
        .build()
}

/// `async` so it isn't on the main thread: `run_mobile_plugin` blocks on a reply
/// that the Kotlin side sends from there.
#[tauri::command]
pub async fn keep_alive_set_sessions(app: AppHandle, count: u32) -> Result<(), String> {
    app.state::<KeepAlive<Wry>>()
        .0
        .run_mobile_plugin::<serde_json::Value>("setSessions", SetSessions { count })
        .map(|_| ())
        .map_err(|e| e.to_string())
}
