/**
 * Fills a packed row of scrollback from ghostty `main`'s `grid_ref`, in the
 * 16-byte layout `ghostty_terminal_get_scrollback_line` produces. The
 * scrollback counterpart to `ViewportReader`: `readRows` and `WebGLRenderer`
 * consume the same layout, so only the source changes.
 *
 * ## Resolve once per row, then step `ref.x`
 *
 * Resolution is O(scrollback depth) (14 ns at row 0, 188 ns at row 39,540),
 * so it's done once per row and amortized over its cells
 * (`tools/parse-probes/search.mjs`).
 *
 * ## Colors are flattened here
 *
 * `grid_ref` gives the raw cell and style only, so this reproduces the render
 * iterator's color flattening:
 *
 * - **foreground** from the style only, palette indices resolved; no bold
 *   brightening, matching the render path.
 * - **background** from the cell's content tag first (an `ED`/`EL` blank
 *   carries its color there), then the style. The byte-identity test covers
 *   cleared regions, where getting this wrong shows.
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

const OFF_CODEPOINT = 0
const OFF_FG = 4
const OFF_BG = 7
const OFF_FLAGS = 10
const OFF_WIDTH = 11
const OFF_HYPERLINK = 12
const OFF_GRAPHEME_LEN = 14
const OFF_ATTRS2 = 15

/** Enough for any realistic cluster; longer ones still report their length. */
const GRAPHEME_SCRATCH = 32

const WIDTH_FOR_WIDE = new Uint8Array(4)
WIDTH_FOR_WIDE[abi.CELL_WIDE_NARROW] = 1
WIDTH_FOR_WIDE[abi.CELL_WIDE_WIDE] = 2
WIDTH_FOR_WIDE[abi.CELL_WIDE_SPACER_TAIL] = 0
WIDTH_FOR_WIDE[abi.CELL_WIDE_SPACER_HEAD] = 0

export interface ScrollbackReaderHandles {
  ex: abi.GhosttyMainExports
  term: number
}

/**
 * Which coordinate space a lookup is in. `SCREEN` counts from the top of
 * scrollback (`get_scrollback_line`'s numbering); `ACTIVE` from the top of
 * the active screen (`is_row_wrapped`, `render_state_get_grapheme`). Both
 * resolve through `grid_ref`.
 */
export const SPACE_SCREEN = abi.POINT_TAG_SCREEN
export const SPACE_ACTIVE = abi.POINT_TAG_ACTIVE

export class MainScrollbackReader {
  private readonly ex: abi.GhosttyMainExports
  private readonly term: number
  private readonly ptPtr: number
  private readonly refPtr: number
  private readonly cellPtr: number
  private readonly rowPtr: number
  private readonly scratch: number
  private readonly stylePtr: number
  private readonly palPtr: number
  private readonly gbufPtr: number
  private view: DataView
  /** Terminal defaults, refreshed per row rather than per cell. */
  private defFg = 0xffffff
  private defBg = 0x000000

  constructor({ ex, term }: ScrollbackReaderHandles) {
    this.ex = ex
    this.term = term
    this.view = new DataView(ex.memory.buffer)
    this.ptPtr = ex.ghostty_wasm_alloc(abi.POINT_SIZE)
    this.refPtr = ex.ghostty_wasm_alloc(abi.GRID_REF_SIZE)
    this.cellPtr = ex.ghostty_wasm_alloc(abi.CELL_U64_BYTES)
    this.rowPtr = ex.ghostty_wasm_alloc(8)
    this.scratch = ex.ghostty_wasm_alloc(16)
    this.stylePtr = ex.ghostty_wasm_alloc(abi.STYLE_SIZE)
    this.palPtr = ex.ghostty_wasm_alloc(abi.PALETTE_BYTES)
    this.gbufPtr = ex.ghostty_wasm_alloc(GRAPHEME_SCRATCH * 4)
  }

  private dv(): DataView {
    if (this.view.buffer !== this.ex.memory.buffer) {
      this.view = new DataView(this.ex.memory.buffer)
    }
    return this.view
  }

  private rgbAt(ptr: number): number {
    const d = this.dv()
    return (d.getUint8(ptr) << 16) | (d.getUint8(ptr + 1) << 8) | d.getUint8(ptr + 2)
  }

  /** Refreshes palette and default colors. Cheap, and done once per row. */
  private refreshColors(): void {
    const { ex } = this
    // Fills the palette in place.
    ex.ghostty_terminal_get(this.term, abi.T_DATA_COLOR_PALETTE, this.palPtr)
    if (ex.ghostty_terminal_get(this.term, abi.T_DATA_COLOR_FOREGROUND, this.scratch) === abi.GHOSTTY_SUCCESS) {
      this.defFg = this.rgbAt(this.scratch)
    }
    if (ex.ghostty_terminal_get(this.term, abi.T_DATA_COLOR_BACKGROUND, this.scratch) === abi.GHOSTTY_SUCCESS) {
      this.defBg = this.rgbAt(this.scratch)
    }
  }

  private paletteColor(index: number): number {
    return this.rgbAt(this.palPtr + (index & 0xff) * abi.COLOR_RGB_BYTES)
  }

  /** A style color slot, or -1 for "none". */
  private styleColor(tagOff: number, valueOff: number): number {
    const d = this.dv()
    const tag = d.getUint32(this.stylePtr + tagOff, true)
    if (tag === abi.STYLE_COLOR_PALETTE) return this.paletteColor(d.getUint8(this.stylePtr + valueOff))
    if (tag === abi.STYLE_COLOR_RGB) return this.rgbAt(this.stylePtr + valueOff)
    return -1
  }

  /**
   * Points the ref at (x, y) in `tag`'s space. Zeroes the whole 24-byte point
   * first: a stale byte in the gap between tag and value would be read as part
   * of the union (`abi.manifest.test.ts` pins the size).
   */
  private resolve(tag: number, x: number, y: number): boolean {
    const d = this.dv()
    for (let i = 0; i < abi.POINT_SIZE; i += 4) d.setUint32(this.ptPtr + i, 0, true)
    d.setUint32(this.ptPtr + abi.POINT_OFF_TAG, tag, true)
    d.setUint32(this.ptPtr + abi.POINT_OFF_X, x, true)
    d.setUint32(this.ptPtr + abi.POINT_OFF_Y, y, true)
    return this.ex.ghostty_terminal_grid_ref(this.term, this.ptPtr, this.refPtr) === abi.GHOSTTY_SUCCESS
  }

  /**
   * Packs row `absY` (from the top of scrollback) into `bufPtr`. Returns false
   * if the row can't be resolved, leaving the caller's blank intact.
   */
  readRow(bufPtr: number, absY: number, cols: number, tag: number = SPACE_SCREEN): boolean {
    this.refreshColors()
    if (!this.resolve(tag, 0, absY)) return false

    for (let x = 0; x < cols; x++) {
      // Step the row by writing x back into the ref.
      this.dv().setUint16(this.refPtr + abi.GRID_REF_OFF_X, x, true)
      this.packCell(bufPtr + x * CELL_BYTES)
    }
    return true
  }

  private packCell(at: number): void {
    const { ex } = this
    if (ex.ghostty_grid_ref_cell(this.refPtr, this.cellPtr) !== abi.GHOSTTY_SUCCESS) return

    let d = this.dv()
    const lo = d.getUint32(this.cellPtr, true)
    const hi = d.getUint32(this.cellPtr + 4, true)
    const raw = (BigInt(hi) << 32n) | BigInt(lo)

    abi.expectOk(ex.ghostty_cell_get(raw, abi.CELL_DATA_CONTENT_TAG, this.scratch), 'cell_get CONTENT_TAG')
    const contentTag = this.dv().getUint32(this.scratch, true)

    // The payload is a union: a codepoint, or a background color for a cell with
    // no text (otherwise an ED/EL blank becomes a control character).
    d = this.dv()
    d.setUint32(at + OFF_CODEPOINT, abi.cellHasText(contentTag) ? abi.codepointOf(lo) : 0, true)

    abi.expectOk(ex.ghostty_cell_get(raw, abi.CELL_DATA_WIDE, this.scratch), 'cell_get WIDE')
    d = this.dv()
    d.setUint8(at + OFF_WIDTH, WIDTH_FOR_WIDE[d.getUint32(this.scratch, true) & 0x3])

    const hasStyle = ex.ghostty_grid_ref_style(this.refPtr, this.stylePtr) === abi.GHOSTTY_SUCCESS

    // Foreground: style only, palette resolved, no bold brightening.
    let fg = this.defFg
    if (hasStyle) {
      const c = this.styleColor(abi.STYLE_OFF_FG_TAG, abi.STYLE_OFF_FG_VALUE)
      if (c >= 0) fg = c
    }

    // Background: the content tag wins, since an ED/EL blank has no style.
    let bg = this.defBg
    if (contentTag === abi.CELL_CONTENT_BG_COLOR_PALETTE) {
      abi.expectOk(ex.ghostty_cell_get(raw, abi.CELL_DATA_COLOR_PALETTE, this.scratch), 'cell_get COLOR_PALETTE')
      bg = this.paletteColor(this.dv().getUint8(this.scratch))
    } else if (contentTag === abi.CELL_CONTENT_BG_COLOR_RGB) {
      abi.expectOk(ex.ghostty_cell_get(raw, abi.CELL_DATA_COLOR_RGB, this.scratch), 'cell_get COLOR_RGB')
      bg = this.rgbAt(this.scratch)
    } else if (hasStyle) {
      const c = this.styleColor(abi.STYLE_OFF_BG_TAG, abi.STYLE_OFF_BG_VALUE)
      if (c >= 0) bg = c
    }

    d = this.dv()
    d.setUint8(at + OFF_FG, (fg >> 16) & 0xff)
    d.setUint8(at + OFF_FG + 1, (fg >> 8) & 0xff)
    d.setUint8(at + OFF_FG + 2, fg & 0xff)
    d.setUint8(at + OFF_BG, (bg >> 16) & 0xff)
    d.setUint8(at + OFF_BG + 1, (bg >> 8) & 0xff)
    d.setUint8(at + OFF_BG + 2, bg & 0xff)

    let flags = 0
    let attrs2 = 0
    if (hasStyle) {
      const p = this.stylePtr
      const underline = d.getUint32(p + abi.STYLE_OFF_UNDERLINE_STYLE, true)
      if (d.getUint8(p + abi.STYLE_OFF_BOLD)) flags |= CELL_BOLD
      if (d.getUint8(p + abi.STYLE_OFF_ITALIC)) flags |= CELL_ITALIC
      if (d.getUint8(p + abi.STYLE_OFF_STRIKETHROUGH)) flags |= CELL_STRIKETHROUGH
      if (d.getUint8(p + abi.STYLE_OFF_INVERSE)) flags |= CELL_INVERSE
      if (d.getUint8(p + abi.STYLE_OFF_INVISIBLE)) flags |= CELL_INVISIBLE
      if (d.getUint8(p + abi.STYLE_OFF_BLINK)) flags |= CELL_BLINK
      if (d.getUint8(p + abi.STYLE_OFF_FAINT)) flags |= CELL_FAINT
      if (underline !== 0) flags |= CELL_UNDERLINE
      attrs2 = underline & CELL2_UNDERLINE_MASK
      if (d.getUint8(p + abi.STYLE_OFF_OVERLINE)) attrs2 |= CELL2_OVERLINE
    }
    d.setUint8(at + OFF_FLAGS, flags)
    d.setUint8(at + OFF_ATTRS2, attrs2)

    /**
     * Counts codepoints beyond the base, where main counts the base too. A null
     * buffer reports nothing, so it gets a real one; an overlong cluster still
     * reports its required length.
     */
    ex.ghostty_grid_ref_graphemes(this.refPtr, this.gbufPtr, GRAPHEME_SCRATCH, this.scratch)
    const n = this.dv().getUint32(this.scratch, true)
    this.dv().setUint8(at + OFF_GRAPHEME_LEN, n > 0 ? Math.min(n - 1, 0xff) : 0)

    // No hyperlink id in this ABI; see ViewportReader's header.
    this.dv().setUint16(at + OFF_HYPERLINK, 0, true)
  }

  /**
   * Writes the cell's grapheme cluster as u32 codepoints, base first, matching
   * `ghostty_terminal_get_scrollback_grapheme`. Returns how many were written.
   */
  graphemes(absY: number, x: number, bufPtr: number, cap: number, tag: number = SPACE_SCREEN): number {
    const { ex } = this
    if (!this.resolve(tag, x, absY)) return 0
    if (ex.ghostty_grid_ref_graphemes(this.refPtr, bufPtr, cap, this.scratch) !== abi.GHOSTTY_SUCCESS) return 0
    return Math.min(this.dv().getUint32(this.scratch, true), cap)
  }

  /**
   * Whether the row at `y` continues the row above it (our `is_row_wrapped`,
   * what `logicalLines` joins on). That's `ROW_DATA_WRAP_CONTINUATION`, not
   * `ROW_DATA_WRAP`, which marks the other end and would shift joins up a row.
   *
   * The row is passed to `row_get` by value (an i64), hence the BigInt.
   */
  isRowWrapped(y: number, tag: number = SPACE_SCREEN): boolean {
    const { ex } = this
    if (!this.resolve(tag, 0, y)) return false
    if (ex.ghostty_grid_ref_row(this.refPtr, this.rowPtr) !== abi.GHOSTTY_SUCCESS) return false
    const d = this.dv()
    const row = (BigInt(d.getUint32(this.rowPtr + 4, true)) << 32n) | BigInt(d.getUint32(this.rowPtr, true))
    if (ex.ghostty_row_get(row, abi.ROW_DATA_WRAP_CONTINUATION, this.scratch) !== abi.GHOSTTY_SUCCESS) {
      return false
    }
    return this.dv().getUint8(this.scratch) !== 0
  }

  dispose(): void {
    const { ex } = this
    ex.ghostty_wasm_free(this.gbufPtr, GRAPHEME_SCRATCH * 4)
    ex.ghostty_wasm_free(this.palPtr, abi.PALETTE_BYTES)
    ex.ghostty_wasm_free(this.stylePtr, abi.STYLE_SIZE)
    ex.ghostty_wasm_free(this.scratch, 16)
    ex.ghostty_wasm_free(this.rowPtr, 8)
    ex.ghostty_wasm_free(this.cellPtr, abi.CELL_U64_BYTES)
    ex.ghostty_wasm_free(this.refPtr, abi.GRID_REF_SIZE)
    ex.ghostty_wasm_free(this.ptPtr, abi.POINT_SIZE)
  }
}
