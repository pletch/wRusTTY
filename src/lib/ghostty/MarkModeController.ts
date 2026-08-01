import { columnText, isWordChar, type RowText } from './rowText'
import type { Point, Selection } from './SelectionController'

/**
 * Selecting text with the keyboard.
 *
 * A terminal cannot simply bind shift+arrow to "extend the selection": the
 * modified arrows are sequences a program owns (`\x1b[1;2A` and friends), and
 * shells, editors and every full-screen UI bind them. Taking them would be the
 * terminal quietly breaking the thing running inside it.
 *
 * So keyboard selection lives behind an explicit mode, the way it does in
 * Windows Terminal. While the mode is on, the keys this understands are the
 * terminal's and nothing reaches the wire; when it is off, not one of them is
 * touched. Everything is reversible with a single Escape, which is what makes
 * taking the keyboard for a while acceptable.
 *
 * The mode owns a cursor and, separately, an anchor. The anchor is set when a
 * selection starts being extended and stays put until the selection collapses,
 * so shift-arrow reads exactly the way it does in a text editor: the end you
 * are moving is the cursor, the end you are not is the anchor.
 */

/** What the controller needs from the engine. Deliberately narrow, and
 *  deliberately not the engine itself. */
export interface MarkModeHost {
  /** Absolute rows `from..to` inclusive. */
  readRows(from: number, to: number): RowText[]
  cols(): number
  /** Viewport height, for paging and for keeping the cursor on screen. */
  rows(): number
  /** Total absolute rows: scrollback plus the active screen. */
  totalRows(): number
  /** Where the terminal's own cursor sits, in absolute coordinates — where a
   *  fresh mark starts from. */
  terminalCursor(): Point
  /** Hand the renderer a selection to draw, or `null` for none. Also marks the
   *  view dirty. */
  setSelection(sel: Selection | null): void
  /** Scroll so that absolute `row` is on screen, moving as little as possible.
   *  Distinct from search's reveal, which parks a hit a third of the way down:
   *  doing that on every arrow key would make the pane jump under a cursor
   *  being walked one line at a time. */
  scrollRowIntoView(row: number): void
  /** Tell listeners the selection changed. */
  emitChange(): void
  /** The text of whatever selection is currently painted. The mouse path's
   *  implementation, reused deliberately: the rules about which trailing blanks
   *  are padding and which were chosen are subtle enough that a second copy of
   *  them would be a second answer. */
  selectionText(): string
  /** Ask the frontend to put `text` on the clipboard. The engine has no
   *  clipboard of its own — the one in the app is Tauri's, and reaching it from
   *  here would put a platform dependency inside the engine. */
  requestCopy(text: string): void
  /** The mode turned on or off, for the pane's indicator. */
  notifyMode(active: boolean): void
}

export class MarkModeController {
  private active = false
  /** The end that moves. Absolute buffer coordinates. */
  private cursor: Point = { x: 0, y: 0 }
  /** The end that stays. Null when there is no selection, only a cursor. */
  private anchor: Point | null = null

  private readonly host: MarkModeHost

  constructor(host: MarkModeHost) {
    this.host = host
  }

  isActive(): boolean {
    return this.active
  }

  toggle(): void {
    if (this.active) this.exit()
    else this.enter()
  }

  enter(): void {
    if (this.active) return
    this.active = true
    // Starting where the terminal's cursor is means the mode opens on the
    // thing just printed, which is what it is nearly always opened to grab.
    this.cursor = this.clamp(this.host.terminalCursor())
    this.anchor = null
    this.host.scrollRowIntoView(this.cursor.y)
    this.paint()
    this.host.notifyMode(true)
  }

  /**
   * Leaves the mode. `keepSelection` is what separates copying from cancelling:
   * a copy has just put the text somewhere useful and the highlight confirms
   * what was taken, while Escape means the selection was a mistake.
   */
  exit(keepSelection = false): void {
    if (!this.active) return
    this.active = false
    this.anchor = null
    if (!keepSelection) {
      this.host.setSelection(null)
      this.host.emitChange()
    }
    this.host.notifyMode(false)
  }

  /**
   * Offers a key to the mode. Returns true if it was consumed, in which case
   * the caller must stop it — a key that both moves the mark cursor and reaches
   * the shell would be doing two contradictory things at once.
   *
   * Anything with Ctrl or Meta that this does not name is deliberately passed
   * through rather than swallowed, so the app's own shortcuts (new tab, close
   * pane, the command palette) keep working while the mode is on. Plain
   * printable keys *are* swallowed: typing is what the mode suspends, and
   * letting a stray keystroke through to the shell while the user thinks they
   * are selecting is how a mode like this does damage.
   */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.active) return false
    if (e.metaKey) return false

    const extend = e.shiftKey
    const word = e.ctrlKey
    const cols = this.host.cols()
    const rows = this.host.rows()

    switch (e.key) {
      case 'Escape':
        this.exit()
        return true
      case 'Enter':
        this.copy()
        return true
      case 'ArrowLeft':
        this.move(word ? this.wordLeft() : this.stepColumn(-1), extend)
        return true
      case 'ArrowRight':
        this.move(word ? this.wordRight() : this.stepColumn(1), extend)
        return true
      case 'ArrowUp':
        this.move({ x: this.cursor.x, y: this.cursor.y - 1 }, extend)
        return true
      case 'ArrowDown':
        this.move({ x: this.cursor.x, y: this.cursor.y + 1 }, extend)
        return true
      case 'Home':
        this.move(word ? { x: 0, y: 0 } : { x: 0, y: this.cursor.y }, extend)
        return true
      case 'End':
        this.move(
          word
            ? { x: cols - 1, y: this.host.totalRows() - 1 }
            : { x: this.lastUsedColumn(this.cursor.y), y: this.cursor.y },
          extend,
        )
        return true
      case 'PageUp':
        this.move({ x: this.cursor.x, y: this.cursor.y - rows }, extend)
        return true
      case 'PageDown':
        this.move({ x: this.cursor.x, y: this.cursor.y + rows }, extend)
        return true
    }

    // Ctrl+A selects the line the cursor is on — the whole buffer is already
    // reachable through the pane's own select-all, and a line is what this
    // gesture is actually wanted for here.
    if (word && !e.shiftKey && e.key.toLowerCase() === 'a') {
      this.anchor = { x: 0, y: this.cursor.y }
      this.cursor = { x: cols - 1, y: this.cursor.y }
      this.paint()
      return true
    }

    // Ctrl and Alt combinations this does not name belong to the app.
    if (e.ctrlKey || e.altKey) return false
    // A bare modifier press is not typing; swallowing it would be harmless but
    // reporting it as consumed for no reason is noise.
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt') return false
    // Everything else printable: swallowed, because typing is suspended.
    return e.key.length === 1
  }

  /**
   * The mode has to yield to anything that takes the selection over — a mouse
   * drag, a programmatic clear, teardown. Otherwise the keyboard stays captured
   * with a cursor pointing at a selection that is no longer there.
   */
  cancel(): void {
    if (!this.active) return
    this.active = false
    this.anchor = null
    this.host.notifyMode(false)
  }

  /** Puts the selection on the clipboard and leaves the mode. Copying is the
   *  point of the mode, so it is also the way out that keeps the result. */
  private copy(): void {
    // Read before leaving: the text comes from what is painted, and exiting
    // without `keepSelection` would have wiped it.
    const text = this.selection() ? this.host.selectionText() : ''
    this.exit(text !== '')
    if (text) this.host.requestCopy(text)
  }

  /**
   * Moves the cursor, extending or collapsing as the shift key says.
   *
   * The anchor is set on the first extending move rather than on entry: until
   * then there is no selection to hold an end of, and an anchor left over from
   * a previous selection would make the next shift-arrow leap back to it.
   */
  private move(to: Point, extend: boolean): void {
    if (extend) {
      if (!this.anchor) this.anchor = this.cursor
    } else {
      this.anchor = null
    }
    this.cursor = this.clamp(to)
    this.host.scrollRowIntoView(this.cursor.y)
    this.paint()
  }

  /**
   * Draws the cursor, as a selection of one cell when there is nothing
   * selected yet — which is what makes it visible at all, since the renderer
   * has no notion of a second cursor.
   *
   * Deliberately silent: `emitChange` is what copy-on-select listens to, and
   * firing it per keystroke would copy every intermediate state of a selection
   * still being built. The mouse path is the same shape — a drag paints on
   * every move and only announces itself on release.
   */
  private paint(): void {
    this.host.setSelection(this.selection() ?? { start: this.cursor, end: this.cursor })
  }

  /** The selection proper, or null when the cursor is only a cursor. The
   *  single-cell block the cursor is drawn as is not a selection: copying it
   *  would put one arbitrary character on the clipboard. */
  private selection(): Selection | null {
    if (!this.anchor) return null
    return { start: this.anchor, end: this.cursor }
  }

  private clamp(p: Point): Point {
    const total = this.host.totalRows()
    return {
      x: Math.max(0, Math.min(p.x, this.host.cols() - 1)),
      y: Math.max(0, Math.min(p.y, total - 1)),
    }
  }

  /** One column left or right, wrapping onto the neighbouring row at the ends
   *  — a cursor that stops dead in the corner of a line cannot be walked
   *  through a paragraph. */
  private stepColumn(delta: number): Point {
    const cols = this.host.cols()
    const x = this.cursor.x + delta
    if (x < 0) return this.cursor.y === 0 ? this.cursor : { x: cols - 1, y: this.cursor.y - 1 }
    if (x > cols - 1) {
      return this.cursor.y >= this.host.totalRows() - 1 ? this.cursor : { x: 0, y: this.cursor.y + 1 }
    }
    return { x, y: this.cursor.y }
  }

  private row(y: number): RowText | null {
    return this.host.readRows(y, y)[0] ?? null
  }

  /** Where the text on a row ends, so End lands after the last character
   *  rather than out in the padding. */
  private lastUsedColumn(y: number): number {
    const row = this.row(y)
    const cols = this.host.cols()
    if (!row) return 0
    for (let c = cols - 1; c >= 0; c--) {
      const t = columnText(row, c)
      if (t !== '' && t.trim() !== '') return c
    }
    return 0
  }

  /**
   * The start of the word at or before the cursor. Skips any run of
   * non-word columns first, so pressing it in the gap between two words lands
   * on the earlier word rather than doing nothing.
   */
  private wordLeft(): Point {
    const row = this.row(this.cursor.y)
    if (!row) return this.stepColumn(-1)
    let x = this.cursor.x - 1
    while (x >= 0 && !isWordChar(columnText(row, x))) x--
    if (x < 0) return this.cursor.y === 0 ? { x: 0, y: 0 } : { x: this.host.cols() - 1, y: this.cursor.y - 1 }
    while (x > 0 && isWordChar(columnText(row, x - 1))) x--
    return { x, y: this.cursor.y }
  }

  /** The start of the next word to the right, which is where the eye goes and
   *  what makes shift-ctrl-right take one word per press. */
  private wordRight(): Point {
    const row = this.row(this.cursor.y)
    const cols = this.host.cols()
    if (!row) return this.stepColumn(1)
    let x = this.cursor.x
    while (x < cols && isWordChar(columnText(row, x))) x++
    while (x < cols && !isWordChar(columnText(row, x))) x++
    if (x >= cols) {
      return this.cursor.y >= this.host.totalRows() - 1
        ? { x: cols - 1, y: this.cursor.y }
        : { x: 0, y: this.cursor.y + 1 }
    }
    return { x, y: this.cursor.y }
  }
}
