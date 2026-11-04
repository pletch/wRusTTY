/**
 * Ctrl and Alt for a soft keyboard, which has neither. Tapping one in the key
 * row arms it for the next key, from the row or the keyboard, which is how
 * `GhosttyInputHandler` picks it up. Tapping twice quickly locks it on until it's
 * tapped again, for things like a tmux prefix. One set for the app: only the
 * focused terminal consumes it.
 */

export interface SoftModifiers {
  ctrl: boolean
  alt: boolean
}

const NONE: SoftModifiers = { ctrl: false, alt: false }

/** A second tap within this long locks instead of disarming. */
const DOUBLE_TAP_MS = 350

let current = NONE
/** Which of `current` stay on after a key. */
let locks = NONE
let armedAt: Partial<Record<keyof SoftModifiers, number>> = {}
const listeners = new Set<() => void>()

function set(next: SoftModifiers, nextLocks: SoftModifiers = locks) {
  current = next
  locks = nextLocks
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

/** A stable object for a snapshot, like `softModifiers`. */
export function softModifierLocks(): SoftModifiers {
  return locks
}

/** A tap on a modifier's key: off, to armed, to locked if quick, and back to off. */
export function tapSoftModifier(which: keyof SoftModifiers, now = Date.now()): void {
  if (locks[which]) {
    set({ ...current, [which]: false }, { ...locks, [which]: false })
  } else if (!current[which]) {
    armedAt = { ...armedAt, [which]: now }
    set({ ...current, [which]: true })
  } else if (now - (armedAt[which] ?? 0) <= DOUBLE_TAP_MS) {
    set(current, { ...locks, [which]: true })
  } else {
    set({ ...current, [which]: false })
  }
}

export function softModifierArmed(): boolean {
  return current.ctrl || current.alt
}

/** What's on, disarming it: a modifier applies to one key unless it's locked. */
export function takeSoftModifiers(): SoftModifiers {
  const taken = current
  if (softModifierArmed() && (current.ctrl !== locks.ctrl || current.alt !== locks.alt)) {
    set(locks)
  }
  return taken
}

/** Everything off, locks included. */
export function clearSoftModifiers(): void {
  set(NONE, NONE)
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
