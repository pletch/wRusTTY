//! Android only: reading and writing what the file picker returns, which is a
//! `content://` link rather than a path `std::fs` could open. The Kotlin half is
//! `DeviceFilesPlugin`.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, Wry};
use wr_ssh::AuthMethod;
use zeroize::Zeroize;

struct DeviceFiles<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("device-files")
        .setup(|app, api| {
            let handle = api.register_android_plugin("sh.wrustty.app", "DeviceFilesPlugin")?;
            app.manage(DeviceFiles(handle));
            Ok(())
        })
        .build()
}

#[derive(Serialize)]
struct ReadArgs<'a> {
    uri: &'a str,
}

#[derive(Serialize)]
struct WriteArgs<'a> {
    uri: &'a str,
    base64: String,
}

#[derive(Deserialize)]
struct ReadReply {
    base64: String,
}

pub fn is_content_uri(path: &str) -> bool {
    path.starts_with("content://")
}

pub async fn read(app: &AppHandle, uri: &str) -> Result<Vec<u8>, String> {
    let mut reply: ReadReply = app
        .state::<DeviceFiles<Wry>>()
        .0
        .run_mobile_plugin_async("read", ReadArgs { uri })
        .await
        .map_err(|e| e.to_string())?;
    let bytes = BASE64.decode(&reply.base64).map_err(|e| e.to_string());
    reply.base64.zeroize();
    bytes
}

pub async fn write(app: &AppHandle, uri: &str, bytes: &[u8]) -> Result<(), String> {
    app.state::<DeviceFiles<Wry>>()
        .0
        .run_mobile_plugin_async::<serde_json::Value>(
            "write",
            WriteArgs {
                uri,
                base64: BASE64.encode(bytes),
            },
        )
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// A one-off connection with a key picked for it. `wr_ssh` reads a key from a path,
/// which a `content://` link isn't, so the key goes in directly. That also rules out
/// an unattended reconnect, as for any key held in memory.
pub async fn inline_picked_key(app: &AppHandle, auth: &mut AuthMethod) -> Result<(), String> {
    let AuthMethod::PublicKey {
        key_path,
        passphrase,
    } = auth
    else {
        return Ok(());
    };
    if !is_content_uri(key_path) {
        return Ok(());
    }
    let mut bytes = read(app, key_path).await?;
    let key_material = String::from_utf8(std::mem::take(&mut bytes))
        .map_err(|_| "that file isn't a text SSH key".to_string())?
        .replace("\r\n", "\n");
    *auth = AuthMethod::PublicKeyMaterial {
        key_material,
        passphrase: passphrase.take(),
    };
    Ok(())
}
