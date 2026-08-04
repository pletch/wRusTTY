/**
 * Fills a packed row of scrollback from ghostty `main`'s `grid_ref`, in the same
 * 16-byte layout `ghostty_terminal_get_scrollback_line` produces.
 *
 * The other half of the read path. `GhosttyEngine.readRows` takes viewport rows
 * from the batched buffer and scrollback rows one at a time, and
 * `WebGLRenderer` does the same when the viewport is scrolled up; both consume
 * the identical packed layout, so this keeps that contract and swaps only the
 * source — exactly as `ViewportReader` does for the viewport.
 *
 * ## Resolve once per row, then step `ref.x`
 *
 * `GhosttyGridRef` is a plain struct in caller memory, so a row is walked by
 * writing `x` and asking again. This is not a micro-optimisation: resolution is
 * O(scrollback depth) — 14 ns at row 0, 188 ns at row 39,540 — so one resolve
 * per row amortises over `cols` cells, while one per cell makes a full search
 * pass 9x slower than today's. Measured in `tools/parse-probes/search.mjs`,
 * where this shape comes out at **0.8x-0.9x** the row-at-a-time read it
 * replaces, holding to 0.86x at 100k rows.
 *
 * ## Colours have to be flattened here
 *
 * The render iterator has `FG_COLOR`/`BG_COLOR` keys that flatten a cell's
 * colour from its three possible sources. `grid_ref` has no such accessor — it
 * gives the raw cell and the style and nothing else — so this reader reproduces
 * that flattening itself:
 *
 * - **foreground** comes only from the style, palette indices resolved through
 *   the terminal's palette. Bold brightening is deliberately not applied, which
 *   matches what the render path documents.
 * - **background** takes the cell's own content tag first (a blank cell painted
 *   by `ED`/`EL` carries its colour there, not in a style), then the style.
 *
 * Getting that order wrong is invisible on ordinary text and shows up only on
 * cleared regions, which is why the byte-identity test covers them explicitly.
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
 * Which coordinate space a lookup is in.
 *
 * `SCREEN` counts from the top of scrollback — the numbering
 * `get_scrollback_line` uses. `ACTIVE` counts from the top of the active
 * screen, which is what our `is_row_wrapped` and `render_state_get_grapheme`
 * take. Both resolve through the same `grid_ref`, so the viewport/scrollback
 * split in our ABI collapses into one path here; only the tag differs.
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
    this.ptPtr = ex.ghostty_wasm_alloc_u8_array(abi.POINT_SIZE)
    this.refPtr = ex.ghostty_wasm_alloc_u8_array(abi.GRID_REF_SIZE)
    this.cellPtr = ex.ghostty_wasm_alloc_u8_array(abi.CELL_U64_BYTES)
    this.rowPtr = ex.ghostty_wasm_alloc_u8_array(8)
    this.scratch = ex.ghostty_wasm_alloc_u8_array(16)
    this.stylePtr = ex.ghostty_wasm_alloc_u8_array(abi.STYLE_SIZE)
    this.palPtr = ex.ghostty_wasm_alloc_u8_array(abi.PALETTE_BYTES)
    this.gbufPtr = ex.ghostty_wasm_alloc_u8_array(GRAPHEME_SCRATCH * 4)
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

  /** Refreshes palette and default colours. Cheap, and done once per row. */
  private refreshColors(): void {
    const { ex } = this
    if (ex.ghostty_terminal_get(this.term, abi.T_DATA_COLOR_PALETTE, this.palPtr) === abi.GHOSTTY_SUCCESS) {
      // filled in place
    }
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

  /** A style colour slot, or -1 for "none". */
  private styleColor(tagOff: number, valueOff: number): number {
    const d = this.dv()
    const tag = d.getUint32(this.stylePtr + tagOff, true)
    if (tag === abi.STYLE_COLOR_PALETTE) return this.paletteColor(d.getUint8(this.stylePtr + valueOff))
    if (tag === abi.STYLE_COLOR_RGB) return this.rgbAt(this.stylePtr + valueOff)
    return -1
  }

  /**
   * Points the ref at (x, y) in `tag`'s coordinate space.
   *
   * Zeroes the whole point first: it is 16 bytes with a hole between the tag
   * and the value, and a stale byte in there is read as part of the union.
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
   * Packs row `absY` — counted from the top of scrollback, the same numbering
   * `get_scrollback_line` uses — into `bufPtr`.
   *
   * Returns false when the row cannot be resolved, leaving the buffer alone so
   * the caller's blank stays a blank rather than becoming stale content.
   */
  readRow(bufPtr: number, absY: number, cols: number, tag: number = SPACE_SCREEN): boolean {
    this.refreshColors()
    if (!this.resolve(tag, 0, absY)) return false

    for (let x = 0; x < cols; x++) {
      // Stepping the row: write x back into the ref rather than resolving again.
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

    // The packed cell's payload is a union: a codepoint, *or* a background
    // colour for a cell with no text. Unpacking it unconditionally turns a
    // blank painted by ED/EL into a control character — a cleared row with
    // bg 0x445566 came back with codepoint 1.
    d = this.dv()
    d.setUint32(at + OFF_CODEPOINT, abi.cellHasText(contentTag) ? abi.codepointOf(lo) : 0, true)

    abi.expectOk(ex.ghostty_cell_get(raw, abi.CELL_DATA_WIDE, this.scratch), 'cell_get WIDE')
    d = this.dv()
    d.setUint8(at + OFF_WIDTH, WIDTH_FOR_WIDE[d.getUint32(this.scratch, true) & 0x3])

    const hasStyle = ex.ghostty_grid_ref_style(this.refPtr, this.stylePtr) === abi.GHOSTTY_SUCCESS

    // Foreground: style only, palette resolved. Bold brightening deliberately
    // not applied, matching the render path.
    let fg = this.defFg
    if (hasStyle) {
      const c = this.styleColor(abi.STYLE_OFF_FG_TAG, abi.STYLE_OFF_FG_VALUE)
      if (c >= 0) fg = c
    }

    // Background: the cell's own content tag wins over the style, because a
    // blank painted by ED/EL carries its colour there and has no style at all.
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
     * Counts codepoints beyond the base, where main counts the base too.
     *
     * Asked with a null buffer and zero capacity this reports nothing — it does
     * not treat "just tell me the length" as a query — so it gets a real
     * buffer. A cluster longer than the scratch is still counted correctly:
     * the call writes the required length even when it has no room, so the
     * count is read whether or not it succeeded.
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
   * Whether the row at `y` **continues the row above it**, which is what our
   * `is_row_wrapped` answers and what `logicalLines` joins on.
   *
   * So it is `ROW_DATA_WRAP_CONTINUATION`, not `ROW_DATA_WRAP` — the pair are
   * the two ends of the same wrap, and taking the other one shifts every joined
   * line up by a row. Both answer plausibly on a wrapped line, which is why the
   * mistake survives until something is compared: the vendored build reports
   * row 1 of a two-row line, `ROW_DATA_WRAP` reports row 0.
   *
   * The row comes back as a `GhosttyRow` in caller memory and is then passed to
   * `row_get` **by value**, i.e. as an i64, hence the BigInt.
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
    ex.ghostty_wasm_free_u8_array(this.gbufPtr, GRAPHEME_SCRATCH * 4)
    ex.ghostty_wasm_free_u8_array(this.palPtr, abi.PALETTE_BYTES)
    ex.ghostty_wasm_free_u8_array(this.stylePtr, abi.STYLE_SIZE)
    ex.ghostty_wasm_free_u8_array(this.scratch, 16)
    ex.ghostty_wasm_free_u8_array(this.rowPtr, 8)
    ex.ghostty_wasm_free_u8_array(this.cellPtr, abi.CELL_U64_BYTES)
    ex.ghostty_wasm_free_u8_array(this.refPtr, abi.GRID_REF_SIZE)
    ex.ghostty_wasm_free_u8_array(this.ptPtr, abi.POINT_SIZE)
  }
}
