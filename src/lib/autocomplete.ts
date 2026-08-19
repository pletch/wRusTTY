/**
 * Recent-command autocomplete: what to offer, when to offer it, and what a
 * keystroke means while it is showing.
 *
 * Phase 4 of docs/AUTOCOMPLETE_PLAN.md. Sits between `PromptInputTracker`
 * (what is typed, read off the grid) and the store (what has been run before),
 * and owns the one thing neither of them can: the decision to put something on
 * screen in front of a terminal the user is working in.
 *
 * Deliberately not React-aware. The pane drives it from an effect and renders
 * whatever state it reports, so the rules below can be tested as rules.
 */

import type { Cell, PromptInput, PromptInputTracker } from './promptInput'

/** What a key does while a suggestion is showing. */
export type SuggestionKeyAction = 'accept' | 'next' | 'previous' | 'dismiss' | 'ignore'

/**
 * Decide what a keystroke means. `ignore` means the key belongs to the remote
 * and must be left completely alone.
 *
 * Every rule here is chosen to collide with nothing the far end reasonably
 * wants at a prompt, and each one is a decision rather than a convention:
 *
 *   - **Tab** is the remote's own completion key, which makes it both the most
 *     natural key for this and the most dangerous to take. It is claimed only
 *     while a suggestion is actually on screen; with nothing showing it passes
 *     straight through, so completing an unmatched prefix behaves exactly as
 *     it always has.
 *   - **Right arrow** accepts only at the end of the line, where it would
 *     otherwise be a no-op. In the middle of a line it is a cursor move the
 *     user meant.
 *   - **Up and Down are never claimed.** They always reach the remote shell,
 *     so its own history recall never breaks. An earlier version took them
 *     while a list was open, on the reasoning that the *first* Up on a closed
 *     list would still reach the shell — which was wrong twice over. Recalling
 *     a command redraws the line, which used to open a list, so the second Up
 *     was captured by a popup the first Up had just conjured; and even without
 *     that, a list opened by typing then swallowed the arrows of someone who
 *     had moved on to hunting through history. Walking history is the single
 *     most common thing done at a prompt, and a completion list has no
 *     business interrupting it.
 *   - **Ctrl+Up/Ctrl+Down** move through the list instead. No shell binds
 *     them, and they are only claimed while a list is actually showing.
 *   - **Escape** dismisses and sends nothing further. It is not forwarded,
 *     because the user is dismissing this, not talking to vim.
 *
 * Any modifier disqualifies everything: Ctrl+Tab, Alt+Up and friends are
 * bindings elsewhere or sequences the remote wants, and none of them mean
 * "take this suggestion".
 */
export function suggestionKeyAction(
  e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean },
  opts: { open: boolean; atLineEnd: boolean },
): SuggestionKeyAction {
  if (!opts.open) return 'ignore'
  // Navigation is the one thing that *wants* a modifier, so it is settled
  // before the unmodified keys below.
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    if (e.key === 'ArrowDown') return 'next'
    if (e.key === 'ArrowUp') return 'previous'
    return 'ignore'
  }
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return 'ignore'
  switch (e.key) {
    case 'Tab':
      return 'accept'
    case 'ArrowRight':
      return opts.atLineEnd ? 'accept' : 'ignore'
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
  /** True when the list hangs below the line; false when it sits above it and
   * is shifted up by its own height. */
  below: boolean
  /** How tall it may grow before scrolling internally. */
  maxHeight: number
}

/**
 * Decide which side of the typed line the list goes on.
 *
 * Returns null when the line is not on screen at all — scrolled out of view
 * while a suggestion was open, which leaves nothing to anchor to.
 *
 * **Nothing here multiplies by the list's own height**, and that is the whole
 * point. An earlier version decided by asking whether `items.length` *cells*
 * were free below the cursor, which is not the same question: a row of this
 * list is a cell of text plus padding plus a border, comfortably half again as
 * tall as a terminal row. With the prompt near the bottom of the pane it would
 * answer "fits below", decline to flip, and then spill back up over the very
 * line being typed — the case where the list matters most.
 *
 * So the side is chosen by which has more room, and the flipped case is
 * anchored to the cursor's own row and shifted up by its own height in CSS
 * (`translateY(-100%)`). Its bottom edge then lands exactly on the boundary of
 * the typed line however tall it turns out to be, with no measuring pass.
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
    // At least one row's worth, so a list on a two-row pane is a sliver that
    // scrolls rather than nothing at all.
    maxHeight: Math.max(1, below ? spaceBelow : spaceAbove) * opts.cellHeight,
  }
}

/** What the pane renders. Null when nothing should be on screen. */
export interface SuggestionView {
  /** Best first. Never empty — no suggestions means no view at all. */
  items: string[]
  /** Which one Tab would take. */
  index: number
  /** The text these complete, so a stale view can be recognised. */
  typed: string
  /** Where the input starts, in absolute buffer coordinates — what the popover
   * is anchored to. Anchored to the *origin* rather than the cursor so the
   * list does not slide sideways with every character typed. */
  origin: Cell
  /** The row the cursor is on, so the popover can sit under the line even
   * when it has wrapped. */
  cursorRow: number
}

/** How many to offer. Five is enough to be worth looking at and few enough to
 * read without taking the eye off the prompt; past that the list becomes a
 * menu, which is a different feature. */
const MAX_SUGGESTIONS = 5

export interface AutocompleteDeps {
  tracker: PromptInputTracker
  /** Queries the store. Rejects are treated as "no suggestions" — see
   * `refresh`. */
  suggest: (typed: string, limit: number) => Promise<string[]>
  /** Send bytes to the far end, as if typed. */
  send: (text: string) => void
  /** Tell the store a suggestion was taken. Best-effort. */
  noteAccepted: (command: string) => void
  /** Whether the feature is on right now. Read per call rather than captured,
   * because the setting can change while a pane is open. */
  enabled: () => boolean
  onChange: (view: SuggestionView | null) => void
}

/**
 * Owns the suggestion currently on offer for one pane.
 *
 * The flow is: something happened (a keystroke, a write) → re-read the prompt
 * line off the grid → if it changed, ask the store → publish a view. Every
 * step can decide there is nothing to show, and that is the common case.
 */
export class AutocompleteController {
  private readonly deps: AutocompleteDeps
  private view: SuggestionView | null = null
  /** Guards against an out-of-order reply overwriting a newer one: the store
   * is behind an IPC round trip, and the user keeps typing during it. */
  private queryId = 0
  /** What the last query asked about, so an unchanged line does not re-ask on
   * every parsed write. */
  private lastQueried: string | null = null
  /**
   * Whether the line's current contents got there by being typed.
   *
   * Gates *opening* a list, and it is the difference between a suggestion
   * appearing because you are writing a command and one appearing because the
   * far end redrew the line under you. Recalling a shell command with Up
   * rewrites the whole line, which reads exactly like a large amount of typing
   * from the grid's point of view — and a list that opens on it is a list
   * nobody asked for, sitting over the history someone is in the middle of
   * walking through.
   *
   * Set by a printable keystroke and cleared by anything else, so it follows
   * intent rather than content.
   */
  private typedSinceRedraw = false

  constructor(deps: AutocompleteDeps) {
    this.deps = deps
  }

  get current(): SuggestionView | null {
    return this.view
  }

  /** Whether the cursor is at the end of the line right now — the condition
   * Right-arrow acceptance is gated on. */
  private atLineEnd(): boolean {
    return this.deps.tracker.read()?.atEnd ?? false
  }

  /**
   * The user pressed a key. Printable input arms the offer; anything else —
   * an arrow, Home, `^R`, a function key — disarms it.
   *
   * The disarming half is what keeps a list from following someone through
   * their shell's history: Up is not typing, so whatever the recall puts on
   * the line is not something to complete.
   */
  noteInput(data: Uint8Array): void {
    let printable = false
    for (const byte of data) {
      // Printable ASCII, or any byte of a multi-byte UTF-8 character. An
      // escape sequence — every arrow, every editing key — starts with 0x1b
      // and is therefore not typing.
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
    // Not typing, so whatever put this on the line was the far end — a history
    // recall, a Tab completion, a redraw. Record what the line now says so a
    // later keystroke is compared against it, but offer nothing.
    if (!this.typedSinceRedraw) {
      this.lastQueried = typed
      return this.hide()
    }
    this.lastQueried = typed

    const id = ++this.queryId
    this.deps
      .suggest(typed, MAX_SUGGESTIONS)
      .then((items) => {
        // A reply for a line the user has already moved on from is not an
        // error, just late. Dropping it is the whole point of the id.
        if (id !== this.queryId) return
        const still = this.deps.tracker.read()
        if (!this.shouldOffer(still) || still!.text !== typed) return this.clear()
        if (items.length === 0) return this.clear()
        this.publish({
          items,
          index: 0,
          typed,
          origin: still!.origin,
          cursorRow: still!.cursor.row,
        })
      })
      .catch(() => {
        // No backend (a plain `npm run dev` browser), or the store failed to
        // load. Autocomplete going quiet is the right failure; a toast over a
        // terminal session is not.
        if (id === this.queryId) this.clear()
      })
  }

  /**
   * Whether this input is one to complete at all.
   *
   * `atEnd` is the load-bearing one: accepting appends, so offering while the
   * cursor sits mid-line would splice text into the middle of the command.
   */
  private shouldOffer(input: PromptInput | null): input is PromptInput {
    return input !== null && input.atEnd && input.text.trim() !== ''
  }

  move(delta: number): void {
    if (!this.view) return
    const count = this.view.items.length
    // Wraps, because a five-item list read with the keyboard is a ring — and
    // stopping at the end silently does nothing, which reads as a broken key.
    const index = (((this.view.index + delta) % count) + count) % count
    this.publish({ ...this.view, index })
  }

  /**
   * Take the current suggestion.
   *
   * **Re-reads the grid first**, and this is what makes a wrong origin
   * harmless rather than destructive. Between the suggestion being drawn and
   * the key being pressed, output may have arrived and redrawn the line, or
   * the origin may have been a guess that was wrong all along. If what is on
   * screen right now is not still a prefix of what is about to be sent, this
   * sends nothing and dismisses instead.
   *
   * Only ever appends: the suffix, never the whole line. There is no path here
   * that deletes what the user typed.
   */
  accept(): void {
    const view = this.view
    if (!view) return
    const command = view.items[view.index]
    const input = this.deps.tracker.read()
    this.clear()
    if (!this.shouldOffer(input)) return
    if (!command.startsWith(input.text)) return
    const suffix = command.slice(input.text.length)
    if (suffix === '') return
    this.deps.send(suffix)
    this.deps.noteAccepted(command)
    // The line now reads as the full command, so the next refresh has nothing
    // longer to offer. Saying so here avoids a flicker of the list re-opening
    // on the echo of what we just sent.
    this.lastQueried = command
  }

  /** Handle a keystroke. Returns whether it was consumed, i.e. whether the
   * caller should stop it reaching the far end. */
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
    })
    switch (action) {
      case 'accept':
        this.accept()
        return true
      case 'next':
        this.move(1)
        return true
      case 'previous':
        this.move(-1)
        return true
      case 'dismiss':
        this.clear()
        return true
      case 'ignore':
        return false
    }
  }

  /** Drop the offer without touching what is known about the prompt. Also
   * forgets the last query, so the same line can be offered again after the
   * user dismisses and keeps typing. */
  clear(): void {
    this.lastQueried = null
    this.hide()
  }

  /** Take the list off screen but remember what was last asked about — for
   * the case where the line changed without being typed, which should not
   * re-ask the store on every parsed write for as long as it stays that way. */
  private hide(): void {
    if (this.view !== null) this.publish(null)
  }

  /** A line ended (Enter, `^C`) — nothing to complete until the next prompt. */
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
