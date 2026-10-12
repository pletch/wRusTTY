/**
 * Recent-command autocomplete: what to offer, when, and what a keystroke means
 * while it is showing (docs/AUTOCOMPLETE_PLAN.md, Phase 4). Sits between
 * `PromptInputTracker` (what is typed, read off the grid) and the store (what
 * has been run before). Not React-aware, so the rules are testable.
 */

import {
  tooShortToInfer,
  type Cell,
  type PromptInput,
  type PromptInputTracker,
} from './promptInput'

/** What a key does while a suggestion is showing. */
export type SuggestionKeyAction =
  | 'accept'
  | 'accept-word'
  | 'next'
  | 'previous'
  | 'dismiss'
  | 'expand'
  | 'forget'
  | 'ignore'

/**
 * How the offer is shown. `inline` (the default) is dim text in the empty
 * cells after the cursor: it can't cover the line, overflow the pane, or need
 * navigation keys. `list` opens the same offer out on Ctrl+Space, like
 * PSReadLine's F2.
 */
export type SuggestionMode = 'inline' | 'list'

/**
 * Decide what a keystroke means. `ignore` leaves the key to the remote.
 *
 *   - **Tab is never taken**: it's the shell's own completion. Pressing it
 *     disarms the offer.
 *   - **Right arrow** accepts, only at the end of the line (fish/zsh
 *     autosuggestion binding).
 *   - **Alt+Right** accepts one word, also only at the end of the line.
 *   - **Up/Down belong to the shell** except in list mode, which exists only
 *     because the user summoned it; there they move the selection.
 *     **Ctrl+Up/Down** do the same, since Ctrl is often still held from
 *     Ctrl+Space.
 *   - **Ctrl+Space** opens the list.
 *   - **Enter**, in the list only, accepts without running (like fish's pager
 *     and zsh's `menu-select`). Inline, Enter always runs the line.
 *   - **Escape** dismisses and isn't forwarded.
 *   - **Shift+Delete** forgets the highlighted suggestion (deleted and blocked
 *     until allowed again in Settings), the browser/Windows binding. bash and
 *     zsh don't bind `CSI 3;2~` by default.
 *
 * Any other modifier combination is left alone.
 */
export function suggestionKeyAction(
  e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean },
  opts: { open: boolean; atLineEnd: boolean; mode: SuggestionMode },
): SuggestionKeyAction {
  if (!opts.open) return 'ignore'
  // Modified navigation first.
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    if (e.key === ' ' || e.key === 'Spacebar') return 'expand'
    // Likely still held from Ctrl+Space; list mode only.
    if (opts.mode === 'list' && e.key === 'ArrowDown') return 'next'
    if (opts.mode === 'list' && e.key === 'ArrowUp') return 'previous'
    return 'ignore'
  }
  // Alt is the word-wise modifier.
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (e.key === 'ArrowRight') return opts.atLineEnd ? 'accept-word' : 'ignore'
    return 'ignore'
  }
  if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return e.key === 'Delete' ? 'forget' : 'ignore'
  }
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return 'ignore'
  switch (e.key) {
    // Tab deliberately has no case: it belongs to the remote.
    case 'ArrowRight':
      return opts.atLineEnd ? 'accept' : 'ignore'
    // List mode only; inline these stay the shell's history keys.
    case 'ArrowDown':
      return opts.mode === 'list' ? 'next' : 'ignore'
    case 'ArrowUp':
      return opts.mode === 'list' ? 'previous' : 'ignore'
    // Confirms the highlighted row without running it; list mode only.
    case 'Enter':
      return opts.mode === 'list' ? 'accept' : 'ignore'
    case 'Escape':
      return 'dismiss'
    default:
      return 'ignore'
  }
}

/** Where the suggestion list should sit, in CSS pixels within the pane. */
export interface SuggestionPlacement {
  /** Distance from the top of the grid to the element's top edge. */
  top: number
  /** True when the list hangs below the line; false when it sits above, shifted
   * up by its own height. */
  below: boolean
  /** How tall it may grow before scrolling internally. */
  maxHeight: number
}

/**
 * Decide which side of the typed line the list goes on, or null when the line
 * is scrolled out of view.
 *
 * Doesn't use the list's own height (a list row is taller than a terminal row,
 * so counting items as cells misjudged the fit and covered the line). It picks
 * the side with more room; when above, it anchors to the cursor row and
 * shifts up by its own height in CSS (`translateY(-100%)`).
 */
export function placeSuggestions(opts: {
  /** The row the cursor is on, in absolute buffer coordinates. */
  cursorRow: number
  /** Absolute row currently at the top of the viewport. */
  viewportY: number
  /** Rows on screen. */
  rows: number
  /** Cell height in CSS pixels. */
  cellHeight: number
}): SuggestionPlacement | null {
  const screenRow = opts.cursorRow - opts.viewportY
  if (screenRow < 0 || screenRow >= opts.rows) return null

  const spaceBelow = opts.rows - screenRow - 1
  const spaceAbove = screenRow
  const below = spaceBelow >= spaceAbove
  return {
    below,
    top: (below ? screenRow + 1 : screenRow) * opts.cellHeight,
    // At least one row, so a tiny pane gets a scrolling sliver.
    maxHeight: Math.max(1, below ? spaceBelow : spaceAbove) * opts.cellHeight,
  }
}

/** What the pane renders. Null when nothing should be on screen. */
export interface SuggestionView {
  /** Best first; never empty. */
  items: string[]
  /** Which one Right-arrow would take. */
  index: number
  /** The text these complete, so a stale view can be recognized. */
  typed: string
  /** Where the input starts, in absolute buffer coordinates; the list anchors
   * here so it doesn't slide with every character typed. */
  origin: Cell
  /** The cursor: the row for a wrapped line, the column for inline text. */
  cursor: Cell
  /** Inline dim text, or the list opened out. */
  mode: SuggestionMode
}

/** The untyped part of the highlighted suggestion: shown inline, and sent on
 * accept. */
export function suggestionSuffix(view: SuggestionView): string {
  const command = view.items[view.index] ?? ''
  return command.startsWith(view.typed) ? command.slice(view.typed.length) : ''
}

/**
 * The first word of a suffix, for Alt+Right: leading whitespace plus the next
 * run of non-space. Whitespace-delimited (not readline's `forward-word`, which
 * stops at every `/`), since arguments are what users change their minds
 * about. Returns the whole suffix if it has no boundary.
 */
export function firstWordOfSuffix(suffix: string): string {
  const match = /^\s*\S+/.exec(suffix)
  return match ? match[0] : suffix
}

/** How many to offer. */
const MAX_SUGGESTIONS = 5

export interface AutocompleteDeps {
  tracker: PromptInputTracker
  /** Queries the store; rejects mean "no suggestions". */
  suggest: (typed: string, limit: number) => Promise<string[]>
  /** Send bytes to the far end, as if typed. */
  send: (text: string) => void
  /** Tell the store a suggestion was taken. Best-effort. */
  noteAccepted: (command: string) => void
  /** Delete a command from the store and block it; see `forget`. */
  forget: (command: string) => Promise<void>
  /** Whether the feature is on; read per call since it can change. */
  enabled: () => boolean
  onChange: (view: SuggestionView | null) => void
}

/**
 * Owns the suggestion on offer for one pane: on a keystroke or write, re-read
 * the prompt line, ask the store if it changed, and publish a view.
 */
export class AutocompleteController {
  private readonly deps: AutocompleteDeps
  private view: SuggestionView | null = null
  /** Drops out-of-order replies; the store is an IPC round trip away. */
  private queryId = 0
  /** The line last asked about, so an unchanged line isn't re-queried. */
  private lastQueried: string | null = null
  /**
   * Whether the line's contents got there by typing. Gates opening an offer, so
   * a history recall (which redraws the line) doesn't summon one. Set by a
   * printable keystroke, cleared by anything else.
   */
  private typedSinceRedraw = false

  constructor(deps: AutocompleteDeps) {
    this.deps = deps
  }

  get current(): SuggestionView | null {
    return this.view
  }

  /** Whether the cursor is at the end of the line (gates Right-arrow accept). */
  private atLineEnd(): boolean {
    return this.deps.tracker.read()?.atEnd ?? false
  }

  /** Open the inline suggestion into the list. */
  expand(): void {
    if (!this.view || this.view.mode === 'list') return
    this.publish({ ...this.view, mode: 'list' })
  }

  /**
   * The user pressed a key. Printable input arms the offer; anything else
   * (arrows, Home, `^R`) disarms it, so recalled history isn't completed.
   */
  noteInput(data: Uint8Array): void {
    let printable = false
    for (const byte of data) {
      // Printable ASCII or UTF-8 bytes; escape sequences start with 0x1b.
      if (byte >= 0x20 && byte !== 0x7f) printable = true
      else return this.disarm()
    }
    if (printable) this.typedSinceRedraw = true
  }

  private disarm(): void {
    this.typedSinceRedraw = false
    this.clear()
  }

  /** Re-read the line and update the offer. Cheap when nothing changed. */
  refresh(): void {
    if (!this.deps.enabled()) return this.clear()
    const input = this.deps.tracker.read()
    if (!this.shouldOffer(input)) return this.clear()
    const typed = input!.text
    if (typed === this.lastQueried) return
    // Not typed (a recall, Tab completion or redraw): remember the line but
    // offer nothing.
    if (!this.typedSinceRedraw) {
      this.lastQueried = typed
      return this.hide()
    }
    this.lastQueried = typed

    const id = ++this.queryId
    this.deps
      .suggest(typed, MAX_SUGGESTIONS)
      .then((items) => {
        // A late reply for a line the user has moved past.
        if (id !== this.queryId) return
        const still = this.deps.tracker.read()
        if (!this.shouldOffer(still) || still!.text !== typed) return this.clear()
        if (items.length === 0) return this.clear()
        this.publish({
          items,
          index: 0,
          typed,
          origin: still!.origin,
          cursor: still!.cursor,
          // Every new offer starts inline.
          mode: 'inline',
        })
      })
      .catch(() => {
        // No backend (`npm run dev`) or the store failed: go quiet.
        if (id === this.queryId) this.clear()
      })
  }

  /**
   * Whether to complete this input. Requires the cursor at the end (accepting
   * appends). For an inferred origin, short input is skipped so a `[Y/n]` answer
   * doesn't summon suggestions; see `tooShortToInfer`.
   */
  private shouldOffer(input: PromptInput | null): input is PromptInput {
    if (input === null || !input.atEnd || input.text.trim() === '') return false
    if (!this.deps.tracker.exact && tooShortToInfer(input.text)) return false
    return true
  }

  move(delta: number): void {
    if (!this.view) return
    const count = this.view.items.length
    // Wraps around.
    const index = (((this.view.index + delta) % count) + count) % count
    this.publish({ ...this.view, index })
  }

  /**
   * Take the current suggestion. Re-reads the grid first and sends nothing if
   * the screen no longer has the typed text as a prefix (output redrew the line,
   * or the origin was wrong). Only ever appends the suffix.
   */
  accept(): void {
    this.take(false)
  }

  /**
   * Take only the first word. Not recorded as an acceptance. The offer is
   * dropped; once the far end echoes the word, `refresh` offers the rest again,
   * which is how a second Alt+Right takes the next word.
   */
  acceptWord(): void {
    this.take(true)
  }

  private take(wordOnly: boolean): void {
    const view = this.view
    if (!view) return
    const command = view.items[view.index]
    const input = this.deps.tracker.read()
    this.clear()
    if (!this.shouldOffer(input)) return
    if (!command.startsWith(input.text)) return
    const suffix = command.slice(input.text.length)
    if (suffix === '') return
    const text = wordOnly ? firstWordOfSuffix(suffix) : suffix
    this.deps.send(text)
    // A word that was the whole remainder counts as a full accept; otherwise
    // leave `lastQueried` null so the echo re-offers.
    if (text !== suffix) return
    this.deps.noteAccepted(command)
    // The line now holds the full command; don't re-offer on the echo.
    this.lastQueried = command
  }

  /**
   * Delete the highlighted suggestion from the store (which also blocks it) and
   * offer what's left. It disappears immediately; once the delete settles the
   * store is asked again, backfilling the list (and showing the entry again if
   * the delete failed). Mode and position are kept.
   */
  forget(): void {
    const view = this.view
    if (!view) return
    const command = view.items[view.index]
    const items = view.items.filter((_, i) => i !== view.index)
    if (items.length === 0) this.hide()
    else this.publish({ ...view, items, index: Math.min(view.index, items.length - 1) })

    const id = ++this.queryId
    const refill = () => {
      if (id !== this.queryId) return
      this.deps
        .suggest(view.typed, MAX_SUGGESTIONS)
        .then((found) => {
          if (id !== this.queryId) return
          const still = this.deps.tracker.read()
          if (!this.shouldOffer(still) || still.text !== view.typed) return this.clear()
          if (found.length === 0) return this.hide()
          const index = Math.min(this.view?.index ?? view.index, found.length - 1)
          this.publish({ ...view, items: found, index, origin: still.origin, cursor: still.cursor })
        })
        .catch(() => {
          if (id === this.queryId) this.clear()
        })
    }
    this.deps.forget(command).then(refill, refill)
  }

  /** Handle a keystroke; returns whether it was consumed. */
  handleKey(e: {
    key: string
    ctrlKey: boolean
    altKey: boolean
    metaKey: boolean
    shiftKey: boolean
  }): boolean {
    const action = suggestionKeyAction(e, {
      open: this.view !== null,
      atLineEnd: this.atLineEnd(),
      mode: this.view?.mode ?? 'inline',
    })
    switch (action) {
      case 'accept':
        this.accept()
        return true
      case 'accept-word':
        this.acceptWord()
        return true
      case 'next':
        this.move(1)
        return true
      case 'previous':
        this.move(-1)
        return true
      case 'expand':
        this.expand()
        return true
      case 'forget':
        this.forget()
        return true
      case 'dismiss':
        this.clear()
        return true
      case 'ignore':
        return false
    }
  }

  /** Drop the offer and forget the last query, so the same line can be offered
   * again after a dismiss. */
  clear(): void {
    this.lastQueried = null
    this.hide()
  }

  /** Take the list off screen but remember the last query, so an untyped line
   * isn't re-queried on every write. */
  private hide(): void {
    if (this.view !== null) this.publish(null)
  }

  /** A line ended (Enter, `^C`). */
  reset(): void {
    this.queryId++
    this.typedSinceRedraw = false
    this.clear()
  }

  private publish(view: SuggestionView | null): void {
    this.view = view
    this.deps.onChange(view)
  }
}
