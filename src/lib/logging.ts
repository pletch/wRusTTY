import { invoke } from '@tauri-apps/api/core'

export function start(sessionId: string, label: string) {
  return invoke<string>('session_log_start', { sessionId, label })
}

export function write(sessionId: string, data: Uint8Array) {
  return invoke<void>('session_log_write', { sessionId, data: Array.from(data) })
}

export function stop(sessionId: string) {
  return invoke<void>('session_log_stop', { sessionId })
}
