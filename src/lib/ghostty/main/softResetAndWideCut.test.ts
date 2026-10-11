import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { instantiateMainGhosttyWasm } from './shim'
import {
  allocBuffer,
  createTerminal,
  parseCell,
  writeString,
  CELL_BOLD,
  CELL_BYTES,
  type WasmCellData,
} from '../wasmBindings'

/**
 * The three core fixes the `b1d9492c` re-pin was taken for. Each case fails on
 * the previous binary (`f523504e`), which is what makes it worth keeping: the
 * suite would notice a rebuild that lost them.
 *
 * Against the shipped binary, so it runs on CI. `GHOSTTY_VT_WASM` points it at
 * another build.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = process.env.GHOSTTY_VT_WASM ?? join(here, '../vendor/ghostty-vt.wasm')
const CONFIG = { scrollbackLimit: 1 << 20, fgColor: 0xffffff, bgColor: 0, cursorColor: 0 }

async function pane(cols: number, rows: number) {
  const wasm = await instantiateMainGhosttyWasm(readFileSync(WASM).buffer as ArrayBuffer)
  const ex = wasm.exports
  const term = createTerminal(wasm, cols, rows, CONFIG)
  const write = (s: string) => writeString(wasm, term, s)
  /** Row 0 as the renderer would read it, one entry per column. */
  const row0 = (): WasmCellData[] => {
    ex.ghostty_render_state_update(term)
    const c = ex.ghostty_render_state_get_cols(term)
    const buf = allocBuffer(wasm, c * CELL_BYTES)
    ex.ghostty_render_state_get_viewport(term, buf, c)
    const view = new DataView(ex.memory.buffer, buf, c * CELL_BYTES)
    return Array.from({ length: c }, (_, x) => parseCell(view, x * CELL_BYTES))
  }
  const resize = (c: number, r: number) => ex.ghostty_terminal_resize(term, c, r)
  return { write, row0, resize }
}

describe('a wide character the right edge cuts in half', () => {
  // Upstream `e6db5b633`. Narrowing without reflow cleared only the columns
  // past the new edge, leaving the first half of a two-column character in
  // the new last column with nothing after it. Erases and inserts on that row
  // then reached past its end: a panic in a debug build, and in our
  // ReleaseFast one an unchecked read and write. The alternate screen never
  // reflows, so this is a full-screen program showing CJK or emoji while a
  // split is narrowed.
  for (const [where, setup] of [
    ['on the alternate screen', '\x1b[?1049h'],
    ['with wraparound off', '\x1b[?7l'],
  ] as const) {
    it(`is cleared rather than left orphaned, ${where}`, async () => {
      const p = await pane(3, 2)
      p.write(`${setup}\x1b[1;1Ha一`)
      p.resize(2, 2)
      const last = p.row0()[1]
      expect(last.codepoint).toBe(0)
      expect(last.width).toBe(1)
    })
  }
})

describe('a soft reset (DECSTR)', () => {
  // Upstream `f473f3109`. It was ignored, and xterm-256color's init and reset
  // strings (is2, rs2) both open with it, so `tput init` and `tset` left the
  // pen, margins and modes they were meant to clear.
  it('clears the pen without clearing the screen', async () => {
    const p = await pane(20, 2)
    p.write('\x1b[1;31mred\x1b[!px')
    const row = p.row0()
    // What was already written keeps its color; the next character does not.
    expect(row[0].flags & CELL_BOLD).toBe(CELL_BOLD)
    expect(String.fromCodePoint(row[3].codepoint)).toBe('x')
    expect(row[3].flags & CELL_BOLD).toBe(0)
  })

  it('turns wraparound back on', async () => {
    const p = await pane(4, 2)
    p.write('\x1b[?7l\x1b[!pabcdef')
    // With wraparound still off, "ef" would overwrite the last column of row 0.
    expect(p.row0().map((c) => String.fromCodePoint(c.codepoint || 32)).join('')).toBe('abcd')
  })
})

describe('an emoji while DEC line drawing is in effect', () => {
  // Upstream `6220a3617`. A designated set only remaps GL; anything above 0xFF
  // was printed as a space, and since its width still came from the emoji, the
  // rest of the row shifted by a column.
  it('prints as itself, not as a blank', async () => {
    const p = await pane(10, 2)
    p.write('\x1b(0q\u{1F600}q\x1b(B')
    const row = p.row0()
    expect(row[0].codepoint).toBe(0x2500) // 'q' in DEC Special Graphics
    expect(row[1].codepoint).toBe(0x1f600)
    expect(row[1].width).toBe(2)
    expect(row[3].codepoint).toBe(0x2500)
  })
})
