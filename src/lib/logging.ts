import { invoke } from '@tauri-apps/api/core'

// Note: no `write` here — log bytes are written Rust-side by the output
// coalescer (src-tauri/src/coalesce.rs), never round-tripped through the
// webview. These commands only toggle logging on/off per session.
export function start(sessionId: string, label: string) {
  return invoke<string>('session_log_start', { sessionId, label })
}

export function stop(sessionId: string) {
  return invoke<void>('session_log_stop', { sessionId })
}
