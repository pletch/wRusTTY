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

#[derive(Serialize)]
struct UriArgs<'a> {
    uri: &'a str,
}

#[derive(Serialize)]
struct OpenArgs<'a> {
    uri: &'a str,
    mode: &'a str,
}

#[derive(Deserialize)]
struct OpenReply {
    fd: i32,
}

#[derive(Serialize)]
struct CloseWriteArgs<'a> {
    fd: i32,
    error: Option<&'a str>,
}

#[derive(Deserialize)]
pub struct DeviceFile {
    pub name: String,
    pub size: Option<u64>,
}

async fn open(app: &AppHandle, uri: &str, mode: &str) -> Result<tokio::fs::File, String> {
    let reply: OpenReply = app
        .state::<DeviceFiles<Wry>>()
        .0
        .run_mobile_plugin_async("open", OpenArgs { uri, mode })
        .await
        .map_err(|e| e.to_string())?;
    // SAFETY: `detachFd` handed this descriptor over, and nothing else holds it.
    let file = unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(reply.fd) };
    Ok(tokio::fs::File::from_std(file))
}

pub async fn open_to_read(app: &AppHandle, uri: &str) -> Result<tokio::fs::File, String> {
    open(app, uri, "r").await
}

pub async fn describe(app: &AppHandle, uri: &str) -> Result<DeviceFile, String> {
    app.state::<DeviceFiles<Wry>>()
        .0
        .run_mobile_plugin_async("describe", UriArgs { uri })
        .await
        .map_err(|e| e.to_string())
}

/// Copies a finished local file to where the save dialog pointed.
pub async fn deliver(app: &AppHandle, from: &std::path::Path, uri: &str) -> Result<(), String> {
    let mut source = tokio::fs::File::open(from)
        .await
        .map_err(|e| e.to_string())?;
    let files = app.state::<DeviceFiles<Wry>>();
    let plugin = &files.0;
    let reply: OpenReply = plugin
        // "wt" truncates, so a shorter file doesn't keep the old one's tail.
        .run_mobile_plugin_async("openWrite", OpenArgs { uri, mode: "wt" })
        .await
        .map_err(|e| e.to_string())?;

    let copied = copy_to_descriptor(&mut source, reply.fd).await;
    // Only now can the provider be told. This is what makes a cloud provider keep the file.
    let closed = plugin
        .run_mobile_plugin_async::<serde_json::Value>(
            "closeWrite",
            CloseWriteArgs {
                fd: reply.fd,
                error: copied.as_ref().err().map(String::as_str),
            },
        )
        .await
        .map(|_| ())
        .map_err(|e| e.to_string());
    copied.and(closed)
}

/// Writes through a copy of a descriptor Kotlin keeps, and has closed the copy on return,
/// since a pipe's far end won't see the end of the file until every copy is closed.
async fn copy_to_descriptor(source: &mut tokio::fs::File, fd: i32) -> Result<(), String> {
    use std::os::fd::BorrowedFd;
    // SAFETY: Kotlin holds the descriptor open until `closeWrite`, which comes after this.
    let owned = unsafe { BorrowedFd::borrow_raw(fd) }
        .try_clone_to_owned()
        .map_err(|e| e.to_string())?;
    let mut target = tokio::fs::File::from_std(std::fs::File::from(owned));
    tokio::io::copy(source, &mut target)
        .await
        .map_err(|e| format!("could not save it to the device: {e}"))?;
    // Not all of them can sync, such as a pipe to a cloud provider.
    let _ = target.sync_all().await;
    drop(target.into_std().await);
    Ok(())
}

/// Best effort: what's left otherwise is an empty file.
pub async fn remove(app: &AppHandle, uri: &str) {
    let _ = app
        .state::<DeviceFiles<Wry>>()
        .0
        .run_mobile_plugin_async::<serde_json::Value>("remove", UriArgs { uri })
        .await;
}

/// A picked file's name, which its link doesn't show.
#[tauri::command]
pub async fn device_file_name(app: AppHandle, uri: String) -> Result<String, String> {
    describe(&app, &uri).await.map(|file| file.name)
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
