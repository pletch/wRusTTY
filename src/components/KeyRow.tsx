import { useEffect, useRef, useSyncExternalStore } from 'react'
import { TERMINAL_INPUT_LABEL } from '../lib/ghostty/GhosttyInputHandler'
import {
  softModifiers,
  subscribeSoftModifiers,
  toggleSoftModifier,
  type SoftModifiers,
} from '../lib/softModifiers'

/** How long a held arrow waits before repeating, and how fast it then does. */
const REPEAT_DELAY_MS = 400
const REPEAT_EVERY_MS = 60

type RowKey =
  | { label: string; aria: string; modifier: keyof SoftModifiers }
  | { label: string; aria: string; key: string; repeats?: boolean }
  | { label: string; aria: string; text: string }

const KEYS: RowKey[] = [
  { label: 'Esc', aria: 'Escape', key: 'Escape' },
  { label: 'Tab', aria: 'Tab', key: 'Tab' },
  { label: 'Ctrl', aria: 'Control', modifier: 'ctrl' },
  { label: 'Alt', aria: 'Alt', modifier: 'alt' },
  { label: '←', aria: 'Left arrow', key: 'ArrowLeft', repeats: true },
  { label: '↓', aria: 'Down arrow', key: 'ArrowDown', repeats: true },
  { label: '↑', aria: 'Up arrow', key: 'ArrowUp', repeats: true },
  { label: '→', aria: 'Right arrow', key: 'ArrowRight', repeats: true },
  { label: '|', aria: 'Pipe', text: '|' },
  { label: '~', aria: 'Tilde', text: '~' },
  { label: '/', aria: 'Slash', text: '/' },
  { label: '-', aria: 'Dash', text: '-' },
]

type Field = HTMLInputElement | HTMLTextAreaElement

function isTerminal(el: Element | null): boolean {
  return el?.getAttribute('aria-label') === TERMINAL_INPUT_LABEL
}

/** The form field with focus, leaving out the terminal's own hidden input. */
function focusedField(): Field | null {
  const el = document.activeElement
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return null
  return isTerminal(el) ? null : el
}

/** Returns whether something handled it. A synthetic event has no default action,
 * so a canceled one is the only sign anything did. */
function dispatchKey(type: 'keydown' | 'keyup', key: string, repeat = false): boolean {
  const target = document.activeElement ?? document.body
  return !target.dispatchEvent(
    new KeyboardEvent(type, { key, code: key, repeat, bubbles: true, cancelable: true }),
  )
}

/** Types at the caret. React sees this as ordinary typing: `setRangeText` skips the
 * `value` setter it watches, so the `input` event reports a change. */
function insertIntoField(field: Field, text: string) {
  try {
    const start = field.selectionStart ?? field.value.length
    const end = field.selectionEnd ?? start
    field.setRangeText(text, start, end, 'end')
  } catch {
    return // A type without a caret, like `number`.
  }
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function moveCaret(field: Field, by: number) {
  try {
    const at = field.selectionStart ?? field.value.length
    const next = Math.max(0, Math.min(field.value.length, at + by))
    field.setSelectionRange(next, next)
  } catch {
    // Likewise.
  }
}

/** Tab, among the fields sharing this one's form or dialog. */
function focusNextField(field: Field) {
  const scope = field.closest('form, [data-modal]') ?? document.body
  const fields = [
    ...scope.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
    ),
  ].filter((el) => !isTerminal(el) && el.tabIndex !== -1)
  if (fields.length < 2) return
  fields[(fields.indexOf(field) + 1) % fields.length].focus()
}

/** What a key does in a form field, where a synthetic event wouldn't do it. */
function applyToField(field: Field, key: string) {
  if (key === 'ArrowLeft') moveCaret(field, -1)
  else if (key === 'ArrowRight') moveCaret(field, 1)
  else if (key === 'Tab') focusNextField(field)
}

/**
 * The keys a phone keyboard lacks, on Android. In the terminal, events go to it as if
 * a keyboard sent them, so the encoder and the app's modes treat them like physical
 * keys. In a dialog's field they do what they would there, and Esc still reaches
 * whatever listens for it. A press never takes focus, which would close the keyboard.
 */
export function KeyRow({ background }: { background?: string }) {
  const mods = useSyncExternalStore(subscribeSoftModifiers, softModifiers)
  const repeat = useRef<{ timer: number; key: string } | null>(null)

  const stopRepeat = () => {
    if (!repeat.current) return
    window.clearTimeout(repeat.current.timer)
    dispatchKey('keyup', repeat.current.key)
    repeat.current = null
  }
  useEffect(() => stopRepeat, [])

  const press = (k: RowKey) => {
    if ('modifier' in k) {
      // Only the terminal consumes these. Armed from a dialog, one would wait there
      // and land on the next thing typed in the terminal.
      if (isTerminal(document.activeElement)) toggleSoftModifier(k.modifier)
    } else if ('text' in k) {
      const field = focusedField()
      if (field) {
        insertIntoField(field, k.text)
      } else if (isTerminal(document.activeElement)) {
        document.activeElement!.dispatchEvent(
          new InputEvent('input', { data: k.text, inputType: 'insertText', bubbles: true }),
        )
      }
    } else {
      stopRepeat()
      const send = (repeating: boolean) => {
        const handled = dispatchKey('keydown', k.key, repeating)
        const field = focusedField()
        if (field && !handled) applyToField(field, k.key)
      }
      send(false)
      const tick = () => {
        send(true)
        if (repeat.current) repeat.current.timer = window.setTimeout(tick, REPEAT_EVERY_MS)
      }
      // Non-repeating keys still get a release, on letting go, for Kitty.
      repeat.current = {
        key: k.key,
        timer: k.repeats ? window.setTimeout(tick, REPEAT_DELAY_MS) : 0,
      }
    }
  }

  return (
    // Above every dialog's overlay, which would otherwise cover it. `data-modal` so a
    // tap here isn't a click away from an open menu (see useDismissable).
    <div
      data-modal
      className="relative z-[80] flex h-10 shrink-0 select-none items-stretch border-t border-chrome/10"
      style={{ background }}
    >
      {KEYS.map((k) => {
        const armed = 'modifier' in k && mods[k.modifier]
        return (
          <button
            key={k.aria}
            type="button"
            tabIndex={-1}
            aria-label={k.aria}
            aria-pressed={'modifier' in k ? armed : undefined}
            // A single glyph reads smaller than a word at the same size.
            className={`min-w-0 flex-1 touch-manipulation ${
              k.label.length === 1 ? 'text-lg leading-none' : 'text-xs'
            } ${
              armed ? 'bg-sky-400/30 text-chrome' : 'text-chrome/70 active:bg-chrome/20'
            }`}
            onPointerDown={(e) => {
              e.preventDefault()
              press(k)
            }}
            onPointerUp={stopRepeat}
            onPointerCancel={stopRepeat}
            onPointerLeave={stopRepeat}
            // The press above doesn't stop the mouse events a tap synthesizes, and
            // this one would move focus.
            onMouseDown={(e) => e.preventDefault()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {k.label}
          </button>
        )
      })}
    </div>
  )
}
