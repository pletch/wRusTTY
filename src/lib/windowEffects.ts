import { invoke } from '@tauri-apps/api/core'

export type VibrancyMode = 'off' | 'acrylic' | 'mica'

/** Applies (or clears) the main window's OS-level vibrancy effect. Errors on
 * platforms other than Windows — callers should treat that as expected, not
 * surface it, since the DOM-level opacity still applies on its own. */
export function setWindowVibrancy(mode: VibrancyMode, tint: [number, number, number, number]) {
  return invoke<void>('set_window_vibrancy', { mode, tint })
}
