import { columnText, isWordChar, type RowText } from './rowText'
import type { Point, Selection } from './SelectionController'

/**
 * Selecting text with the keyboard.
 *
 * Shift+arrow sequences belong to the program running inside, so keyboard
 * selection lives behind an explicit mode, as in Windows Terminal. While on,
 * the keys it understands never reach the wire; Escape leaves.
 *
 * The cursor is the end that moves; the anchor, set when a selection starts
 * extending, stays put until it collapses, as in a text editor.
 */

/** What the controller needs from the engine. */
export interface MarkModeHost {
  /** Absolute rows `from..to` inclusive. */
  readRows(from: number, to: number): RowText[]
  cols(): number
  /** Viewport height, for paging and for keeping the cursor on screen. */
  rows(): number
  /** Total absolute rows: scrollback plus the active screen. */
  totalRows(): number
  /** The terminal's own cursor, absolute: where a fresh mark starts. */
  terminalCursor(): Point
  /** Sets the selection to draw (or `null`) and marks the view dirty. */
  setSelection(sel: Selection | null): void
  /** Scrolls absolute `row` on screen, moving as little as possible (unlike
   *  search's reveal, which would make the pane jump on every arrow). */
  scrollRowIntoView(row: number): void
  /** Notifies listeners the selection changed. */
  emitChange(): void
  /** The painted selection's text, via the mouse path's rules for trailing
   *  blanks. */
  selectionText(): string
  /** Asks the frontend to copy `text`; the engine has no clipboard of its
   *  own. */
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
    // Start at the terminal's cursor: usually what the mode was opened to grab.
    this.cursor = this.clamp(this.host.terminalCursor())
    this.anchor = null
    this.host.scrollRowIntoView(this.cursor.y)
    this.paint()
    this.host.notifyMode(true)
  }

  /**
   * Leaves the mode. A copy keeps the selection as confirmation; Escape clears
   * it.
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
   * Offers a key to the mode. Returns true if consumed, in which case the
   * caller must stop it.
   *
   * Unnamed Ctrl/Meta combinations pass through so app shortcuts keep working.
   * Plain printable keys are swallowed, so nothing typed by mistake reaches the
   * shell.
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

    // Ctrl+A selects the cursor's line; the pane's select-all covers the buffer.
    if (word && !e.shiftKey && e.key.toLowerCase() === 'a') {
      this.anchor = { x: 0, y: this.cursor.y }
      this.cursor = { x: cols - 1, y: this.cursor.y }
      this.paint()
      return true
    }

    // Ctrl and Alt combinations this does not name belong to the app.
    if (e.ctrlKey || e.altKey) return false
    // A bare modifier isn't typing.
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt') return false
    // Everything else printable: swallowed, because typing is suspended.
    return e.key.length === 1
  }

  /**
   * Yields to anything that takes over the selection (a mouse drag, a clear,
   * teardown), so the keyboard isn't left captured.
   */
  cancel(): void {
    if (!this.active) return
    this.active = false
    this.anchor = null
    this.host.notifyMode(false)
  }

  /** Copies the selection and leaves the mode, keeping the result. */
  private copy(): void {
    // Read before leaving, which would wipe what's painted.
    const text = this.selection() ? this.host.selectionText() : ''
    this.exit(text !== '')
    if (text) this.host.requestCopy(text)
  }

  /**
   * Moves the cursor, extending or collapsing per Shift. The anchor is set on
   * the first extending move, not on entry, so an old anchor can't be jumped
   * back to.
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
   * Draws the cursor, as a one-cell selection when nothing is selected (the
   * renderer has no second cursor). Doesn't `emitChange`, which would trigger
   * copy-on-select per keystroke; the mouse path likewise announces on release.
   */
  private paint(): void {
    this.host.setSelection(this.selection() ?? { start: this.cursor, end: this.cursor })
  }

  /** The selection proper, or null when the cursor is only a cursor (its
   *  one-cell block isn't worth copying). */
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

  /** One column left or right, wrapping onto the neighboring row. */
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

  /** Where a row's text ends, so End lands after the last character. */
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
   * The start of the word at or before the cursor, skipping non-word columns
   * first so it moves even from a gap.
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

  /** The start of the next word to the right. */
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
