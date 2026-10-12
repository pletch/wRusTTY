/**
 * Fills the renderer's packed cell buffer from ghostty `main`'s row/cell
 * iterator, in the 16-byte layout `parseCellInto` reads.
 *
 * The packed buffer, not `get_viewport`, is the contract the renderer, search,
 * links, selection and mark mode consume, so only its filler changes. Two
 * fillers producing identical bytes is asserted in `ViewportReader.test.ts`.
 *
 * Handles are held across frames, since per-frame allocation would cost more
 * than the read. `RS_ROW_DATA_CELLS_RAW` returns a row's raw cells as one
 * borrowed run; the cells iterator is still needed for styles, resolved colors
 * and grapheme lengths.
 *
 * `hyperlinkId` (bytes 12-13) is always 0: main's render path exposes only a
 * `HAS_HYPERLINK` bool. Nothing outside `wasmBindings.ts` reads it
 * (`LinkController` works off `readRows` text), and the parity test excludes
 * those two bytes.
 */
import * as abi from './abi'
import {
  CELL_BYTES,
  CELL_BOLD,
  CELL_ITALIC,
  CELL_UNDERLINE,
  CELL_STRIKETHROUGH,
  CELL_INVERSE,
  CELL_INVISIBLE,
  CELL_BLINK,
  CELL_FAINT,
  CELL2_OVERLINE,
  CELL2_UNDERLINE_MASK,
} from '../wasmBindings'

/** Byte offsets within a packed cell, mirroring `parseCellInto`. */
const OFF_CODEPOINT = 0
const OFF_FG = 4
const OFF_BG = 7
const OFF_FLAGS = 10
const OFF_WIDTH = 11
const OFF_HYPERLINK = 12
const OFF_GRAPHEME_LEN = 14
const OFF_ATTRS2 = 15

/**
 * Our `width` byte against main's `GhosttyCellWide`. Width 0 marks "no text of
 * its own": the trailing half of a wide glyph, and a spacer head (the padding
 * at the end of a row too narrow for the wide glyph that follows).
 */
const WIDTH_FOR_WIDE = new Uint8Array(4)
WIDTH_FOR_WIDE[abi.CELL_WIDE_NARROW] = 1
WIDTH_FOR_WIDE[abi.CELL_WIDE_WIDE] = 2
WIDTH_FOR_WIDE[abi.CELL_WIDE_SPACER_TAIL] = 0
WIDTH_FOR_WIDE[abi.CELL_WIDE_SPACER_HEAD] = 0

export interface ViewportReaderHandles {
  ex: abi.GhosttyMainExports
  term: number
}

/**
 * What the renderer and `readRows` depend on. `main/shim.ts` answers
 * `ghostty_render_state_get_viewport` by calling `update()` once a frame, then
 * `read(buf, cols, rows)`.
 */
export interface ViewportSource {
  /**
   * Rebuilds the snapshot, once a frame. Separate from `read` so a mid-frame
   * `readRows` sees the same grid as the cursor drawn beside it.
   */
  update(): void
  /** Packs `cols * rows` cells into `bufPtr` from the last `update`; returns
   *  cells written. */
  read(bufPtr: number, cols: number, rows: number): number
  dispose(): void
}

/**
 * Holds the render state and the two iterators across frames. They're
 * stateful handles: `render_state_update` refreshes the state in place and
 * the iterators are re-seeded from it each frame.
 */
export class MainViewportReader implements ViewportSource {
  private readonly ex: abi.GhosttyMainExports
  private readonly term: number
  /**
   * Public because the shim answers our ABI's separate `render_state_get_*`
   * calls (dimensions, cursor, default colors) from this same snapshot.
   */
  readonly state: number
  private readonly iterSlot: number
  private readonly cellsSlot: number
  private readonly scratch: number
  private readonly stylePtr: number
  private view: DataView

  constructor({ ex, term }: ViewportReaderHandles) {
    this.ex = ex
    this.term = term

    const stateSlot = ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(ex.ghostty_render_state_new(0, stateSlot), 'render_state_new')
    this.view = new DataView(ex.memory.buffer)
    this.state = this.view.getUint32(stateSlot, true)

    this.iterSlot = ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(ex.ghostty_render_state_row_iterator_new(0, this.iterSlot), 'row_iterator_new')
    this.cellsSlot = ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(ex.ghostty_render_state_row_cells_new(0, this.cellsSlot), 'row_cells_new')

    this.scratch = ex.ghostty_wasm_alloc(16)
    this.stylePtr = ex.ghostty_wasm_alloc(abi.STYLE_SIZE)
  }

  /** Re-made only when linear memory growth has detached the previous one. */
  private dv(): DataView {
    if (this.view.buffer !== this.ex.memory.buffer) {
      this.view = new DataView(this.ex.memory.buffer)
    }
    return this.view
  }

  /** The terminal's own default colors, for cells that carry none. */
  private defaultColors(): { fg: number; bg: number } {
    const { ex } = this
    let fg = 0xffffff
    let bg = 0x000000
    if (ex.ghostty_render_state_get(this.state, abi.RS_DATA_COLOR_FOREGROUND, this.scratch) === abi.GHOSTTY_SUCCESS) {
      const d = this.dv()
      fg = (d.getUint8(this.scratch) << 16) | (d.getUint8(this.scratch + 1) << 8) | d.getUint8(this.scratch + 2)
    }
    if (ex.ghostty_render_state_get(this.state, abi.RS_DATA_COLOR_BACKGROUND, this.scratch) === abi.GHOSTTY_SUCCESS) {
      const d = this.dv()
      bg = (d.getUint8(this.scratch) << 16) | (d.getUint8(this.scratch + 1) << 8) | d.getUint8(this.scratch + 2)
    }
    return { fg, bg }
  }

  /** Rebuilds the snapshot every subsequent read is answered from. */
  update(): void {
    abi.expectOk(this.ex.ghostty_render_state_update(this.state, this.term), 'render_state_update')
  }

  /**
   * Packs the whole viewport into `bufPtr` (room for `cols * rows` cells) from
   * the last `update`. The caller zeroes the buffer, so a short read leaves
   * blanks. Returns the number of cells written.
   */
  read(bufPtr: number, cols: number, rows: number): number {
    const { ex } = this
    // Wants the slot holding the handle, not the handle.
    abi.expectOk(
      ex.ghostty_render_state_get(this.state, abi.RS_DATA_ROW_ITERATOR, this.iterSlot),
      'get ROW_ITERATOR',
    )
    const iter = this.dv().getUint32(this.iterSlot, true)
    const { fg: defFg, bg: defBg } = this.defaultColors()

    let written = 0
    let y = 0
    // Bool, not a result: truthy means it advanced.
    while (y < rows && ex.ghostty_render_state_row_iterator_next(iter)) {
      abi.expectOk(
        ex.ghostty_render_state_row_get(iter, abi.RS_ROW_DATA_CELLS, this.cellsSlot),
        'row_get CELLS',
      )
      const cells = this.dv().getUint32(this.cellsSlot, true)

      // The row's raw cells in one call. The cells iterator still advances in
      // lockstep for the managed data only it reaches (styles, resolved colors,
      // grapheme lengths). Borrowed until the next `render_state_update`, so
      // re-fetched per row per frame.
      abi.expectOk(
        ex.ghostty_render_state_row_get(iter, abi.RS_ROW_DATA_CELLS_RAW, this.scratch),
        'row_get CELLS_RAW',
      )
      const rd = this.dv()
      const rawPtr = rd.getUint32(this.scratch + abi.CELLS_VIEW_OFF_PTR, true)
      const rawLen = rd.getUint32(this.scratch + abi.CELLS_VIEW_OFF_LEN, true)

      let x = 0
      while (x < cols && ex.ghostty_render_state_row_cells_next(cells)) {
        const at = bufPtr + (y * cols + x) * CELL_BYTES
        // A view shorter than the row would otherwise read neighboring memory.
        this.packCell(cells, at, defFg, defBg, x < rawLen ? rawPtr + x * abi.CELL_U64_BYTES : 0)
        x++
        written++
      }
      y++
    }
    return written
  }

  /**
   * One cell, into the 16 bytes at `at`. `rawAt` addresses this cell in the
   * row's borrowed `CELLS_RAW` view, or is 0 when the view didn't cover it, in
   * which case the raw value is fetched per cell.
   */
  private packCell(cells: number, at: number, defFg: number, defBg: number, rawAt: number): void {
    const { ex } = this

    let d = this.dv()
    if (rawAt === 0) {
      abi.expectOk(ex.ghostty_render_state_row_cells_get(cells, abi.RS_CELLS_RAW, this.scratch), 'cells_get RAW')
      d = this.dv()
    }
    const from = rawAt === 0 ? this.scratch : rawAt
    const lo = d.getUint32(from, true)
    const hi = d.getUint32(from + 4, true)
    const raw = (BigInt(hi) << 32n) | BigInt(lo)

    abi.expectOk(ex.ghostty_cell_get(raw, abi.CELL_DATA_CONTENT_TAG, this.scratch), 'cell_get CONTENT_TAG')
    d = this.dv()
    // The payload is a union: a codepoint, or a background color for a cell with
    // no text (otherwise an ED/EL blank becomes a control character).
    const hasText = abi.cellHasText(d.getUint32(this.scratch, true))
    d.setUint32(at + OFF_CODEPOINT, hasText ? abi.codepointOf(lo) : 0, true)

    abi.expectOk(ex.ghostty_cell_get(raw, abi.CELL_DATA_WIDE, this.scratch), 'cell_get WIDE')
    d = this.dv()
    d.setUint8(at + OFF_WIDTH, WIDTH_FOR_WIDE[d.getUint32(this.scratch, true) & 0x3])

    // A cell with no explicit color reports INVALID_VALUE; our ABI resolved
    // defaults in the core, so reconcile here.
    const fgRes = ex.ghostty_render_state_row_cells_get(cells, abi.RS_CELLS_FG_COLOR, this.scratch)
    d = this.dv()
    if (fgRes === abi.GHOSTTY_SUCCESS) {
      d.setUint8(at + OFF_FG, d.getUint8(this.scratch))
      d.setUint8(at + OFF_FG + 1, d.getUint8(this.scratch + 1))
      d.setUint8(at + OFF_FG + 2, d.getUint8(this.scratch + 2))
    } else {
      d.setUint8(at + OFF_FG, (defFg >> 16) & 0xff)
      d.setUint8(at + OFF_FG + 1, (defFg >> 8) & 0xff)
      d.setUint8(at + OFF_FG + 2, defFg & 0xff)
    }

    const bgRes = ex.ghostty_render_state_row_cells_get(cells, abi.RS_CELLS_BG_COLOR, this.scratch)
    d = this.dv()
    if (bgRes === abi.GHOSTTY_SUCCESS) {
      d.setUint8(at + OFF_BG, d.getUint8(this.scratch))
      d.setUint8(at + OFF_BG + 1, d.getUint8(this.scratch + 1))
      d.setUint8(at + OFF_BG + 2, d.getUint8(this.scratch + 2))
    } else {
      d.setUint8(at + OFF_BG, (defBg >> 16) & 0xff)
      d.setUint8(at + OFF_BG + 1, (defBg >> 8) & 0xff)
      d.setUint8(at + OFF_BG + 2, defBg & 0xff)
    }

    abi.expectOk(
      ex.ghostty_render_state_row_cells_get(cells, abi.RS_CELLS_GRAPHEMES_LEN, this.scratch),
      'cells_get GRAPHEMES_LEN',
    )
    d = this.dv()
    /**
     * Our field counts codepoints beyond the base; main's `GRAPHEMES_LEN`
     * includes the base (and is 0 for no text). Hence the floored subtract.
     * Consumers only test it against zero.
     */
    const gLen = d.getUint32(this.scratch, true)
    d.setUint8(at + OFF_GRAPHEME_LEN, gLen > 0 ? Math.min(gLen - 1, 0xff) : 0)

    abi.expectOk(
      ex.ghostty_render_state_row_cells_get(cells, abi.RS_CELLS_STYLE, this.stylePtr),
      'cells_get STYLE',
    )
    d = this.dv()
    const p = this.stylePtr
    const underline = d.getUint32(p + abi.STYLE_OFF_UNDERLINE_STYLE, true)
    let flags = 0
    if (d.getUint8(p + abi.STYLE_OFF_BOLD)) flags |= CELL_BOLD
    if (d.getUint8(p + abi.STYLE_OFF_ITALIC)) flags |= CELL_ITALIC
    if (d.getUint8(p + abi.STYLE_OFF_STRIKETHROUGH)) flags |= CELL_STRIKETHROUGH
    if (d.getUint8(p + abi.STYLE_OFF_INVERSE)) flags |= CELL_INVERSE
    if (d.getUint8(p + abi.STYLE_OFF_INVISIBLE)) flags |= CELL_INVISIBLE
    if (d.getUint8(p + abi.STYLE_OFF_BLINK)) flags |= CELL_BLINK
    if (d.getUint8(p + abi.STYLE_OFF_FAINT)) flags |= CELL_FAINT
    // `flags` keeps "underlined at all"; which underline lives in attrs2.
    if (underline !== 0) flags |= CELL_UNDERLINE
    d.setUint8(at + OFF_FLAGS, flags)

    let attrs2 = underline & CELL2_UNDERLINE_MASK
    if (d.getUint8(p + abi.STYLE_OFF_OVERLINE)) attrs2 |= CELL2_OVERLINE
    d.setUint8(at + OFF_ATTRS2, attrs2)

    // Not available from the iterator; see the header.
    d.setUint16(at + OFF_HYPERLINK, 0, true)
  }

  dispose(): void {
    const { ex } = this
    ex.ghostty_wasm_free(this.stylePtr, abi.STYLE_SIZE)
    ex.ghostty_wasm_free(this.scratch, 16)
    ex.ghostty_wasm_free_opaque(this.cellsSlot)
    ex.ghostty_wasm_free_opaque(this.iterSlot)
    ex.ghostty_render_state_free(this.state)
  }
}
