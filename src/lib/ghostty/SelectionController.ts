import { columnText, isWordChar, type RowText } from './rowText'

/**
 * Selecting text with the mouse, extracted from `GhosttyEngine`.
 *
 * Owns the seven fields that only ever talked to each other — `isSelecting`,
 * `selectionStart`, `selectionAnchor`, `selectionRectangular` and the three
 * `dragScroll*` — plus word/line selection, the drag-autoscroll timer, and
 * turning a selection into text.
 *
 * The DOM listeners stay on the engine, because each of them has to decide
 * between reporting the mouse to the program and selecting with it before it
 * can do either. `MouseReporter` owns the other side of that decision; the
 * `mousedown`/`mousemove` handlers read as that choice and nothing else once
 * both are out.
 */

/** How far a drag past the edge can scroll per tick, and how often. */
const DRAG_SCROLL_MAX_LINES = 8
const DRAG_SCROLL_INTERVAL_MS = 50

export interface Point {
  x: number
  y: number
}

export interface Selection {
  start: Point
  end: Point
  rectangular?: boolean
}

/** What the controller needs from the engine. */
export interface SelectionHost {
  /** Absolute rows `from..to` inclusive. */
  readRows(from: number, to: number): RowText[]
  /** Cell under the pointer in absolute buffer coordinates. */
  coords(e: MouseEvent): Point
  /** The canvas, for hit-testing a drag against its edges. `null` before
   *  mount and after dispose. */
  canvas(): HTMLCanvasElement | null
  /** Whether there is anywhere to put a selection yet. */
  hasRenderer(): boolean
  /** Hand the renderer a selection to draw, or `null` for none. Also marks
   *  the view dirty. */
  setSelection(sel: Selection | null): void
  /** What the renderer is currently drawing. */
  getSelection(): Selection | null
  /** Scroll by `amount` lines, in the direction the *content* moves. */
  scrollLines(amount: number): void
  /** Tell listeners the selection changed. */
  emitChange(): void
  /** Live read, as a call: a value snapshotted at construction would be
   *  wrong after the first resize. */
  cols(): number
}

export class SelectionController {
  /** A drag is in progress. Distinct from "a selection exists": a completed
   *  selection is not being dragged. */
  private selecting = false
  /** Where the current drag began. Null after a word/line selection, which is
   *  a click rather than a drag. */
  private start: Point | null = null
  /** The end a shift-click extends *from*. Survives a completed selection,
   *  which is what makes shift-click-to-extend work at all. */
  private anchor: Point | null = null
  private rectangular = false

  private dragScrollTimer: ReturnType<typeof setInterval> | null = null
  private dragScrollLines = 0
  private dragScrollAt: { clientX: number; clientY: number } | null = null

  private readonly host: SelectionHost

  constructor(host: SelectionHost) {
    this.host = host
  }

  isSelecting(): boolean {
    return this.selecting
  }

  hasAnchor(): boolean {
    return this.anchor !== null
  }

  /**
   * A drag released outside the window, or focus lost. Left set, a stuck
   * "still selecting" leaves the pane in a selection that swallows clicks and
   * typing until something else clears it.
   */
  cancel(): void {
    this.selecting = false
    this.stopDragScroll()
  }

  /** Drops the selection entirely — used by `clear()` and on reset. */
  reset(): void {
    this.start = null
    this.anchor = null
    this.selecting = false
    this.stopDragScroll()
    this.host.setSelection(null)
    this.host.emitChange()
  }

  selectWordAt(pos: Point): void {
    if (!this.host.hasRenderer()) return
    const row = this.host.readRows(pos.y, pos.y)[0]
    if (!row) return
    // Only the columns a word actually spans get materialised as strings —
    // the scan stops at the first non-word character either side.
    const at2 = (c: number) => columnText(row, c)
    // A wide character's spacer holds no text, so the head it belongs to is one
    // column back.
    let at = pos.x
    if (at2(at) === '' && at > 0) at--
    if (!isWordChar(at2(at))) return
    let from = at
    while (from > 0 && isWordChar(at2(from - 1) || ' ')) from--
    let to = at
    while (to < this.host.cols() - 1 && isWordChar(at2(to + 1) || ' ')) to++
    this.apply({ x: from, y: pos.y }, { x: to, y: pos.y })
  }

  selectLineAt(pos: Point): void {
    this.apply({ x: 0, y: pos.y }, { x: this.host.cols() - 1, y: pos.y })
  }

  selectAll(totalRows: number): void {
    this.host.setSelection({
      start: { x: 0, y: 0 },
      end: { x: this.host.cols() - 1, y: totalRows - 1 },
    })
    this.host.emitChange()
  }

  private apply(start: Point, end: Point): void {
    if (!this.host.hasRenderer()) return
    this.host.setSelection({ start, end })
    // Left dangling, a later drag would extend from wherever the last one began.
    this.start = null
    // A shift-click after picking a word extends from that word's start.
    this.anchor = start
    this.rectangular = false
    this.selecting = false
    this.host.emitChange()
  }

  /**
   * Shift extends the existing selection from its anchor rather than starting
   * a new one — the same gesture every text surface uses. The caller decides
   * whether shift is available for this (under mouse reporting it is not; see
   * the engine's mousedown handler).
   */
  extendFromAnchor(e: MouseEvent): void {
    if (!this.anchor) return
    this.selecting = true
    // The drag handler tracks from `start`, so extending has to set it too —
    // to the anchor, since that is the end this gesture holds fixed. Left null
    // (which is what a double-click leaves behind) the extend was a click and
    // nothing more: the pointer could be dragged anywhere and the selection
    // would not follow, and drag-autoscroll never armed.
    this.start = this.anchor
    // Same reason: the drag handler rebuilds the selection from the field, not
    // from what was set here, so a shift-alt extend would drop back to a
    // linewise selection the moment the pointer moved.
    this.rectangular = e.altKey
    this.host.setSelection({
      start: this.anchor,
      end: this.host.coords(e),
      rectangular: e.altKey,
    })
    this.host.emitChange()
  }

  /** A fresh drag. Alt is the usual modifier for a column selection — pulling
   *  one field out of tabular output without the rest of each line. */
  begin(e: MouseEvent): void {
    this.selecting = true
    this.start = this.host.coords(e)
    this.anchor = this.start
    this.rectangular = e.altKey
    if (this.host.hasRenderer()) {
      this.host.setSelection(null)
      this.host.emitChange()
    }
  }

  /**
   * Extends the in-progress drag to the pointer. Returns false if there was no
   * drag to extend, so the caller can fall through.
   */
  drag(e: MouseEvent): boolean {
    if (!this.selecting || !this.host.hasRenderer() || !this.start) return false
    // A pointer that has not left the starting cell is a click, not a drag.
    // Rendering start==end as a selection is what left a one-cell grey block
    // behind after clicking — most visibly on the click that reactivates the
    // window, where the pointer is still moving into the app as it lands.
    const end = this.host.coords(e)
    const moved = end.x !== this.start.x || end.y !== this.start.y
    if (!moved) {
      if (this.host.getSelection()) this.host.setSelection(null)
    } else {
      this.host.setSelection({ start: this.start, end, rectangular: this.rectangular })
    }
    this.updateDragScroll(e)
    return true
  }

  /**
   * Drives scrolling while a selection is dragged past the top or bottom of the
   * pane. Without it a selection can only ever cover what was already on
   * screen, since there is no way to reach the rest — the drag has nowhere left
   * to go once the pointer leaves the canvas.
   *
   * The pointer stops moving once it is outside, so the scrolling cannot be
   * driven by mousemove; it runs on a timer for as long as the pointer stays
   * out, and the selection end is recomputed from the last known position each
   * tick so the highlight follows the rows coming into view.
   */
  private updateDragScroll(e: MouseEvent): void {
    const canvas = this.host.canvas()
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const above = rect.top - e.clientY
    const below = e.clientY - rect.bottom
    const out = above > 0 ? -above : below > 0 ? below : 0
    if (out === 0) {
      this.stopDragScroll()
      return
    }
    // Further out scrolls faster, which is what makes reaching for something a
    // long way back feel like one gesture rather than a wait.
    this.dragScrollLines =
      Math.sign(out) * Math.min(DRAG_SCROLL_MAX_LINES, 1 + Math.floor(Math.abs(out) / 24))
    this.dragScrollAt = { clientX: e.clientX, clientY: e.clientY }
    if (this.dragScrollTimer === null) {
      this.dragScrollTimer = setInterval(this.stepDragScroll, DRAG_SCROLL_INTERVAL_MS)
    }
  }

  private stepDragScroll = () => {
    if (!this.selecting || !this.start || !this.host.hasRenderer() || !this.dragScrollAt) {
      this.stopDragScroll()
      return
    }
    // `out` is already signed the way `scrollLines` wants it — negative for a
    // pointer above the pane, and negative is what scrolls back into history
    // (it raises the viewport offset, the same as a wheel-up's negative
    // deltaY). Negating it here sent a drag past the top forward instead, so
    // the one gesture that has to reach into the scrollback was the one that
    // ran away from it.
    this.host.scrollLines(this.dragScrollLines)
    this.host.setSelection({
      start: this.start,
      end: this.host.coords(this.dragScrollAt as MouseEvent),
      rectangular: this.rectangular,
    })
  }

  stopDragScroll(): void {
    if (this.dragScrollTimer === null) return
    clearInterval(this.dragScrollTimer)
    this.dragScrollTimer = null
    this.dragScrollAt = null
  }

  /** Stops the timer for good. Called from the engine's dispose. */
  dispose(): void {
    this.stopDragScroll()
  }

  /**
   * The selected text.
   *
   * Trailing blanks are the grid padding a row out, not content. The one case
   * worth keeping them is a line-wise selection whose last row ends part-way
   * along: there the run of spaces was dragged over deliberately. A selection
   * reaching the final column did not choose that padding — triple-click is
   * exactly that, and keeping it pasted a command followed by a screenful of
   * spaces. A column selection never keeps them either; every one of its rows
   * ends at the same arbitrary column.
   */
  text(): string {
    const sel = this.host.getSelection()
    if (!sel) return ''

    let selStart = sel.start
    let selEnd = sel.end
    if (selStart.x === selEnd.x && selStart.y === selEnd.y) return ''
    if (selStart.y > selEnd.y || (selStart.y === selEnd.y && selStart.x > selEnd.x)) {
      const temp = selStart
      selStart = selEnd
      selEnd = temp
    }

    const rectangular = sel.rectangular === true
    const rectFrom = Math.min(selStart.x, selEnd.x)
    const rectTo = Math.max(selStart.x, selEnd.x)
    const cols = this.host.cols()

    const rows = this.host.readRows(selStart.y, selEnd.y)
    const parts: string[] = []
    for (let i = 0; i < rows.length; i++) {
      const abs = selStart.y + i
      const from = rectangular ? rectFrom : abs === selStart.y ? selStart.x : 0
      const to = rectangular ? rectTo : abs === selEnd.y ? selEnd.x : cols - 1
      // One slice of the row's own text rather than a join of per-cell
      // strings. `to + 1` is always a valid index into `colStart`, which has
      // one entry more than there are columns.
      const row = rows[i]
      const lo = Math.max(0, Math.min(from, cols))
      const hi = Math.max(lo, Math.min(to + 1, cols))
      const text = row.text.slice(row.colStart[lo], row.colStart[hi])
      const endsMidRow = abs === selEnd.y && selEnd.x < cols - 1
      const keepTrailing = !rectangular && endsMidRow
      parts.push(keepTrailing ? text : text.replace(/\s+$/, ''))
    }
    return parts.join('\n')
  }
}
