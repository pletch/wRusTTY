import { parseCellInto, CELL_BYTES, type WasmCellData } from './wasmBindings'
import { MAX_RUN_CELLS } from './GlyphAtlas'

/**
 * Finding the runs of cells to shape together. Canvas 2D does the shaping
 * (`calt` fires once a substitution's inputs share one `fillText` call); this
 * decides what goes into each call. Separate from the renderer so the break
 * rules are testable without GL.
 */

/**
 * The characters a run may be built from: what programming fonts form
 * ligatures out of. This alphabet, with `MAX_RUN_CELLS`, bounds the run
 * cache's key space; prose and paths don't touch it.
 *
 * Beyond the operators:
 *
 * - Punctuation the substitution tables reach: `...`, `?.`, `??`, `;;`, `%%`,
 *   `^=`, `$>`, `\\`, `#?`, `__`.
 * - `w`, only for `www`. No common word doubles a w, and pairs like `w.` shape
 *   to the same glyphs drawn separately, costing a slot but never a pixel.
 *
 * Brackets stay out: they'd buy `[|`, `|]`, `{|` and `#(` at the cost of a
 * slot for every `))`, `}}` and `){`.
 */
export const LIGATURE_CHARS = new Uint8Array(128)
for (const ch of '=<>-!&|:+*/~.?#$%^;\\_@w') LIGATURE_CHARS[ch.charCodeAt(0)] = 1

/** Scratch rows, one set per renderer, sized with the grid. */
export interface RunScratch {
  /** Each cell's run head column, or -1. */
  head: Int32Array
  /** Run length, written at the head only. */
  span: Int32Array
  /** Codepoints of the cells in a run, indexed by column. */
  cp: Int32Array
  /** 1 where a cell's contents are replaced and may not join a run. */
  brk: Uint8Array
  /** The underline the renderer adds from outside the cell's own flags. */
  linkState: Uint8Array
  /** Reused across both reads; nothing is held across a parse. */
  cell: WasmCellData
}

function eligible(cell: WasmCellData): boolean {
  return (
    cell.width === 1 &&
    cell.graphemeLen === 0 &&
    cell.codepoint < 128 &&
    LIGATURE_CHARS[cell.codepoint] === 1
  )
}

/**
 * Marks out the maximal runs in one row. A run breaks on anything that makes
 * one column look different: flags and the second attribute byte, resolved
 * colors, link state, and `brk` (the cursor's cell and hint labels). Breaking
 * under the cursor, as other terminals do, keeps the typed character under
 * the block. Selection and search highlights aren't breaks: they only tint
 * per-column backgrounds.
 */
export function computeRuns(
  view: DataView,
  baseOffset: number,
  valid: number,
  cols: number,
  out: RunScratch,
): void {
  const { head, span, cp, brk, linkState, cell } = out
  head.fill(-1, 0, cols)

  let c = 0
  while (c < cols && c < valid) {
    // One scratch cell for both reads: the head's values are copied to locals
    // before the inner loop overwrites it.
    const first = parseCellInto(view, baseOffset + c * CELL_BYTES, cell)
    if (brk[c] === 1 || !eligible(first)) {
      c++
      continue
    }
    const flags = first.flags
    const attrs2 = first.attrs2
    const fg = (first.fgR << 16) | (first.fgG << 8) | first.fgB
    const bg = (first.bgR << 16) | (first.bgG << 8) | first.bgB
    const link = linkState[c]
    cp[c] = first.codepoint

    let len = 1
    while (len < MAX_RUN_CELLS && c + len < cols && c + len < valid && brk[c + len] === 0) {
      const next = parseCellInto(view, baseOffset + (c + len) * CELL_BYTES, cell)
      if (
        !eligible(next) ||
        next.flags !== flags ||
        next.attrs2 !== attrs2 ||
        ((next.fgR << 16) | (next.fgG << 8) | next.fgB) !== fg ||
        ((next.bgR << 16) | (next.bgG << 8) | next.bgB) !== bg ||
        linkState[c + len] !== link
      ) {
        break
      }
      cp[c + len] = next.codepoint
      len++
    }

    if (len > 1) {
      for (let i = 0; i < len; i++) head[c + i] = c
      span[c] = len
    }
    // Lands on the cell that ended the run, which may start its own.
    c += len
  }
}
