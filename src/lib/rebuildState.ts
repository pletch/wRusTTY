import { invoke } from '@tauri-apps/api/core'

/**
 * What a webview rebuilt by Android should carry on with, so its terminals come back
 * at the size the far end already knows. Held in Rust: it should last as long as the
 * process, unlike React state, which dies with the webview, or the webview's storage,
 * which would outlive a restart. See `session_attach.rs`.
 */
export interface RebuildState {
  pinchFontSize: number | null
  /** The tallest the window has been, by width. See lib/keyboardHold.ts. */
  windowHeights: Record<string, number>
}

const EMPTY: RebuildState = { pinchFontSize: null, windowHeights: {} }

let current: RebuildState = EMPTY
let loaded = false

/** The saved state, once it's read. Nothing is saved before this, or a new webview's
 * empty state could overwrite what it's about to read. */
export async function loadRebuildState(): Promise<RebuildState> {
  try {
    const saved = await invoke<string | null>('session_ui_state_get')
    if (saved) current = { ...EMPTY, ...(JSON.parse(saved) as Partial<RebuildState>) }
  } catch {
    // Starting fresh only costs a resize.
  }
  loaded = true
  return current
}

export function saveRebuildState(patch: Partial<RebuildState>): void {
  if (!loaded) return
  current = { ...current, ...patch }
  invoke('session_ui_state_put', { value: JSON.stringify(current) }).catch(() => {})
}
