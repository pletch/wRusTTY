import { invoke } from '@tauri-apps/api/core'

// No `write`: log bytes are written Rust-side by the coalescer
// (src-tauri/src/coalesce.rs). These only toggle logging per session.
/** `directory` is Settings → Logging's folder; '' for the default. */
export function start(sessionId: string, label: string, plainText: boolean, directory: string) {
  return invoke<string>('session_log_start', {
    sessionId,
    label,
    plainText,
    directory: directory || null,
  })
}

export function stop(sessionId: string) {
  return invoke<void>('session_log_stop', { sessionId })
}

/**
 * Writes a pane dump beside the session logs and returns its path. Contents
 * come from the webview, which holds the grid (see `GhosttyEngine.dumpState`).
 */
export function writePaneDump(label: string, contents: string) {
  return invoke<string>('write_pane_dump', { label, contents })
}

/** Opens the session-logs folder (creating it if needed); '' is the
 * default. */
export function revealLogs(directory: string) {
  return invoke<void>('reveal_session_logs', { directory: directory || null })
}
