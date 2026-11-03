import { invoke } from '@tauri-apps/api/core'

/** The choices for locking the vault after leaving the app, in minutes. 0 is never. */
export const VAULT_AUTO_LOCK_MINUTES = [1, 5, 15, 60, 0] as const

export function syncVaultAutoLock(minutes: number): void {
  invoke('vault_set_auto_lock', { seconds: minutes * 60 }).catch((e: unknown) => {
    console.warn('could not set the vault auto-lock', e)
  })
}

export function syncSecureScreen(on: boolean): void {
  invoke('set_secure_screen', { on }).catch((e: unknown) => {
    console.warn('could not set screen protection', e)
  })
}

const FORWARD_WARNED_KEY = 'wrustty.androidForwardWarned'

/** Whether a local or SOCKS forward still needs its one warning on this phone. */
export function forwardWarningDue(): boolean {
  try {
    return localStorage.getItem(FORWARD_WARNED_KEY) === null
  } catch {
    return true
  }
}

export function noteForwardWarned(): void {
  try {
    localStorage.setItem(FORWARD_WARNED_KEY, '1')
  } catch {
    // It asks again next time, which is the safe direction.
  }
}
