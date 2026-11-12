import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { tapHaptic } from '../lib/keepAlive'
import { TERMINAL_INPUT_LABEL } from '../lib/ghostty/GhosttyInputHandler'
import {
  softModifierLocks,
  softModifiers,
  subscribeSoftModifiers,
  tapSoftModifier,
  type SoftModifiers,
} from '../lib/softModifiers'

/** How long a held arrow waits before repeating, and how fast it then does. */
const REPEAT_DELAY_MS = 400
const REPEAT_EVERY_MS = 60

/** A press waits this long to see whether it's the start of a swipe. Lifting sooner
 * fires it at once, so only a hold notices the wait. */
const COMMIT_MS = 150
/** How far sideways a finger travels before the press becomes a swipe. Let go past
 * it and the row turns a page; back inside it, and the row returns. */
const SWIPE_PX = 20
/** How long the row takes to finish sliding once the finger lifts. */
const SLIDE_MS = 180

/** The track holds the page before, this one and the next, side by side. This places
 * page `by` from the middle in view, dragged `px` along. */
function trackOffset(by: number, px = 0) {
  return `translateX(calc(${((-1 - by) * 100) / 3}% + ${px}px))`
}

function reducedMotion() {
  return (
    typeof window.matchMedia !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

type RowKey =
  | { label: string; aria: string; modifier: keyof SoftModifiers }
  | { label: string; aria: string; key: string; repeats?: boolean; code?: string; ctrl?: boolean }
  | { label: string; aria: string; text: string }

const MAIN_KEYS: RowKey[] = [
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

const NAVIGATION_KEYS: RowKey[] = [
  { label: 'Home', aria: 'Home', key: 'Home' },
  { label: 'End', aria: 'End', key: 'End' },
  { label: 'PgUp', aria: 'Page up', key: 'PageUp', repeats: true },
  { label: 'PgDn', aria: 'Page down', key: 'PageDown', repeats: true },
  { label: 'Del', aria: 'Delete', key: 'Delete', repeats: true },
  { label: '^C', aria: 'Control C', key: 'c', code: 'KeyC', ctrl: true },
  { label: '^D', aria: 'Control D', key: 'd', code: 'KeyD', ctrl: true },
  { label: '_', aria: 'Underscore', text: '_' },
  { label: '\\', aria: 'Backslash', text: '\\' },
  { label: '&', aria: 'Ampersand', text: '&' },
]

const FUNCTION_KEYS: RowKey[] = Array.from({ length: 12 }, (_, i) => ({
  label: `F${i + 1}`,
  aria: `F${i + 1}`,
  key: `F${i + 1}`,
}))

const PAGES = [MAIN_KEYS, NAVIGATION_KEYS, FUNCTION_KEYS]

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
function dispatchKey(
  type: 'keydown' | 'keyup',
  k: { key: string; code?: string; ctrl?: boolean },
  repeat = false,
): boolean {
  const target = document.activeElement ?? document.body
  return !target.dispatchEvent(
    new KeyboardEvent(type, {
      key: k.key,
      code: k.code ?? k.key,
      ctrlKey: k.ctrl === true,
      repeat,
      bubbles: true,
      cancelable: true,
    }),
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
 *
 * Swiping sideways moves between pages: the row follows the finger, then slides the
 * rest of the way to a whole page on letting go. Since a swipe starts as a press, a
 * key fires when the finger lifts, or once it has stayed put for `COMMIT_MS`, never
 * on landing.
 */
export function KeyRow({ background, haptics }: { background?: string; haptics?: boolean }) {
  const mods = useSyncExternalStore(subscribeSoftModifiers, softModifiers)
  const locks = useSyncExternalStore(subscribeSoftModifiers, softModifierLocks)
  const [page, setPage] = useState(0)
  const repeat = useRef<{
    timer: number
    key: { key: string; code?: string; ctrl?: boolean }
  } | null>(null)

  const stopRepeat = () => {
    if (!repeat.current) return
    window.clearTimeout(repeat.current.timer)
    dispatchKey('keyup', repeat.current.key)
    repeat.current = null
  }
  useEffect(() => stopRepeat, [])

  /** The finger on the row: where it landed, and whether it has become a key press
   * or a swipe yet. */
  const gesture = useRef<{
    pointerId: number
    x: number
    y: number
    key: RowKey
    commitTimer: number
    state: 'pending' | 'committed' | 'swiped' | 'dropped'
  } | null>(null)

  const endGesture = () => {
    const g = gesture.current
    if (!g) return
    window.clearTimeout(g.commitTimer)
    if (g.state === 'committed') stopRepeat()
    gesture.current = null
  }
  useEffect(() => endGesture, [])

  const commit = () => {
    const g = gesture.current
    if (!g || g.state !== 'pending') return
    window.clearTimeout(g.commitTimer)
    g.state = 'committed'
    press(g.key)
  }

  const track = useRef<HTMLDivElement>(null)
  /** Set while the row slides to rest, when a press would land on a moving key. */
  const slide = useRef<number | null>(null)

  const placeTrack = (transform: string, animate: boolean) => {
    const el = track.current
    if (!el) return
    el.style.transition = animate ? `transform ${SLIDE_MS}ms ease-out` : 'none'
    el.style.transform = transform
  }

  // The new page is now the middle one; recenter before it paints.
  useLayoutEffect(() => placeTrack(trackOffset(0), false), [page])
  useEffect(
    () => () => {
      if (slide.current != null) window.clearTimeout(slide.current)
    },
    [],
  )

  /** Slides from wherever the finger left the row to page `by` from this one. */
  const settle = (by: number) => {
    if (by !== 0 && haptics) tapHaptic()
    const done = () => {
      slide.current = null
      if (by === 0) placeTrack(trackOffset(0), false)
      else setPage((p) => (p + by + PAGES.length) % PAGES.length)
    }
    if (reducedMotion()) return done()
    placeTrack(trackOffset(by), true)
    slide.current = window.setTimeout(done, SLIDE_MS)
  }

  const press = (k: RowKey) => {
    if (haptics) tapHaptic()
    if ('modifier' in k) {
      // Only the terminal consumes these. Armed from a dialog, one would wait there
      // and land on the next thing typed in the terminal.
      if (isTerminal(document.activeElement)) tapSoftModifier(k.modifier)
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
        const handled = dispatchKey('keydown', k, repeating)
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
        key: k,
        timer: k.repeats ? window.setTimeout(tick, REPEAT_DELAY_MS) : 0,
      }
    }
  }

  return (
    // Above every dialog's overlay, which would otherwise cover it. `data-modal` so a
    // tap here isn't a click away from an open menu (see useDismissable).
    // `touch-none` so the WebView leaves the sideways drag to us instead of canceling
    // the pointer to scroll.
    <div
      data-modal
      className="relative z-[80] h-10 shrink-0 touch-none select-none overflow-hidden border-t border-chrome/10"
      style={{ background }}
      onPointerDown={(e) => {
        e.preventDefault()
        if (slide.current != null) return
        const index = (e.target as Element)
          .closest?.('[data-key-index]')
          ?.getAttribute('data-key-index')
        const key = index == null ? undefined : PAGES[page][Number(index)]
        if (!key) return
        // A new finger takes over, as on a keyboard, and clears one whose lift was lost.
        endGesture()
        // So the move and the lift still come here once the finger leaves the key.
        try {
          e.currentTarget.setPointerCapture?.(e.pointerId)
        } catch {
          // Not a live pointer, as in tests.
        }
        gesture.current = {
          pointerId: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          key,
          commitTimer: window.setTimeout(commit, COMMIT_MS),
          state: 'pending',
        }
      }}
      onPointerMove={(e) => {
        const g = gesture.current
        if (!g || g.pointerId !== e.pointerId) return
        const dx = e.clientX - g.x
        const dy = e.clientY - g.y
        if (g.state === 'swiped') {
          const width = e.currentTarget.clientWidth || Infinity
          placeTrack(trackOffset(0, Math.max(-width, Math.min(width, dx))), false)
        } else if (g.state !== 'pending') {
          return
        } else if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
          window.clearTimeout(g.commitTimer)
          g.state = 'swiped'
          placeTrack(trackOffset(0, dx), false)
        } else if (Math.abs(dy) >= SWIPE_PX) {
          // Off the row upward or down: a press abandoned, like sliding off a key.
          window.clearTimeout(g.commitTimer)
          g.state = 'dropped'
        }
      }}
      onPointerUp={(e) => {
        const g = gesture.current
        if (g?.pointerId !== e.pointerId) return
        if (g.state === 'swiped') {
          const dx = e.clientX - g.x
          // Swiping left brings in the page to the right, as on a home screen. One
          // page however far, and none if the finger came back.
          settle(Math.abs(dx) < SWIPE_PX ? 0 : dx < 0 ? 1 : -1)
        }
        commit() // A tap lifted before its wait ran out.
        endGesture()
      }}
      onPointerCancel={(e) => {
        const g = gesture.current
        if (g?.pointerId !== e.pointerId) return
        if (g.state === 'swiped') settle(0)
        endGesture()
      }}
    >
      <div ref={track} className="flex h-full w-[300%]" style={{ transform: trackOffset(0) }}>
        {[-1, 0, 1].map((by) => (
          // Only the middle page is live; the others are there to slide in.
          <div key={by} className="flex w-1/3 items-stretch" aria-hidden={by !== 0 || undefined}>
            {PAGES[(page + by + PAGES.length) % PAGES.length].map((k, i) =>
              renderKey(k, i, by === 0),
            )}
          </div>
        ))}
      </div>
      <div
        aria-hidden
        data-testid="key-pages"
        className="pointer-events-none absolute inset-x-0 bottom-0.5 flex justify-center gap-1"
      >
        {PAGES.map((_, i) => (
          <span
            key={i}
            data-current={i === page || undefined}
            className={`h-1 w-1 rounded-full ${i === page ? 'bg-chrome/60' : 'bg-chrome/20'}`}
          />
        ))}
      </div>
    </div>
  )

  function renderKey(k: RowKey, i: number, live: boolean) {
    const armed = 'modifier' in k && mods[k.modifier]
    const locked = 'modifier' in k && locks[k.modifier]
    return (
      <button
        key={k.aria}
        type="button"
        tabIndex={-1}
        data-key-index={live ? i : undefined}
        aria-label={live ? k.aria : undefined}
        aria-pressed={live && 'modifier' in k ? armed : undefined}
        // A single glyph reads smaller than a word at the same size.
        className={`min-w-0 flex-1 touch-manipulation ${
          k.label.length === 1 ? 'text-lg leading-none' : 'text-xs'
        } ${
          locked
            ? 'bg-sky-500 font-semibold text-white'
            : armed
              ? 'bg-sky-400/30 text-chrome'
              : 'text-chrome/70 active:bg-chrome/20'
        }`}
        // The row's pointerdown doesn't stop the mouse events a tap synthesizes,
        // and this one would move focus.
        onMouseDown={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {k.label}
      </button>
    )
  }
}
