import { parseCellInto, CELL_BYTES, type WasmCellData } from './wasmBindings'
import { MAX_RUN_CELLS } from './GlyphAtlas'

/**
 * Finding the runs of cells that should be shaped together, which is the whole
 * of the ligature machinery on this side of the atlas: `fillText` does the
 * shaping, and this decides what gets handed to it in one call.
 *
 * Canvas 2D runs the browser's full shaping stack, so `calt` fires as soon as
 * a substitution has both of its inputs in the same call. Drawing one cell at
 * a time is the only reason ligatures never happened here; nothing was
 * disabling them.
 *
 * Kept out of the renderer because it is the part with the interesting
 * decisions in it — what breaks a run, and what deliberately does not — and
 * because those are worth testing without a GL context.
 */

/**
 * The characters a run may be built from: the ASCII operators every
 * ligature-carrying programming font forms its substitutions out of.
 *
 * Keeping the set small is what bounds the run cache. A run's key is its own
 * text, so unlike a codepoint it has no ceiling from the character repertoire;
 * restricting the alphabet is what keeps a path, a word or a column of prose
 * from ever costing a run slot.
 */
export const LIGATURE_CHARS = new Uint8Array(128)
for (const ch of '=<>-!&|:+*/~') LIGATURE_CHARS[ch.charCodeAt(0)] = 1

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
 * Marks out the maximal runs in one row.
 *
 * A run breaks on anything that would make one column of it look different
 * from another: the flags and the second attribute byte, the resolved colours,
 * the link state, and whatever `brk` marks — the cursor's own cell and any
 * hint label, both of which replace what the cell holds. Breaking under the
 * cursor is what other terminals do, and it means the character you typed is
 * what sits under the block rather than a slice of the ligature it formed.
 *
 * Selection and search highlighting are deliberately *not* breaks. Those only
 * tint a background, and every column carries its own background in the
 * instance data, so a sliced ligature under a selection is already right.
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
    // One scratch cell for both reads: everything wanted from the head is
    // copied into locals immediately below, before the inner loop parses over
    // the top of it.
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
    // Lands exactly on the cell that ended the run, which may well start one
    // of its own — a style change mid-operator is a break, not a skip.
    c += len
  }
}
