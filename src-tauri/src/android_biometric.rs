//! Android only: biometric vault unlock. The Kotlin half, `VaultBiometricPlugin`,
//! holds the Keystore key that encrypts this method's KEK; see it for why the
//! biometric can't be skipped.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::plugin::mobile::{ErrorResponse, PluginInvokeError};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, Wry};
use wr_vault::{
    async_trait, Kek, KeyProvider, ProviderError, WrapperKind, WrapperMeta, WrapperParams,
};
use zeroize::Zeroize;

struct VaultBiometric<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("vault-biometric")
        .setup(|app, api| {
            let handle = api.register_android_plugin("sh.wrustty.app", "VaultBiometricPlugin")?;
            app.manage(VaultBiometric(handle));
            Ok(())
        })
        .build()
}

#[derive(Serialize)]
struct ProtectArgs {
    kek: String,
}

impl Drop for ProtectArgs {
    fn drop(&mut self) {
        self.kek.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Protected {
    iv: String,
    wrapped_kek: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoverArgs<'a> {
    iv: &'a str,
    wrapped_kek: &'a str,
}

#[derive(Deserialize)]
struct Recovered {
    kek: String,
}

impl Drop for Recovered {
    fn drop(&mut self) {
        self.kek.zeroize();
    }
}

#[derive(Deserialize)]
struct KeyPresent {
    present: bool,
}

fn provider_error(e: PluginInvokeError) -> ProviderError {
    match e {
        PluginInvokeError::InvokeRejected(ErrorResponse { code, message, .. }) => {
            let message = message.unwrap_or_else(|| "biometric unlock failed".to_string());
            match code.as_deref() {
                Some("cancelled") => ProviderError::Cancelled,
                Some("invalidated") => ProviderError::Invalidated(message),
                Some("unavailable") => ProviderError::Unavailable(message),
                _ => ProviderError::Failed(message),
            }
        }
        other => ProviderError::Failed(other.to_string()),
    }
}

/// Whether this device holds the key. A wrapper travels with an exported vault,
/// but the key behind it never leaves the phone that made it. Doesn't prompt.
pub async fn key_present(app: &AppHandle) -> bool {
    app.state::<VaultBiometric<Wry>>()
        .0
        .run_mobile_plugin_async::<KeyPresent>("hasKey", ())
        .await
        .is_ok_and(|reply| reply.present)
}

/// Best effort: what's left behind can't open anything without the wrapper.
pub async fn forget(app: &AppHandle) {
    let _ = app
        .state::<VaultBiometric<Wry>>()
        .0
        .run_mobile_plugin_async::<serde_json::Value>("forget", ())
        .await;
}

pub struct AndroidBiometricProvider {
    pub app: AppHandle,
}

#[async_trait]
impl KeyProvider for AndroidBiometricProvider {
    fn kind(&self) -> WrapperKind {
        WrapperKind::AndroidBiometric
    }

    async fn kek_for(&self, meta: &WrapperMeta) -> Result<Kek, ProviderError> {
        let WrapperParams::AndroidBiometric { iv, wrapped_kek } = &meta.params else {
            return Err(ProviderError::WrongKind {
                expected: WrapperKind::AndroidBiometric,
                found: meta.kind(),
            });
        };
        let reply: Recovered = self
            .app
            .state::<VaultBiometric<Wry>>()
            .0
            .run_mobile_plugin_async("recover", RecoverArgs { iv, wrapped_kek })
            .await
            .map_err(provider_error)?;
        let mut bytes = BASE64
            .decode(&reply.kek)
            .map_err(|e| ProviderError::Failed(e.to_string()))?;
        let key: Result<[u8; 32], _> = bytes.as_slice().try_into();
        bytes.zeroize();
        key.map(Kek::from_bytes).map_err(|_| {
            ProviderError::Invalidated("the stored key has an unexpected length".to_string())
        })
    }

    async fn enroll(&self) -> Result<(WrapperParams, Kek), ProviderError> {
        // Fresh, so the data key never leaves the vault and turning this off leaves
        // nothing that opens it.
        let bytes: [u8; 32] = wr_vault::random_bytes();
        let reply: Protected = self
            .app
            .state::<VaultBiometric<Wry>>()
            .0
            .run_mobile_plugin_async(
                "protect",
                ProtectArgs {
                    kek: BASE64.encode(bytes),
                },
            )
            .await
            .map_err(provider_error)?;
        Ok((
            WrapperParams::AndroidBiometric {
                iv: reply.iv,
                wrapped_kek: reply.wrapped_kek,
            },
            Kek::from_bytes(bytes),
        ))
    }
}
