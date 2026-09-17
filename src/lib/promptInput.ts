/**
 * What is being typed at the remote prompt, right now.
 *
 * The load-bearing decision of the whole autocomplete feature, and the reason
 * it is a grid reader rather than a keystroke buffer. See
 * docs/AUTOCOMPLETE_PLAN.md, "The hard part".
 *
 * The obvious implementation accumulates bytes from `onInput` since the last
 * Enter and calls that the current line. It works in a demo and inserts
 * garbage in real use, because the line on screen is edited by things whose
 * bytes never pass through here:
 *
 *   - readline history recall (Up, `^R`) replaces the whole line from the far
 *     side
 *   - Tab completion inserts text the *remote* chose
 *   - `^W`, `^U`, `^K`, `^A`/`^E`, Alt+B/F edit and move by units we would
 *     have to model exactly, per shell, per keymap
 *   - bracketed paste arrives as one blob and is echoed on the remote's terms
 *   - a long line wraps across rows; a multi-line prompt starts partway down
 *   - the remote may not echo at all, which is what a password prompt is
 *
 * So the keystroke buffer is a hint and **the screen is the truth**: the input
 * is whatever sits between where the prompt ended and where the cursor is now.
 * Tab completion, history recall and reverse-i-search then need no special
 * handling, because whatever they did is on screen and we simply read it.
 *
 * The same rule is what makes the feature safe at a password prompt. Nothing
 * was echoed, so there is nothing between the origin and the cursor, so there
 * is nothing to read and nothing to store — a property of the design rather
 * than a heuristic that has to recognise what a password prompt looks like.
 */

import type { RowText } from './ghostty/rowText'

/** The slice of the engine this needs. Declared structurally so the tracker
 * can be tested against a plain fake, and so it never reaches for anything
 * beyond these three. */
export interface GridReader {
  readonly cols: number
  /** Refreshes what the two reads below see. Optional: a reader whose state is
   * always current has nothing to do here. */
  syncReadState?(): void
  cursorCell?(): { x: number; y: number }
  readRowText?(fromAbs: number, toAbs: number): RowText[]
}

/** A cell in absolute buffer coordinates — the space `cursorCell` reports and
 * `readRowText` indexes, which stays stable as output scrolls. */
export interface Cell {
  row: number
  col: number
}

export interface PromptInput {
  /** The text between the prompt's end and the cursor. */
  text: string
  /** Where that text starts, i.e. the first cell after the prompt. */
  origin: Cell
  /** Where the cursor is now — the end of `text`. */
  cursor: Cell
  /**
   * Whether the cursor is at the end of the line, i.e. everything from it to
   * the right edge is blank.
   *
   * Gates suggesting at all, and it is not a nicety. Accepting a suggestion
   * appends, so offering one while the cursor sits in the middle of a line —
   * after Home, or a left-arrow to fix a typo — would splice text into the
   * middle of the command and send something the user never composed. False
   * here means "read the input, but do not complete it".
   */
  atEnd: boolean
}

/**
 * How long the pane must have been quiet before a keystroke is taken as the
 * start of a fresh line, when the host has no shell integration to say so.
 *
 * The signal being approximated is "a prompt was just drawn and you have begun
 * typing at it". Output stopping, then the user typing, is what that looks
 * like from outside. Half a second is comfortably longer than the gap between
 * a prompt being written and a waiting user's first keypress being echoed, and
 * comfortably shorter than a human noticing a prompt and deciding what to run.
 */
const QUIET_BEFORE_INPUT_MS = 500

/**
 * How much has to have been typed before an inferred prompt is believed.
 *
 * Only applies when the origin was guessed from a quiet period rather than
 * given by an OSC 133 marker, and it exists because of what that guess cannot
 * distinguish. `apt` printing `Do you want to continue? [Y/n]` and waiting,
 * then the user pressing `n`, is the same shape as a shell drawing a prompt
 * and the user starting a command: output stops, then a printable character
 * is typed. So a single keystroke answering a program's question gets read as
 * a one-character command line, and every remembered command beginning with
 * that letter is offered — which is what someone actually hit, mid-install.
 *
 * Two characters is enough to separate them, because the confusable case is
 * always exactly one key: `y`, `n`, a menu's `1`, a pager's `q`. Nothing is
 * given up in exchange — a one-character prefix matches so much of any real
 * history that it was never a suggestion worth making.
 *
 * A marked prompt needs none of this. There the shell has said where the line
 * begins, and a one-character command is simply a one-character command.
 */
export const MIN_INFERRED_INPUT_LEN = 2

/**
 * Whether this line is too short to be believed as a command at an inferred
 * prompt — a single key answering a program, most likely. Callers check
 * `exact` first; this says nothing about a marked prompt.
 *
 * Counts code points rather than UTF-16 units, so one astral character is one
 * character and not two.
 */
export function tooShortToInfer(text: string): boolean {
  return [...text.trim()].length < MIN_INFERRED_INPUT_LEN
}

/** Rows a single logical input line may span before it is abandoned. A command
 * being typed can wrap a few times; a hundred rows means the origin is stale
 * and we are reading a screenful of program output as if it were a prompt. */
const MAX_INPUT_ROWS = 8

/**
 * Tracks one pane's prompt line.
 *
 * Fed three things: the OSC 133 markers, the fact that output was parsed, and
 * the fact that the user typed. It reads the grid only when asked for the
 * current input, so a pane nobody is autocompleting in costs nothing.
 */
export class PromptInputTracker {
  private readonly grid: GridReader
  private readonly now: () => number

  /** Where the current input begins, or null when there is no prompt to
   * complete at — before the first marker, while a command runs, or on the
   * alternate screen. */
  private origin: Cell | null = null
  /** Whether `origin` came from an OSC 133 `B` marker (exact) or was inferred
   * from a quiet period (a guess). Only reported, never acted on differently
   * here — the difference matters to the caller deciding how much to trust a
   * suggestion, and to acceptance, which re-reads before sending. */
  private originExact = false
  private lastOutputAt = 0
  /**
   * Printable characters typed since the origin, less those backspaced away.
   *
   * Compared against how much text is actually visible, to answer "did
   * everything I typed show up". A prompt that echoes nothing leaves this well
   * above the visible length, which is what disqualifies a password from ever
   * being captured passively — see `typedCount`.
   */
  private typed = 0
  private running = false
  private onAlternate = false
  /**
   * A keystroke went out while there was no origin to attribute it to, and
   * nothing has come back yet.
   *
   * Only half of the state below; `lineUnaccounted` is where it lands.
   */
  private blindKey = false
  /**
   * Something was drawn onto this line by a keystroke we could not place, so
   * the cursor no longer stands where an inferred origin would want it.
   *
   * This is what stops the quiet period from being believed twice over. The
   * guess in `noteInput` is "output stopped, then you typed, so the cursor is
   * at a fresh prompt" — true of the first key at an idle prompt, and false
   * the moment a key has already put something on the line. Press Up inside
   * `QUIET_BEFORE_INPUT_MS` of a command's last output and no origin is taken;
   * the shell recalls a command anyway; pause, press Up again, and the quiet
   * test now passes with a full command line on screen. The origin is then
   * taken at the *end* of that command, and every read after it returns a
   * fragment of the line: the history flicker blinks the tail of the command
   * rather than the command, and the capture path records the fragment as if
   * it were something someone typed.
   *
   * So a line that has been written to behind our back is one this declines to
   * guess about at all, until `reset` ends it — Enter, `^C` — or a marker
   * says outright where the next one begins. Silence costs this host the
   * blink and the passive capture for that one line; guessing costs it a wrong
   * answer and a junk entry in the command store.
   */
  private lineUnaccounted = false

  constructor(grid: GridReader, now: () => number = Date.now) {
    this.grid = grid
    this.now = now
  }

  /** Whether this engine can be read at all. An engine without the optional
   * grid reads (the benchmark harness's xterm comparison engine) simply never
   * produces an input, rather than producing a wrong one. */
  get supported(): boolean {
    return typeof this.grid.cursorCell === 'function' && typeof this.grid.readRowText === 'function'
  }

  /** Feed the payload of an OSC 133/633 sequence — the same string
   * `CommandTracker.handleOsc` takes, so both can sit on one handler. */
  handleOsc(data: string): void {
    const kind = data.split(';')[0]
    // A marker is the far end saying where it is in the cycle, which settles
    // every question the guesswork below exists to answer. Whatever was on the
    // old line stops mattering at the same moment. `D` is left out: it ends a
    // command, and the prompt that follows it carries its own `A`.
    if (kind === 'A' || kind === 'B' || kind === 'C') {
      this.blindKey = false
      this.lineUnaccounted = false
    }
    switch (kind) {
      case 'A':
        // A prompt is about to be drawn. Whatever was being typed is gone.
        this.origin = null
        this.running = false
        break
      case 'B':
        // The prompt has finished drawing, so the cursor is standing exactly
        // where the user's own text will begin — the measurement the whole
        // design rests on, and why an integrated host gets a materially
        // better experience than an inferred one.
        //
        // Measured here, in the handler, and that is load-bearing. The engine
        // splits its parse at each OSC it dispatches, so a handler runs with
        // every byte *before* the marker already applied and none of what
        // follows it — which is precisely the instant being asked about. An
        // earlier version deferred this to the end of the write instead, and
        // overshot by whatever the rest of the chunk drew: readline reprints
        // the prompt and the line being edited in one write on SIGWINCH, on
        // `^L` and after a job-control message, so a single terminal resize
        // moved the origin to the *end* of the recalled command and every
        // read after it returned a fragment of the line or nothing at all.
        // See GhosttyEngine.parseAndDispatch and its `segEnd` handling.
        this.origin = this.readCursor()
        this.originExact = this.origin !== null
        this.running = false
        break
      case 'C':
        // A command is running: what is on screen is its output, not a line
        // being typed.
        this.origin = null
        this.running = true
        break
      case 'D':
        this.running = false
        break
    }
  }

  /** The pane switched screen buffers. A full-screen program's input line is
   * its own business — vim's `:` prompt is not a shell prompt, and offering
   * shell history at it would be wrong in both directions. */
  setAltScreen(isAlternate: boolean) {
    this.onAlternate = isAlternate
    if (isAlternate) this.origin = null
  }

  /**
   * A write has been fully parsed — wire this to `onWriteParsed`.
   *
   * The time it records is what the inferred origin's quiet period is measured
   * against, for hosts with no markers at all. A marked prompt's origin is not
   * measured here; see the `B` case above for why it cannot be.
   */
  noteParsed() {
    this.lastOutputAt = this.now()
    // The far end answered a keystroke that had no origin to belong to, which
    // means this line now holds text nothing here can account for. See
    // `lineUnaccounted`.
    if (this.blindKey) {
      this.blindKey = false
      this.lineUnaccounted = true
    }
  }

  /**
   * The user typed or pasted. Establishes an inferred origin on a host with no
   * shell integration — an exact origin is never replaced by a guess — and
   * counts how much printable input has gone out since the line began.
   *
   * @param data the bytes that went to the far end, when the caller has them.
   */
  noteInput(data?: Uint8Array) {
    if (this.origin === null && !this.running && !this.onAlternate) {
      if (!this.lineUnaccounted && this.now() - this.lastOutputAt >= QUIET_BEFORE_INPUT_MS) {
        this.origin = this.readCursor()
        this.originExact = false
        this.typed = 0
      }
      // Still nowhere to put this keystroke, so whatever the far end draws in
      // answer to it lands on a line this can no longer describe.
      if (this.origin === null) this.blindKey = true
    }
    if (!data || this.origin === null) return
    for (const byte of data) {
      // Backspace and DEL both delete one character to the left in every
      // line editor this will meet.
      if (byte === 0x7f || byte === 0x08) this.typed = Math.max(0, this.typed - 1)
      // Printable ASCII only. Anything above 0x7f is part of a multi-byte
      // UTF-8 character, and counting each byte would overcount a single
      // typed character as two or three — which would then look like input
      // that failed to echo.
      else if (byte >= 0x20 && byte < 0x7f) this.typed++
    }
  }

  /**
   * How much printable input has gone out since this line began.
   *
   * The passive-capture safety check: if less text is visible than was typed,
   * something did not echo, and a line that did not fully echo must never be
   * recorded. A password prompt leaves this at the length of the password with
   * nothing on screen at all.
   */
  get typedCount(): number {
    return this.typed
  }

  /** Forget the current line without touching what is known about the prompt —
   * for Enter, `^C`, and anything else that ends a line being typed. */
  reset() {
    this.origin = null
    this.typed = 0
    this.blindKey = false
    this.lineUnaccounted = false
  }

  /**
   * The grid has been resized.
   *
   * An origin is an absolute buffer row, which is what keeps it valid as
   * output scrolls underneath it — but a resize is the one event that moves
   * text between rows rather than moving rows past text. The core reflows the
   * buffer at the new width, so a row noted before the resize names different
   * cells after it, and a line that used to wrap may not any more: the origin
   * can end up *below* the cursor, which reads as no input at all.
   *
   * An integrated host re-answers this within the same breath, because the
   * shell redraws its prompt on SIGWINCH and that redraw carries a `B`. A host
   * with no markers has nothing to re-answer with, so this line goes unread
   * until the next one begins — the same trade as `lineUnaccounted`, for the
   * same reason.
   */
  noteResized() {
    this.origin = null
    this.typed = 0
    this.blindKey = false
    this.lineUnaccounted = true
  }

  /** Everything is unknown again: a disconnect, or a pane being torn down. */
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
   * Read the current input off the grid, or null when there is nothing to
   * complete — no origin, a command running, the alternate screen, an engine
   * that cannot be read, or a cursor that has moved somewhere the origin
   * cannot explain.
   *
   * Called per keystroke, and cheap by construction: it reads at most
   * `MAX_INPUT_ROWS` rows and allocates one string.
   */
  read(): PromptInput | null {
    if (this.origin === null || this.running || this.onAlternate) return null
    const cursor = this.readCursor()
    if (cursor === null) return null
    const origin = this.origin

    // The cursor moving above the origin, or too far below it, means the
    // origin no longer describes where the line starts: the screen scrolled,
    // the prompt was redrawn, or a program painted over it. Give up rather
    // than read whatever happens to be between two unrelated points.
    if (cursor.row < origin.row || cursor.row - origin.row >= MAX_INPUT_ROWS) return null
    if (cursor.row === origin.row && cursor.col < origin.col) return null

    const rows = this.grid.readRowText!(origin.row, cursor.row)
    if (rows.length !== cursor.row - origin.row + 1) return null

    let text = ''
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      // First row starts after the prompt; every later row is a continuation
      // of a wrapped line and starts at column 0. The last row ends at the
      // cursor; every earlier one runs to the end of the grid.
      const from = i === 0 ? origin.col : 0
      const to = i === rows.length - 1 ? cursor.col : this.grid.cols
      text += sliceColumns(row, from, to)
    }
    // Only the row the cursor is on is checked. A wrapped line's earlier rows
    // are full by definition — that is what made it wrap — so blank space
    // there would mean the row was rewritten under us, which the row-count
    // check above has already ruled out.
    const tail = sliceColumns(rows[rows.length - 1], cursor.col, this.grid.cols)
    return { text, origin, cursor, atEnd: tail.trim() === '' }
  }

  private readCursor(): Cell | null {
    if (!this.supported) return null
    // The snapshot `cursorCell` and `readRowText` read from is otherwise only
    // rebuilt on a drawn frame, and every read here happens inside the same
    // turn as the write that caused it.
    this.grid.syncReadState?.()
    const { x, y } = this.grid.cursorCell!()
    return { row: y, col: x }
  }
}

/**
 * The text of columns `[from, to)` of one row.
 *
 * Goes through `colStart` rather than slicing the row's string directly
 * because a column is not a character: a grapheme cluster occupies one column
 * and several code units, and the trailing half of a wide character occupies a
 * column and none at all. Slicing by character would drift by one for every
 * emoji or CJK character earlier in the line — and this is used to decide what
 * bytes to send, so drifting by one is sending the wrong command.
 */
export function sliceColumns(row: RowText, from: number, to: number): string {
  const lastColumn = row.colStart.length - 1
  const start = Math.max(0, Math.min(from, lastColumn))
  const end = Math.max(start, Math.min(to, lastColumn))
  return row.text.slice(row.colStart[start], row.colStart[end])
}
