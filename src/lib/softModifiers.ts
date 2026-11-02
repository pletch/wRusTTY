/**
 * Ctrl and Alt for a soft keyboard, which has neither. Tapping one in the key
 * row arms it for the next key, from the row or the keyboard, which is how
 * `GhosttyInputHandler` picks it up. One set for the app: only the focused
 * terminal consumes it.
 */

export interface SoftModifiers {
  ctrl: boolean
  alt: boolean
}

const NONE: SoftModifiers = { ctrl: false, alt: false }

let current = NONE
const listeners = new Set<() => void>()

function set(next: SoftModifiers) {
  current = next
  for (const listener of listeners) listener()
}

export function softModifiers(): SoftModifiers {
  return current
}

export function subscribeSoftModifiers(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function toggleSoftModifier(which: keyof SoftModifiers): void {
  set({ ...current, [which]: !current[which] })
}

export function softModifierArmed(): boolean {
  return current.ctrl || current.alt
}

/** What's armed, disarming it: a modifier applies to one key. */
export function takeSoftModifiers(): SoftModifiers {
  const taken = current
  if (softModifierArmed()) set(NONE)
  return taken
}

/**
 * The legacy bytes for a modified character, for when the encoder has no answer
 * (a symbol it can't name as a key, or a pane whose WASM isn't up yet).
 */
export function legacyModifiedBytes(char: string, mods: SoftModifiers): Uint8Array {
  let text = char
  if (mods.ctrl) {
    const upper = char.toUpperCase()
    const code = upper.codePointAt(0) ?? 0
    if (upper === '?') text = '\x7f'
    else if (upper === ' ') text = '\0'
    else if (code >= 0x40 && code <= 0x5f) text = String.fromCharCode(code & 0x1f)
  }
  if (mods.alt) text = `\x1b${text}`
  return new TextEncoder().encode(text)
}
