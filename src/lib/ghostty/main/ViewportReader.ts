/**
 * Fills the renderer's packed cell buffer from ghostty `main`'s row/cell
 * iterator, in the exact 16-byte layout `parseCellInto` already reads.
 *
 * ## Why this shape rather than rewriting the renderer
 *
 * `WebGLRenderer.updateStaticGrid` and `GhosttyEngine.readRows` do not consume
 * the ABI — they consume a packed buffer of `CELL_BYTES` cells and a `DataView`
 * over it. That buffer, not `get_viewport`, is the real contract. Keeping it and
 * swapping only who fills it means the renderer, the search path, links,
 * selection and mark mode are all untouched by the port, and the switch between
 * ABIs is one call site rather than a rewrite of everything downstream.
 *
 * It also makes the port checkable in a way a rewrite would not be: two fillers
 * producing the same bytes for the same input is a far stronger statement than
 * two renderers producing similar-looking screens, and it is asserted directly
 * in `ViewportReader.test.ts`.
 *
 * The cost used to be that this could not amortise anything `get_viewport` does
 * in one call — measured (`tools/parse-probes/iter.mjs`) at 1.4x-2.5x of a
 * 0.21 ms worst case, against an 8.3 ms frame, with skipping clean rows going
 * the other way at 0.05x-0.14x. The handles are held across frames here because
 * allocating them per frame would cost more than the difference.
 *
 * **The `6b22215c` pin narrows that.** `RS_ROW_DATA_CELLS_RAW` hands back the
 * row's packed cells as one borrowed run, so the raw value no longer costs a
 * call per cell. On codepoints alone that mode measures **0.1x** of the batched
 * `get_viewport` — but this reader is not codepoint-only, so it keeps the cells
 * iterator for styles, resolved colours and grapheme lengths and banks one
 * saved call out of the per-cell handful rather than the full 10x.
 *
 * ## What it cannot carry
 *
 * `hyperlinkId` (bytes 12-13) is always written as 0. Our ABI packs a real id;
 * main's render path exposes only a `HAS_HYPERLINK` bool, with the URI reachable
 * through `grid_ref` rather than the iterator. Nothing outside `wasmBindings.ts`
 * reads the field today — `LinkController` works off `readRows` text — so this
 * is recorded rather than solved. It is the one place the two fillers are
 * allowed to differ, and the parity test excludes exactly those two bytes.
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
 * Our `width` byte against main's `GhosttyCellWide`.
 *
 * The packed layout uses width as both a display width and a marker: 0 means
 * "no text of its own", which is how every consumer recognises the trailing
 * half of a wide glyph. A spacer *head* — the padding cell at the end of a row
 * too narrow for the wide glyph that follows — is likewise not drawn, so it
 * takes 0 as well.
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
 * What the renderer and `readRows` actually depend on, stated once.
 *
 * `WebGLRenderer.updateStaticGrid` and `GhosttyEngine.readRows` reach for
 * `ghostty_render_state_get_viewport`, and neither had to change: `main/shim.ts`
 * answers that call by driving this reader —
 *
 *   ghostty_render_state_get_viewport(term, buf, cols * rows)
 *   -> source.update() once a frame, then source.read(buf, cols, rows)
 *
 * — which is why the port reached the renderer as a swapped binary rather than
 * as a diff. `update` is separate from `read` because our ABI separates them:
 * the cells, the dimensions and the cursor all come off one snapshot, and
 * `readRows` reads that snapshot again mid-frame without rebuilding it.
 */
export interface ViewportSource {
  /**
   * Rebuilds the snapshot. Separate from `read` because our ABI separates them
   * — `render_state_update` is called once a frame, and the cursor position,
   * the dimensions and the cells are then all read off that one snapshot. A
   * reader that updated on every read would answer a mid-frame `readRows` from
   * a newer grid than the cursor drawn beside it.
   */
  update(): void
  /** Packs `cols * rows` cells into `bufPtr` from the last `update`; returns
   *  cells written. */
  read(bufPtr: number, cols: number, rows: number): number
  dispose(): void
}

/**
 * Holds the render state and the two iterators across frames.
 *
 * They are stateful handles, not values: `render_state_update` refreshes the
 * state in place and the iterators are re-seeded from it each frame, so
 * creating them once is both correct and the only way the per-frame cost stays
 * near the batched read's.
 */
export class MainViewportReader implements ViewportSource {
  private readonly ex: abi.GhosttyMainExports
  private readonly term: number
  /**
   * Public because the render state answers far more than the cells: the
   * dimensions, the cursor and the default colours all come off this handle,
   * and our ABI exposes them as separate `render_state_get_*` calls that the
   * shim has to satisfy from the same snapshot this reader packed.
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

  /** The terminal's own default colours, for cells that carry none. */
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
   * Packs the whole viewport into `bufPtr`, from the last `update`.
   *
   * `bufPtr` must have room for `cols * rows` cells. The caller zeroes it, the
   * same way `updateStaticGrid` already does — a short read must leave blanks
   * rather than the previous frame's cells, and that is the caller's business
   * because it owns the buffer's lifetime.
   *
   * Returns the number of cells written.
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

      // The row's packed cells in one call, instead of one `CELLS_RAW` get per
      // cell. The cells iterator is still advanced in lockstep below because
      // styles, resolved colours and grapheme lengths are managed data that
      // only it can reach — this replaces the *raw* fetch, not the iterator.
      //
      // Borrowed and frame-local: valid only until the next `render_state_update`,
      // which is why it is re-fetched per row per frame rather than cached.
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
        // Guard rather than trust: a view shorter than the row would otherwise
        // read whatever follows it in linear memory as cell data.
        this.packCell(cells, at, defFg, defBg, x < rawLen ? rawPtr + x * abi.CELL_U64_BYTES : 0)
        x++
        written++
      }
      y++
    }
    return written
  }

  /**
   * One cell, into the 16 bytes at `at`.
   *
   * `rawAt` addresses this cell inside the row's borrowed `CELLS_RAW` view, or
   * is 0 when the view did not cover it — in which case the raw value is
   * fetched per cell the old way. Reading it from the view is what makes the
   * bulk path worth having; the fallback keeps a short view from reading
   * neighbouring memory as cell data.
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
    // The payload is a union — a codepoint, or a background colour for a cell
    // with no text. Unpacking it unconditionally turns a blank painted by
    // ED/EL into a control character.
    const hasText = abi.cellHasText(d.getUint32(this.scratch, true))
    d.setUint32(at + OFF_CODEPOINT, hasText ? abi.codepointOf(lo) : 0, true)

    abi.expectOk(ex.ghostty_cell_get(raw, abi.CELL_DATA_WIDE, this.scratch), 'cell_get WIDE')
    d = this.dv()
    d.setUint8(at + OFF_WIDTH, WIDTH_FOR_WIDE[d.getUint32(this.scratch, true) & 0x3])

    // A cell with no explicit colour reports INVALID_VALUE and expects the
    // caller to supply its own default; our ABI resolves that inside the core,
    // so this is where the two representations are reconciled.
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
     * Our field counts the codepoints *beyond* the base; main's `GRAPHEMES_LEN`
     * includes the base, and reports 0 for a cell with no text at all. So a
     * plain `a` is 1 there and 0 here, and `e`+combining-acute is 2 there and 1
     * here — hence the subtract, floored rather than allowed to go negative on
     * the empty case.
     *
     * Consumers only ever test this against zero (`readRows` uses it to decide
     * whether to fetch the cluster), so an off-by-one is invisible in behaviour
     * and shows up only in a byte comparison. It was caught exactly that way.
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

    // Not available from the iterator — see the header.
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
