//! Android only: locks the vault a while after the app leaves the screen. The
//! foreground service keeps the process alive indefinitely, so nothing else would, and a
//! phone is easily lost or picked up. Sessions stay connected; only the vault locks. One
//! that drops can then need an unlock to reconnect.
//!
//! Wall-clock time, since a monotonic clock stops while the phone sleeps. The check on
//! return covers a process that was frozen and couldn't run its timer.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::vault::VaultState;

const CHECK_EVERY: Duration = Duration::from_secs(15);

/// When the app left the screen, in Unix milliseconds, or 0 while it's on screen.
static HIDDEN_AT_MS: AtomicU64 = AtomicU64::new(0);
/// 0 is never. Holds this default until the frontend sends the setting.
static LOCK_AFTER_SECONDS: AtomicU64 = AtomicU64::new(5 * 60);
static APP: OnceLock<AppHandle> = OnceLock::new();

fn is_due(hidden_at_ms: u64, now_ms: u64, lock_after_seconds: u64) -> bool {
    hidden_at_ms > 0
        && lock_after_seconds > 0
        && now_ms.saturating_sub(hidden_at_ms) >= lock_after_seconds.saturating_mul(1000)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

async fn lock_if_unlocked(app: &AppHandle) {
    let state = app.state::<VaultState>();
    if state.vault.lock().await.take().is_some() {
        // No command triggered this, so tell the frontend, or the vault menu keeps
        // showing "unlocked".
        let _ = app.emit("vault-locked", ());
    }
}

pub fn start(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(CHECK_EVERY).await;
            let hidden_at = HIDDEN_AT_MS.load(Ordering::SeqCst);
            if is_due(
                hidden_at,
                now_ms(),
                LOCK_AFTER_SECONDS.load(Ordering::SeqCst),
            ) {
                lock_if_unlocked(&app).await;
            }
        }
    });
}

/// `MainActivity.appVisibilityChanged`.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_sh_wrustty_app_MainActivity_appVisibilityChanged(
    _env: *mut std::ffi::c_void,
    _activity: *mut std::ffi::c_void,
    visible: u8,
) {
    if visible == 0 {
        HIDDEN_AT_MS.store(now_ms(), Ordering::SeqCst);
        return;
    }
    let hidden_at = HIDDEN_AT_MS.swap(0, Ordering::SeqCst);
    if is_due(
        hidden_at,
        now_ms(),
        LOCK_AFTER_SECONDS.load(Ordering::SeqCst),
    ) {
        if let Some(app) = APP.get() {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { lock_if_unlocked(&app).await });
        }
    }
}

/// 0 is never.
#[tauri::command]
pub async fn vault_set_auto_lock(seconds: u64) -> Result<(), String> {
    LOCK_AFTER_SECONDS.store(seconds, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locks_once_the_delay_has_passed() {
        assert!(!is_due(1_000, 300_999, 300));
        assert!(is_due(1_000, 301_000, 300));
    }

    #[test]
    fn never_locks_while_on_screen_or_when_set_to_never() {
        assert!(!is_due(0, u64::MAX, 300));
        assert!(!is_due(1_000, u64::MAX, 0));
    }

    #[test]
    fn a_clock_moved_back_does_not_lock() {
        assert!(!is_due(5_000, 1_000, 1));
    }

    #[test]
    fn an_absurd_delay_does_not_overflow() {
        assert!(!is_due(1, 2, u64::MAX));
    }
}
