import { invoke } from '@tauri-apps/api/core'

// Note: no `write` here — log bytes are written Rust-side by the output
// coalescer (src-tauri/src/coalesce.rs), never round-tripped through the
// webview. These commands only toggle logging on/off per session.
export function start(sessionId: string, label: string, plainText: boolean) {
  return invoke<string>('session_log_start', { sessionId, label, plainText })
}

export function stop(sessionId: string) {
  return invoke<void>('session_log_stop', { sessionId })
}

/**
 * Writes a pane dump next to the session logs and returns its path.
 *
 * Unlike the transcript above, the contents come from this side: only the
 * webview holds the grid. See `GhosttyEngine.dumpState` for what is in one and
 * why it exists.
 */
export function writePaneDump(label: string, contents: string) {
  return invoke<string>('write_pane_dump', { label, contents })
}

/** Opens the session-logs folder in the OS file manager (creating it first if
 * nothing has been logged yet). */
export function revealLogs() {
  return invoke<void>('reveal_session_logs')
}
