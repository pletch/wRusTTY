/**
 * Configurable keyboard shortcuts: which app actions exist, what they are
 * bound to by default, and how a keydown is matched against them.
 *
 * A chord is stored as a canonical string — `Ctrl+Shift+T`, `Ctrl+=`,
 * `Shift+Insert` — with modifiers always in the order Ctrl, Alt, Shift, Win.
 * One spelling per chord is what lets conflicts be found by string equality,
 * and what makes a hand-edited settings blob either mean something exact or be
 * dropped.
 *
 * **Shift is only part of a chord when it changes nothing else.** On a letter
 * or a named key (Tab, Insert, F5) Shift is a real modifier. On a printable
 * symbol it is already spelled by the character: `+` is Shift+= on a US
 * keyboard and a key of its own on the numpad, so counting Shift as well would
 * make the same gesture two different chords depending on which key produced
 * it. Symbol chords therefore never carry Shift, recorded or typed.
 *
 * Every binding is consumed (`preventDefault`) by the handler that acts on it.
 * Under the engine's key encoder even Ctrl+Shift+letter encodes to something,
 * so a chord that is claimed must not also reach the far end.
 */

export type ActionId =
  | 'newTab'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'quickConnect'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'copy'
  | 'paste'
  | 'find'
  | 'markMode'
  | 'hintMode'
  | 'paneDump'

/** `window` actions are handled once for the whole app, `pane` ones by the
 *  focused terminal — which is why a pane action does nothing while a dialog
 *  has the keyboard. */
export type ShortcutScope = 'window' | 'pane'

export interface ShortcutAction {
  id: ActionId
  label: string
  scope: ShortcutScope
  defaults: readonly string[]
}

/** In the order Settings lists them. The defaults are the bindings the app
 *  shipped with before any of this was configurable, so an install with no
 *  overrides behaves exactly as it did. */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  { id: 'newTab', label: 'New tab', scope: 'window', defaults: ['Ctrl+Shift+T'] },
  { id: 'closeTab', label: 'Close tab', scope: 'window', defaults: ['Ctrl+Shift+W'] },
  { id: 'nextTab', label: 'Next tab', scope: 'window', defaults: ['Ctrl+Tab'] },
  { id: 'prevTab', label: 'Previous tab', scope: 'window', defaults: ['Ctrl+Shift+Tab'] },
  { id: 'quickConnect', label: 'Quick connect', scope: 'window', defaults: ['Ctrl+Shift+P'] },
  { id: 'zoomIn', label: 'Larger text', scope: 'window', defaults: ['Ctrl+=', 'Ctrl++'] },
  { id: 'zoomOut', label: 'Smaller text', scope: 'window', defaults: ['Ctrl+-'] },
  { id: 'zoomReset', label: 'Default text size', scope: 'window', defaults: ['Ctrl+0'] },
  { id: 'copy', label: 'Copy selection', scope: 'pane', defaults: ['Ctrl+Shift+C'] },
  // Shift+Insert because it is what PuTTY binds paste to, and that is the
  // muscle memory this app's users arrive with.
  { id: 'paste', label: 'Paste', scope: 'pane', defaults: ['Ctrl+Shift+V', 'Shift+Insert'] },
  { id: 'find', label: 'Find in scrollback', scope: 'pane', defaults: ['Ctrl+Shift+F'] },
  { id: 'markMode', label: 'Select with the keyboard', scope: 'pane', defaults: ['Ctrl+Shift+M'] },
  { id: 'hintMode', label: 'Open a link with the keyboard', scope: 'pane', defaults: ['Ctrl+Shift+U'] },
  { id: 'paneDump', label: 'Write a pane dump', scope: 'pane', defaults: ['Ctrl+Shift+D'] },
]

const ACTION_BY_ID = Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a.id, a])) as Record<
  ActionId,
  ShortcutAction
>

/** Overrides by action. An action absent here uses its defaults; present with
 *  an empty list, it is unbound. Only what differs is stored, so a default
 *  changed in a later version reaches everyone who never touched it. */
export type Keybindings = Partial<Record<ActionId, string[]>>

const NAMED_KEYS = [
  'Tab',
  'Enter',
  'Escape',
  'Space',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
]
const NAMED_BY_LOWER = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]))

/** What `KeyboardEvent.key` reports for a key that is only ever a modifier,
 *  or for no key at all. None of these can end a chord. */
const NOT_A_KEY = new Set([
  'Control',
  'Shift',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'Super',
  'Hyper',
  'Fn',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Dead',
  'Unidentified',
  'Process',
])

interface Chord {
  ctrl: boolean
  alt: boolean
  shift: boolean
  win: boolean
  key: string
}

function isLetter(key: string): boolean {
  return key.length === 1 && key.toLowerCase() !== key.toUpperCase()
}

/** A single printable character that is not a letter — a digit or a symbol,
 *  whose character already says whether Shift was down. */
function isSymbol(key: string): boolean {
  return key.length === 1 && !isLetter(key)
}

function format(chord: Chord): string {
  const parts: string[] = []
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift && !isSymbol(chord.key)) parts.push('Shift')
  if (chord.win) parts.push('Win')
  parts.push(chord.key)
  return parts.join('+')
}

function normalizeKey(key: string): string | null {
  if (key === ' ' || key.toLowerCase() === 'space' || key === 'Spacebar') return 'Space'
  if (key === 'Esc') return 'Escape'
  if (key.length === 1) return isLetter(key) ? key.toUpperCase() : key
  return NAMED_BY_LOWER.get(key.toLowerCase()) ?? null
}

function parse(text: string): Chord | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // `+` is both the separator and a key, so a chord ending in it is split by
  // hand: `Ctrl++` is Ctrl and the plus key.
  let prefix: string
  let rawKey: string
  if (trimmed === '+') {
    prefix = ''
    rawKey = '+'
  } else if (trimmed.endsWith('++')) {
    prefix = trimmed.slice(0, -2)
    rawKey = '+'
  } else {
    const at = trimmed.lastIndexOf('+')
    prefix = at < 0 ? '' : trimmed.slice(0, at)
    rawKey = at < 0 ? trimmed : trimmed.slice(at + 1)
  }
  const key = normalizeKey(rawKey)
  if (!key) return null
  const chord: Chord = { ctrl: false, alt: false, shift: false, win: false, key }
  for (const part of prefix ? prefix.split('+') : []) {
    switch (part.trim().toLowerCase()) {
      case 'ctrl':
      case 'control':
        chord.ctrl = true
        break
      case 'alt':
        chord.alt = true
        break
      case 'shift':
        chord.shift = true
        break
      case 'win':
      case 'meta':
      case 'super':
      case 'cmd':
        chord.win = true
        break
      default:
        return null
    }
  }
  return chord
}

/** The canonical spelling of a chord, or null if it is not one. */
export function normalizeChord(text: string): string | null {
  const chord = parse(text)
  return chord ? format(chord) : null
}

/** The chord a keydown makes, or null for a lone modifier or a dead key. */
export function chordFromEvent(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): string | null {
  if (NOT_A_KEY.has(e.key)) return null
  const key = normalizeKey(e.key)
  if (!key) return null
  return format({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, win: e.metaKey, key })
}

export function bindingsFor(overrides: Keybindings | undefined, id: ActionId): readonly string[] {
  return overrides?.[id] ?? ACTION_BY_ID[id].defaults
}

/** The action in `scope` that this keydown is bound to, if any. */
export function actionForEvent(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
  overrides: Keybindings | undefined,
  scope: ShortcutScope,
): ActionId | null {
  const chord = chordFromEvent(e)
  if (!chord) return null
  for (const action of SHORTCUT_ACTIONS) {
    if (action.scope === scope && bindingsFor(overrides, action.id).includes(chord)) return action.id
  }
  return null
}

/** `label (Ctrl+Shift+T)`, or the label alone when the action is unbound —
 *  for tooltips, which should never advertise a key that does nothing. */
export function withShortcut(label: string, overrides: Keybindings | undefined, id: ActionId): string {
  const first = bindingsFor(overrides, id)[0]
  return first ? `${label} (${first})` : label
}

/** Every chord bound to more than one action, with the actions sharing it.
 *  Both scopes count against each other: a window binding is handled before
 *  the pane ever sees the key, so a pane action sharing its chord is dead. */
export function findConflicts(overrides: Keybindings | undefined): Map<string, ActionId[]> {
  const byChord = new Map<string, ActionId[]>()
  for (const action of SHORTCUT_ACTIONS) {
    for (const chord of bindingsFor(overrides, action.id)) {
      byChord.set(chord, [...(byChord.get(chord) ?? []), action.id])
    }
  }
  for (const [chord, ids] of byChord) if (ids.length < 2) byChord.delete(chord)
  return byChord
}

/** Why a chord cannot be bound at all, or null if it can. */
export function chordProblem(chord: string): string | null {
  const parsed = parse(chord)
  if (!parsed) return 'Not a key this can bind.'
  // Never claimable: closing search and every dialog runs through Escape, and
  // it has to keep reaching the engine or vim stops working.
  if (parsed.key === 'Escape') return 'Escape has to reach the program in the pane.'
  const functionKey = /^F\d+$/.test(parsed.key)
  if (!parsed.ctrl && !parsed.alt && !parsed.win && !functionKey && parsed.key !== 'Insert') {
    return 'Needs Ctrl, Alt or Win — on its own this key is typing.'
  }
  return null
}

/** A chord that can be bound but costs something worth knowing. */
export function chordWarning(chord: string): string | null {
  const parsed = parse(chord)
  if (!parsed) return null
  // Ctrl+letter is a control character, and the shells' own: Ctrl+C is
  // interrupt, Ctrl+W deletes a word, Ctrl+R searches history. Binding one
  // takes it from every program in every pane.
  if (parsed.ctrl && !parsed.alt && !parsed.shift && !parsed.win && isLetter(parsed.key)) {
    return `Ctrl+${parsed.key} is a control character programs use; it will no longer reach them.`
  }
  return null
}

/** Keeps only overrides that name a real action and chords that parse and
 *  are bindable, each in canonical form and without duplicates. A settings
 *  blob is a file anyone can edit, and a malformed chord would not be a bad
 *  shortcut, it would be one that silently never matches. */
export function sanitizeKeybindings(value: unknown): Keybindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Keybindings = {}
  for (const action of SHORTCUT_ACTIONS) {
    const list = (value as Record<string, unknown>)[action.id]
    if (!Array.isArray(list)) continue
    const chords = list
      .map((c) => (typeof c === 'string' ? normalizeChord(c) : null))
      .filter((c): c is string => c !== null && chordProblem(c) === null)
    out[action.id] = [...new Set(chords)]
  }
  return out
}

/** Set while Settings is waiting for a key to bind. Both key handlers check it
 *  and stand aside, since the window-level one runs first and would otherwise
 *  act on the very chord being recorded — opening a tab instead of binding
 *  Ctrl+Shift+T. */
let recording = false

export function setRecordingShortcut(on: boolean) {
  recording = on
}

export function isRecordingShortcut(): boolean {
  return recording
}
