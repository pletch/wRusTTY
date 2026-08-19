/**
 * The same `GridSnapshot` as `gridSnapshot.ts`, read through ghostty **main**'s
 * render API instead of the vendored build's batched `get_viewport`.
 *
 * This is the oracle for the port. `gridSnapshot.ts` compares our engine against
 * xterm.js to catch VT regressions; this compares the *same core* through two
 * different ABIs, which is a much sharper instrument — any difference is the
 * port's own doing, because both sides are the same terminal implementation
 * fed identical bytes. Nothing else can distinguish a correct port from a
 * plausible one, and almost every trap found so far (`GhosttyPoint`'s offsets,
 * the palette stride, the blank scrollback reads) produced *plausible* output.
 *
 * Deliberately unoptimised. It fetches per cell with separate calls where the
 * real renderer would use `get_multi` and skip clean rows, because a parity
 * oracle that shares the optimisations of the thing it checks cannot catch a
 * bug in them. Speed is `iter.mjs`'s job.
 *
 * Requires a build at the pin — see `../lib/ghostty/main/vendor-main/README.md`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as abi from '../lib/ghostty/main/abi'
import {
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
} from '../lib/ghostty/wasmBindings'
import { PALETTE_256, DEFAULT_FG, DEFAULT_BG } from './gridPalette'
import type { GridSnapshot, SnapshotInput } from './gridSnapshot'

const here = dirname(fileURLToPath(import.meta.url))
const MAIN_WASM =
  process.env.GHOSTTY_MAIN_WASM ?? join(here, '../lib/ghostty/main/vendor-main/ghostty-vt.wasm')

let cached: WebAssembly.Module | null = null
/** Compiled once per run; each snapshot instantiates its own terminal. */
function moduleOnce(): WebAssembly.Module {
  cached ??= new WebAssembly.Module(Uint8Array.from(readFileSync(MAIN_WASM)))
  return cached
}

/** Whether a comparison build is available; suites skip themselves without one. */
export function hasMainBuild(): boolean {
  try {
    readFileSync(MAIN_WASM)
    return true
  } catch {
    return false
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/**
 * Mirrors `gridSnapshot.ts`'s `trimRow` exactly, which means **not** truncating
 * `attrs2` even though the other three are truncated.
 *
 * That asymmetry is real and load-bearing here: the vendored snapshot leaves
 * attrs2 at full row width while trimming fg/bg/flags to the trimmed string.
 * Truncating it here too produced arrays that agreed on every value and
 * differed only in length, which reads as a colour/attribute divergence and
 * sends you looking in the wrong place entirely.
 */
function trimRow(line: string, fg: number[], bg: number[], flags: number[]) {
  const trimmed = line.replace(/\s+$/, '')
  fg.length = trimmed.length
  bg.length = trimmed.length
  flags.length = trimmed.length
  return trimmed
}

export function snapshotViaGhosttyMain(input: SnapshotInput): GridSnapshot {
  const { cols, rows } = input
  const inst = new WebAssembly.Instance(moduleOnce(), { env: { log: () => {} } })
  const ex = inst.exports as unknown as abi.GhosttyMainExports
  const mem = ex.memory
  let view = new DataView(mem.buffer)
  const dv = () => {
    if (view.buffer !== mem.buffer) view = new DataView(mem.buffer)
    return view
  }
  const slotValue = (slot: number) => dv().getUint32(slot, true)

  const termSlot = ex.ghostty_wasm_alloc_opaque()
  abi.expectOk(ex.ghostty_terminal_new(0, termSlot, cols, rows), 'terminal_new')
  const term = slotValue(termSlot)

  // Both engines must be pinned to one palette before any colour is comparable
  // — see gridPalette.ts. The value is the array pointer itself, not a pointer
  // to it: passing the latter succeeds and leaves every colour black.
  const palPtr = ex.ghostty_wasm_alloc(abi.PALETTE_BYTES)
  const bytes = new Uint8Array(mem.buffer)
  // The whole 256 table, not the 16 the vendored side is configured with: that
  // ABI takes 16 and lets the core derive the cube and greys, whereas this one
  // takes all 256 explicitly. `PALETTE_256` is the table the core would have
  // derived, so the two end up equivalent — cycling the 16 does not, and shows
  // up only once a test uses an index above 15.
  for (let i = 0; i < abi.PALETTE_ENTRIES; i++) {
    const rgb = PALETTE_256[i]
    const at = palPtr + i * abi.COLOR_RGB_BYTES
    bytes[at] = (rgb >> 16) & 0xff
    bytes[at + 1] = (rgb >> 8) & 0xff
    bytes[at + 2] = rgb & 0xff
  }
  abi.expectOk(ex.ghostty_terminal_set(term, abi.T_OPT_COLOR_PALETTE, palPtr), 'set palette')

  const write = (data: Uint8Array) => {
    const p = ex.ghostty_wasm_alloc(data.length)
    new Uint8Array(mem.buffer).set(data, p)
    ex.ghostty_terminal_vt_write(term, p, data.length) // returns void
    ex.ghostty_wasm_free(p, data.length)
  }
  if (input.setup) write(input.setup)
  write(concat(input.events))

  const stateSlot = ex.ghostty_wasm_alloc_opaque()
  abi.expectOk(ex.ghostty_render_state_new(0, stateSlot), 'render_state_new')
  const state = slotValue(stateSlot)
  abi.expectOk(ex.ghostty_render_state_update(state, term), 'render_state_update')

  const iterSlot = ex.ghostty_wasm_alloc_opaque()
  abi.expectOk(ex.ghostty_render_state_row_iterator_new(0, iterSlot), 'row_iterator_new')
  // `get` wants the slot holding the handle, not the handle.
  abi.expectOk(ex.ghostty_render_state_get(state, abi.RS_DATA_ROW_ITERATOR, iterSlot), 'get ROW_ITERATOR')
  const iter = slotValue(iterSlot)

  const cellsSlot = ex.ghostty_wasm_alloc_opaque()
  abi.expectOk(ex.ghostty_render_state_row_cells_new(0, cellsSlot), 'row_cells_new')

  const out = ex.ghostty_wasm_alloc(16)
  const stylePtr = ex.ghostty_wasm_alloc(abi.STYLE_SIZE)

  const outRows: string[] = []
  const outFg: number[][] = []
  const outBg: number[][] = []
  const outFlags: number[][] = []
  const outAttrs2: number[][] = []

  // `_next` returns a bool, not a result: truthy means it advanced.
  while (ex.ghostty_render_state_row_iterator_next(iter)) {
    abi.expectOk(ex.ghostty_render_state_row_get(iter, abi.RS_ROW_DATA_CELLS, cellsSlot), 'row_get CELLS')
    const cells = slotValue(cellsSlot)

    let line = ''
    const fg: number[] = []
    const bg: number[] = []
    const flags: number[] = []
    const attrs2: number[] = []

    while (ex.ghostty_render_state_row_cells_next(cells)) {
      abi.expectOk(ex.ghostty_render_state_row_cells_get(cells, abi.RS_CELLS_RAW, out), 'cells_get RAW')
      const lo = dv().getUint32(out, true)
      const hi = dv().getUint32(out + 4, true)
      const raw = (BigInt(hi) << 32n) | BigInt(lo)

      abi.expectOk(ex.ghostty_cell_get(raw, abi.CELL_DATA_WIDE, out), 'cell_get WIDE')
      const wide = dv().getUint32(out, true)
      // The trailing half of a wide glyph carries no text of its own. The
      // vendored reader folds it away by stepping two columns; here the
      // iterator still yields it, so it is skipped explicitly. Both must agree
      // or every subsequent column in the row is off by one.
      if (wide === abi.CELL_WIDE_SPACER_TAIL) continue

      const cp = abi.codepointOf(lo)
      line += cp === 0 ? ' ' : String.fromCodePoint(cp)

      // A cell with no explicit colour reports INVALID_VALUE rather than a
      // colour, and the caller is expected to substitute its own default. Our
      // ABI pre-resolves that on the other side of the boundary, so this is
      // where the two representations are reconciled.
      const fgRes = ex.ghostty_render_state_row_cells_get(cells, abi.RS_CELLS_FG_COLOR, out)
      fg.push(
        fgRes === abi.GHOSTTY_SUCCESS
          ? (dv().getUint8(out) << 16) | (dv().getUint8(out + 1) << 8) | dv().getUint8(out + 2)
          : DEFAULT_FG,
      )
      const bgRes = ex.ghostty_render_state_row_cells_get(cells, abi.RS_CELLS_BG_COLOR, out)
      bg.push(
        bgRes === abi.GHOSTTY_SUCCESS
          ? (dv().getUint8(out) << 16) | (dv().getUint8(out + 1) << 8) | dv().getUint8(out + 2)
          : DEFAULT_BG,
      )

      abi.expectOk(ex.ghostty_render_state_row_cells_get(cells, abi.RS_CELLS_STYLE, stylePtr), 'cells_get STYLE')
      const d = dv()
      const underline = d.getUint32(stylePtr + abi.STYLE_OFF_UNDERLINE_STYLE, true)
      let f = 0
      if (d.getUint8(stylePtr + abi.STYLE_OFF_BOLD)) f |= CELL_BOLD
      if (d.getUint8(stylePtr + abi.STYLE_OFF_ITALIC)) f |= CELL_ITALIC
      if (d.getUint8(stylePtr + abi.STYLE_OFF_STRIKETHROUGH)) f |= CELL_STRIKETHROUGH
      if (d.getUint8(stylePtr + abi.STYLE_OFF_INVERSE)) f |= CELL_INVERSE
      if (d.getUint8(stylePtr + abi.STYLE_OFF_INVISIBLE)) f |= CELL_INVISIBLE
      if (d.getUint8(stylePtr + abi.STYLE_OFF_BLINK)) f |= CELL_BLINK
      if (d.getUint8(stylePtr + abi.STYLE_OFF_FAINT)) f |= CELL_FAINT
      // Our `flags` byte carries "underlined at all"; *which* underline lives
      // in attrs2, exactly as the vendored packing does.
      if (underline !== 0) f |= CELL_UNDERLINE
      flags.push(f)

      let a2 = underline & CELL2_UNDERLINE_MASK
      if (d.getUint8(stylePtr + abi.STYLE_OFF_OVERLINE)) a2 |= CELL2_OVERLINE
      attrs2.push(a2)
    }

    outRows.push(trimRow(line, fg, bg, flags))
    outFg.push(fg)
    outBg.push(bg)
    outFlags.push(flags)
    outAttrs2.push(attrs2)
  }

  abi.expectOk(ex.ghostty_render_state_get(state, abi.RS_DATA_CURSOR_VIEWPORT_X, out), 'get CURSOR_X')
  const cursorX = dv().getUint32(out, true)
  abi.expectOk(ex.ghostty_render_state_get(state, abi.RS_DATA_CURSOR_VIEWPORT_Y, out), 'get CURSOR_Y')
  const cursorY = dv().getUint32(out, true)

  ex.ghostty_terminal_free(term)

  return {
    rows: outRows,
    fg: outFg,
    bg: outBg,
    flags: outFlags,
    attrs2: outAttrs2,
    cursorX,
    cursorY,
  }
}
