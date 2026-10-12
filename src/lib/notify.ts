import { invoke } from '@tauri-apps/api/core'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

/** Telling the user something happened while they were in another window,
 * via a native notification and a flashing taskbar button (see
 * src-tauri/src/attention.rs). Both, since toasts need an installed
 * Start-menu shortcut and don't appear in `tauri dev`. */

/** Cached: `isPermissionGranted` is an IPC round trip, and completions can
 * fire in quick succession. Null means not yet asked. */
let granted: boolean | null = null

async function ensurePermission(): Promise<boolean> {
  if (granted !== null) return granted
  try {
    granted = (await isPermissionGranted()) || (await requestPermission()) === 'granted'
  } catch {
    // Without the plugin (a plain browser), a completion mustn't reject.
    granted = false
  }
  return granted
}

/** Flashes the taskbar button until the window is activated. No-op when the
 * window is already focused, and on non-Windows platforms. */
export function flashWindow(): Promise<void> {
  return invoke<void>('flash_window').catch(() => {})
}

/** Raises attention for something that finished out of view. Never focuses
 * the window, which would be a worse interruption than the news. */
export async function notifyInBackground(title: string, body: string): Promise<void> {
  // First and not awaited: it needs no permission, so it's likeliest to work.
  void flashWindow()
  if (!(await ensurePermission())) return
  try {
    sendNotification({ title, body })
  } catch {
    // The flash has already happened.
  }
}

/** Test seam: the permission result is cached for the process lifetime. */
export function resetPermissionCache(): void {
  granted = null
}
