import { invoke } from '@tauri-apps/api/core'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

/** Telling the user something happened while they were looking at another
 * window.
 *
 * An in-app toast can't do this job — the whole premise of "your command
 * finished" is that you alt-tabbed away, so the toast appears and expires
 * unseen. Two mechanisms cover it together:
 *
 * - A **native notification**, which lands in the Action Center and stays
 *   until dismissed.
 * - A **flashing taskbar button**, the conventional Windows signal for "this
 *   window wants you".
 *
 * Both, not either. Windows only shows a toast for an app whose
 * AppUserModelID matches an installed Start-menu shortcut: the NSIS bundle
 * creates one, `tauri dev` doesn't. So in a dev build the toast silently does
 * nothing and the flash is the only feedback — which is also why the flash
 * isn't merely a fallback for a denied permission. */

/** Cached because `isPermissionGranted` is an IPC round trip and this is
 * called from a completion handler that can fire several times in a row.
 * Null means "not yet asked". */
let granted: boolean | null = null

async function ensurePermission(): Promise<boolean> {
  if (granted !== null) return granted
  try {
    granted = (await isPermissionGranted()) || (await requestPermission()) === 'granted'
  } catch {
    // A build with the plugin unavailable (`npm run dev` in a plain browser)
    // must not turn a completed command into an unhandled rejection.
    granted = false
  }
  return granted
}

/** Flashes the taskbar button until the window is activated. No-op when the
 * window is already focused, and on non-Windows platforms. */
export function flashWindow(): Promise<void> {
  return invoke<void>('flash_window').catch(() => {})
}

/** Raises attention for something that finished out of view.
 *
 * Deliberately never focuses the window: stealing focus from whatever the
 * user is doing, because a background command exited, is a worse interruption
 * than the thing being reported. */
export async function notifyInBackground(title: string, body: string): Promise<void> {
  // Fired first, and not awaited against the notification: it needs no
  // permission and no registration, so it is the half most likely to work.
  void flashWindow()
  if (!(await ensurePermission())) return
  try {
    sendNotification({ title, body })
  } catch {
    // Same reasoning as above — the flash has already happened.
  }
}

/** Test seam: the permission result is cached for the process lifetime. */
export function resetPermissionCache(): void {
  granted = null
}
