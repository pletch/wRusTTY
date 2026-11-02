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

/** The focused terminal's input, or null when something else has focus. */
function terminalInput(): HTMLTextAreaElement | null {
  const el = document.activeElement
  return el instanceof HTMLTextAreaElement && el.getAttribute('aria-label') === TERMINAL_INPUT_LABEL
    ? el
    : null
}

function dispatchKey(type: 'keydown' | 'keyup', key: string, repeat = false) {
  terminalInput()?.dispatchEvent(
    new KeyboardEvent(type, { key, code: key, repeat, bubbles: true, cancelable: true }),
  )
}

/**
 * The keys a phone keyboard lacks, on Android. Events go to the focused terminal
 * as if a keyboard sent them, so the encoder and the app's modes treat them like
 * physical keys. A press never takes focus, which would close the keyboard.
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
      toggleSoftModifier(k.modifier)
    } else if ('text' in k) {
      terminalInput()?.dispatchEvent(
        new InputEvent('input', { data: k.text, inputType: 'insertText', bubbles: true }),
      )
    } else {
      stopRepeat()
      dispatchKey('keydown', k.key)
      const tick = () => {
        dispatchKey('keydown', k.key, true)
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
    <div
      className="flex h-10 shrink-0 select-none items-stretch border-t border-chrome/10"
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
            className={`min-w-0 flex-1 touch-manipulation text-xs ${
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
