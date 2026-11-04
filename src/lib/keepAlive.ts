import { invoke } from '@tauri-apps/api/core'
import { parseReconnecting } from './connection'
import { isAndroid } from './platform'

/**
 * Android freezes a backgrounded app and its connections with it, unless a
 * foreground service is running. This counts what needs keeping alive and tells
 * `keep_alive.rs`. See docs/ANDROID_PLAN.md.
 */

/** Sessions worth holding the process for: open, or on the way to being open. */
export function liveSessionCount(statuses: string[]): number {
  return statuses.filter(
    (s) => s === 'connected' || s === 'connecting' || parseReconnecting(s) !== null,
  ).length
}

/** A light tick for a key row press. It needs no permission, and follows the phone's
 * own touch feedback setting. A miss isn't worth reporting. */
export function tapHaptic(): void {
  invoke('key_haptic').catch(() => {})
}

export function syncKeepAlive(count: number): void {
  if (!isAndroid) return
  invoke('keep_alive_set_sessions', { count }).catch((e: unknown) => {
    console.warn('could not update the keep-alive service', e)
  })
}
