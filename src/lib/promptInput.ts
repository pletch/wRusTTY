/**
 * What is being typed at the remote prompt, read off the grid rather than
 * accumulated from keystrokes (see docs/AUTOCOMPLETE_PLAN.md, "The hard part").
 *
 * The line on screen is edited by things whose bytes never pass through here:
 * history recall, Tab completion, readline editing keys, bracketed paste,
 * wrapping, and hosts that don't echo. So the keystroke count is only a hint;
 * **the screen is the truth**: the input is whatever lies between where the
 * prompt ended and the cursor.
 *
 * This also makes password prompts safe by construction: nothing is echoed, so
 * there is nothing to read or store.
 */

import type { RowText } from './ghostty/rowText'

/** The slice of the engine this needs, declared structurally for testing. */
export interface GridReader {
  readonly cols: number
  /** Refreshes what the reads below see; optional for always-current readers. */
  syncReadState?(): void
  cursorCell?(): { x: number; y: number }
  readRowText?(fromAbs: number, toAbs: number): RowText[]
}

/** A cell in absolute buffer coordinates (stable as output scrolls). */
export interface Cell {
  row: number
  col: number
}

export interface PromptInput {
  /** The text between the prompt's end and the cursor. */
  text: string
  /** Where that text starts, i.e. the first cell after the prompt. */
  origin: Cell
  /** The cursor now: the end of `text`. */
  cursor: Cell
  /**
   * Whether everything from the cursor to the right edge is blank. Gates
   * suggesting: accepting appends, so completing mid-line would splice text into
   * the command.
   */
  atEnd: boolean
}

/**
 * How long the pane must have been quiet before a keystroke is taken as the
 * start of a new line on a host without shell integration ("a prompt was
 * drawn, then the user typed"). Longer than the echo of a waiting user's first
 * key, shorter than a person deciding what to run.
 */
const QUIET_BEFORE_INPUT_MS = 500

/**
 * How much must be typed before an inferred prompt is believed. A quiet period
 * can't tell a shell prompt from a program waiting on a key (apt's `[Y/n]`),
 * and those answers are always one key. Marked (OSC 133) prompts don't need
 * this.
 */
export const MIN_INFERRED_INPUT_LEN = 2

/**
 * Whether this line is too short to trust at an inferred prompt (probably one
 * key answering a program). Callers check `exact` first. Counts code points.
 */
export function tooShortToInfer(text: string): boolean {
  return [...text.trim()].length < MIN_INFERRED_INPUT_LEN
}

/** Rows one input line may span before the origin is assumed stale. */
const MAX_INPUT_ROWS = 8

/**
 * Tracks one pane's prompt line, fed OSC 133 markers, parsed-output events and
 * typed input. The grid is only read when asked.
 */
export class PromptInputTracker {
  private readonly grid: GridReader
  private readonly now: () => number

  /** Where the current input begins, or null when there's no prompt (before
   * the first marker, while a command runs, or on the alternate screen). */
  private origin: Cell | null = null
  /** Whether `origin` came from an OSC 133 `B` marker or was inferred from a
   * quiet period. Reported to the caller, which decides how far to trust it. */
  private originExact = false
  private lastOutputAt = 0
  /**
   * Printable characters typed since the origin, minus backspaces. Compared with
   * the visible text: a prompt that doesn't echo (a password) leaves this higher,
   * which blocks passive capture. See `typedCount`.
   */
  private typed = 0
  private running = false
  private onAlternate = false
  /** A keystroke went out with no origin to attribute it to, and nothing has
   * come back yet; see `lineUnaccounted`. */
  private blindKey = false
  /**
   * Something was drawn on this line by a keystroke we couldn't place, so the
   * cursor no longer marks a fresh prompt. Without this, pressing Up quickly
   * after output (no origin taken), then pausing and pressing Up again, would
   * take the origin at the end of the recalled command. The line goes unread
   * until `reset` (Enter, `^C`) or a marker.
   */
  private lineUnaccounted = false

  constructor(grid: GridReader, now: () => number = Date.now) {
    this.grid = grid
    this.now = now
  }

  /** Whether this engine can be read; engines without the grid reads (the
   * benchmark's xterm engine) produce no input rather than a wrong one. */
  get supported(): boolean {
    return typeof this.grid.cursorCell === 'function' && typeof this.grid.readRowText === 'function'
  }

  /** Feed an OSC 133/633 payload (the same string `CommandTracker.handleOsc`
   * takes). */
  handleOsc(data: string): void {
    const kind = data.split(';')[0]
    // A marker settles every inferred-state question. `D` is excluded: the
    // prompt after it brings its own `A`.
    if (kind === 'A' || kind === 'B' || kind === 'C') {
      this.blindKey = false
      this.lineUnaccounted = false
    }
    switch (kind) {
      case 'A':
        // A prompt is about to be drawn.
        this.origin = null
        this.running = false
        break
      case 'B':
        // The prompt finished drawing, so the cursor is exactly where the user's
        // text begins. Measured here in the handler, which runs with every byte
        // before the marker parsed and none after (see
        // GhosttyEngine.feed and oscStream.ts).
        this.origin = this.readCursor()
        this.originExact = this.origin !== null
        this.running = false
        break
      case 'C':
        // A command is running; the screen is its output.
        this.origin = null
        this.running = true
        break
      case 'D':
        this.running = false
        break
    }
  }

  /** The pane switched screen buffers; a full-screen program's input line isn't
   * a shell prompt. */
  setAltScreen(isAlternate: boolean) {
    this.onAlternate = isAlternate
    if (isAlternate) this.origin = null
  }

  /**
   * A write has been fully parsed (wire to `onWriteParsed`). Records the time
   * the inferred origin's quiet period is measured from.
   */
  noteParsed() {
    this.lastOutputAt = this.now()
    // The far end answered an unplaced keystroke; see `lineUnaccounted`.
    if (this.blindKey) {
      this.blindKey = false
      this.lineUnaccounted = true
    }
  }

  /**
   * The user typed or pasted. Infers an origin on a host without integration
   * (never replacing an exact one) and counts printable input.
   *
   * @param data the bytes sent, when the caller has them.
   */
  noteInput(data?: Uint8Array) {
    if (this.origin === null && !this.running && !this.onAlternate) {
      if (!this.lineUnaccounted && this.now() - this.lastOutputAt >= QUIET_BEFORE_INPUT_MS) {
        this.origin = this.readCursor()
        this.originExact = false
        this.typed = 0
      }
      // Still unplaced, so the answer lands on a line we can't describe.
      if (this.origin === null) this.blindKey = true
    }
    if (!data || this.origin === null) return
    for (const byte of data) {
      // Backspace and DEL delete one character.
      if (byte === 0x7f || byte === 0x08) this.typed = Math.max(0, this.typed - 1)
      // Printable ASCII only; counting UTF-8 continuation bytes would overcount
      // and look like unechoed input.
      else if (byte >= 0x20 && byte < 0x7f) this.typed++
    }
  }

  /**
   * Printable input sent since this line began. If less is visible, something
   * didn't echo (e.g. a password), and the line must not be captured.
   */
  get typedCount(): number {
    return this.typed
  }

  /** Forget the current line (Enter, `^C`) but keep what's known about the
   * prompt. */
  reset() {
    this.origin = null
    this.typed = 0
    this.blindKey = false
    this.lineUnaccounted = false
  }

  /**
   * The grid was resized. Reflow moves text between rows, invalidating an
   * absolute-row origin. An integrated host re-marks the prompt on SIGWINCH;
   * without markers the line goes unread until the next one.
   */
  noteResized() {
    this.origin = null
    this.typed = 0
    this.blindKey = false
    this.lineUnaccounted = true
  }

  /** Everything unknown again: disconnect or teardown. */
  resetAll() {
    this.origin = null
    this.typed = 0
    this.blindKey = false
    this.lineUnaccounted = false
    this.running = false
    this.onAlternate = false
    this.originExact = false
  }

  /** Whether the origin came from a marker rather than a guess. */
  get exact(): boolean {
    return this.originExact
  }

  /**
   * Read the current input off the grid, or null when there's nothing to
   * complete (no origin, a command running, alternate screen, unreadable engine,
   * or a cursor the origin can't explain). Cheap: at most `MAX_INPUT_ROWS` rows.
   */
  read(): PromptInput | null {
    if (this.origin === null || this.running || this.onAlternate) return null
    const cursor = this.readCursor()
    if (cursor === null) return null
    const origin = this.origin

    // The cursor above the origin, or too far below, means the origin is stale.
    if (cursor.row < origin.row || cursor.row - origin.row >= MAX_INPUT_ROWS) return null
    if (cursor.row === origin.row && cursor.col < origin.col) return null

    const rows = this.grid.readRowText!(origin.row, cursor.row)
    if (rows.length !== cursor.row - origin.row + 1) return null

    let text = ''
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      // The first row starts after the prompt, later (wrapped) rows at column 0;
      // the last row ends at the cursor.
      const from = i === 0 ? origin.col : 0
      const to = i === rows.length - 1 ? cursor.col : this.grid.cols
      text += sliceColumns(row, from, to)
    }
    // Only the cursor's row needs checking; earlier wrapped rows are full.
    const tail = sliceColumns(rows[rows.length - 1], cursor.col, this.grid.cols)
    return { text, origin, cursor, atEnd: tail.trim() === '' }
  }

  private readCursor(): Cell | null {
    if (!this.supported) return null
    // Rebuild the snapshot, which otherwise only updates on a drawn frame.
    this.grid.syncReadState?.()
    const { x, y } = this.grid.cursorCell!()
    return { row: y, col: x }
  }
}

/**
 * The text of columns `[from, to)` of one row, via `colStart` because a column
 * isn't a character (grapheme clusters, wide-character spacers). Slicing by
 * character would drift and send the wrong text.
 */
export function sliceColumns(row: RowText, from: number, to: number): string {
  const lastColumn = row.colStart.length - 1
  const start = Math.max(0, Math.min(from, lastColumn))
  const end = Math.max(start, Math.min(to, lastColumn))
  return row.text.slice(row.colStart[start], row.colStart[end])
}
