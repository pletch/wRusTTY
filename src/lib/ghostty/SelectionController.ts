import { columnText, isWordChar, type RowText } from './rowText'

/**
 * Mouse text selection, extracted from `GhosttyEngine`: drag state,
 * word/line selection, drag-autoscroll and turning a selection into text. The
 * DOM listeners stay on the engine, since each must first choose between
 * reporting the mouse to the program (`MouseReporter`) and selecting.
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
  /** Which of the absolute rows `from..to` continue the row above them. */
  readWrapFlags(from: number, to: number): boolean[]
  /** Cell under the pointer in absolute buffer coordinates. */
  coords(e: MouseEvent): Point
  /** The canvas, for hit-testing a drag; `null` before mount and after
   *  dispose. */
  canvas(): HTMLCanvasElement | null
  /** Whether there is anywhere to put a selection yet. */
  hasRenderer(): boolean
  /** Sets the selection to draw (or `null`) and marks the view dirty. */
  setSelection(sel: Selection | null): void
  /** What the renderer is currently drawing. */
  getSelection(): Selection | null
  /** Scrolls by `amount` lines, in the direction the content moves. */
  scrollLines(amount: number): void
  /** Notifies listeners the selection changed. */
  emitChange(): void
  /** A call rather than a snapshot, since it changes on resize. */
  cols(): number
}

export class SelectionController {
  /** A drag is in progress (distinct from a selection existing). */
  private selecting = false
  /** Where the current drag began; null after a word/line selection. */
  private start: Point | null = null
  /** The end a shift-click extends from. Survives a completed selection. */
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

  /** A drag released outside the window, or focus lost. Left set, the pane
   * would swallow clicks and typing. */
  cancel(): void {
    this.selecting = false
    this.stopDragScroll()
  }

  /** Drops the selection entirely; used by `clear()` and on reset. */
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
    // Only the columns a word spans are materialized.
    const at2 = (c: number) => columnText(row, c)
    // A wide character's spacer holds no text; its head is one column back.
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
    // Otherwise a later drag would extend from where the last one began.
    this.start = null
    // A shift-click after picking a word extends from that word's start.
    this.anchor = start
    this.rectangular = false
    this.selecting = false
    this.host.emitChange()
  }

  /**
   * Shift extends the selection from its anchor. The caller decides whether
   * shift is available (not under mouse reporting).
   */
  extendFromAnchor(e: MouseEvent): void {
    if (!this.anchor) return
    this.selecting = true
    // The drag handler tracks from `start` and rebuilds from `rectangular`, so
    // both must be set for the extend to follow the pointer.
    this.start = this.anchor
    this.rectangular = e.altKey
    this.host.setSelection({
      start: this.anchor,
      end: this.host.coords(e),
      rectangular: e.altKey,
    })
    this.host.emitChange()
  }

  /** A fresh drag. Alt makes a column selection. */
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
    // A pointer still in the starting cell is a click, not a drag.
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
   * Scrolls while a selection is dragged past the top or bottom of the pane.
   * The pointer stops generating mousemoves outside, so a timer drives it and
   * the selection end is recomputed from the last position each tick.
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
    // Further out scrolls faster.
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
    // `out` is already signed for `scrollLines`: negative (above the pane)
    // scrolls back into history.
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
   * Trailing blanks are trimmed (they're grid padding) except on a linewise
   * selection whose last row ends partway, where they were dragged over
   * deliberately. Rows join with a newline only where the buffer has one, not at
   * soft wraps; a rectangular selection's rows are always separate.
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
    // One row past the end: row `i` joins if the row after it continues it.
    const wrapped = rectangular ? [] : this.host.readWrapFlags(selStart.y, selEnd.y + 1)
    let out = ''
    for (let i = 0; i < rows.length; i++) {
      const abs = selStart.y + i
      const from = rectangular ? rectFrom : abs === selStart.y ? selStart.x : 0
      const to = rectangular ? rectTo : abs === selEnd.y ? selEnd.x : cols - 1
      // One slice of the row's text; `colStart` has one more entry than columns.
      const row = rows[i]
      const lo = Math.max(0, Math.min(from, cols))
      const hi = Math.max(lo, Math.min(to + 1, cols))
      const text = row.text.slice(row.colStart[lo], row.colStart[hi])
      // A continued row's tail is mid-line content: not trimmed, no break.
      const continues = wrapped[i + 1] === true && i + 1 < rows.length
      const endsMidRow = abs === selEnd.y && selEnd.x < cols - 1
      const keepTrailing = !rectangular && (endsMidRow || continues)
      out += keepTrailing ? text : text.replace(/\s+$/, '')
      if (i + 1 < rows.length && !continues) out += '\n'
    }
    return out
  }
}
