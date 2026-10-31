import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { instantiateMainGhosttyWasm } from './shim'
import {
  allocBuffer,
  createTerminal,
  freeBuffer,
  parseCell,
  writeString,
  CELL_BOLD,
  CELL_BYTES,
  type WasmCellData,
} from '../wasmBindings'

/**
 * The core changes the `ae0dc1b7` re-pin was taken for. Each case fails on
 * the previous binary (`8ef0ec12`), so the suite would notice a rebuild that
 * lost them.
 *
 * Against the shipped binary, so it runs on CI. `GHOSTTY_VT_WASM` points it at
 * another build.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = process.env.GHOSTTY_VT_WASM ?? join(here, '../vendor/ghostty-vt.wasm')

type Wasm = Awaited<ReturnType<typeof instantiateMainGhosttyWasm>>

const load = () => instantiateMainGhosttyWasm(readFileSync(WASM).buffer as ArrayBuffer)

async function pane(cols: number, rows: number, scrollbackLimit = 1 << 20, shared?: Wasm) {
  const wasm = shared ?? (await load())
  const ex = wasm.exports
  const term = createTerminal(wasm, cols, rows, { scrollbackLimit, fgColor: 0xffffff, bgColor: 0, cursorColor: 0 })
  const write = (s: string) => writeString(wasm, term, s)
  /** Viewport row `y` as the renderer would read it, one entry per column. */
  const row = (y: number): WasmCellData[] => {
    ex.ghostty_render_state_update(term)
    const c = ex.ghostty_render_state_get_cols(term)
    // Only the rows up to `y`: the viewport is read from the top.
    const size = c * (y + 1) * CELL_BYTES
    const buf = allocBuffer(wasm, size)
    try {
      ex.ghostty_render_state_get_viewport(term, buf, c * (y + 1))
      const view = new DataView(ex.memory.buffer, buf, size)
      return Array.from({ length: c }, (_, x) => parseCell(view, (y * c + x) * CELL_BYTES))
    } finally {
      freeBuffer(wasm, buf, size)
    }
  }
  const text = (y: number) =>
    row(y)
      .map((cell) => (cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' '))
      .join('')
      .trimEnd()
  const free = () => ex.ghostty_terminal_free(term)
  return { write, row, text, free }
}

describe('clearing into scrollback when it is full', () => {
  // Upstream `1c2ea7222`. ED 2 at a prompt (and ED 22) scrolls the screen into
  // scrollback. Once scrollback is at its limit, that can delete the page the
  // cursor is on, and the cursor kept a style and hyperlink ID from the freed
  // page. The next text came out in the wrong style; in our ReleaseFast build
  // it is an unchecked read of freed memory.
  //
  // The case needs the cursor on the oldest page when the clear deletes it.
  // The core keeps whole pages of history, and a page holds a fixed number of
  // cells, so a very wide pane gets pages of only a few rows (27 at 2000
  // columns) and a 40-row screen spans more than one. Which line count lines
  // the pages up depends on the page size, so it tries a range that covers
  // three pages. On the previous binary it fails at 41 lines.
  it('keeps the cursor style on the page it moves to', async () => {
    const wasm = await load()
    for (let lines = 0; lines <= 81; lines++) {
      // The smallest limit: the core still keeps a page of history.
      const p = await pane(2000, 40, 1, wasm)
      p.write('x\r\n'.repeat(lines) + 'x')
      // Bold at the top-left, then clear into scrollback and print.
      p.write('\x1b[H\x1b[1m\x1b[22Jy')
      const cell = p.row(0)[0]
      expect(String.fromCodePoint(cell.codepoint), `after ${lines} lines`).toBe('y')
      expect(cell.flags & CELL_BOLD, `after ${lines} lines`).toBe(CELL_BOLD)
      p.free()
    }
  })
})

describe('VT420 column operations', () => {
  // Upstream `44a4911e9`. DECIC and DECDC insert and delete columns in every
  // row of the scrolling region; they were ignored before.
  it('DECIC inserts a column in every row', async () => {
    const p = await pane(10, 3)
    p.write("abcd\r\nefgh\r\nijkl\x1b[1;2H\x1b[1'}")
    expect([p.text(0), p.text(1), p.text(2)]).toEqual(['a bcd', 'e fgh', 'i jkl'])
    p.free()
  })

  it('DECDC deletes a column from every row', async () => {
    const p = await pane(10, 3)
    p.write("abcd\r\nefgh\r\nijkl\x1b[1;2H\x1b[1'~")
    expect([p.text(0), p.text(1), p.text(2)]).toEqual(['acd', 'egh', 'ikl'])
    p.free()
  })

  // DECFI (ESC 9) at the right margin scrolls the region left; DECBI (ESC 6)
  // at the left margin scrolls it right.
  it('DECFI at the right edge scrolls the region left', async () => {
    const p = await pane(4, 2)
    p.write('abcd\r\nefgh\x1b[1;4H\x1b9')
    expect([p.text(0), p.text(1)]).toEqual(['bcd', 'fgh'])
    p.free()
  })

  it('DECBI at the left edge scrolls the region right', async () => {
    const p = await pane(4, 2)
    p.write('abcd\r\nefgh\x1b[1;1H\x1b6')
    expect([p.text(0), p.text(1)]).toEqual([' abc', ' efg'])
    p.free()
  })
})
