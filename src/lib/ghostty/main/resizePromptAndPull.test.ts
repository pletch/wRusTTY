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
  CELL_BYTES,
} from '../wasmBindings'

/**
 * The core resize fixes the `cf3a8a65` re-pin was taken for. Each case fails
 * on the previous binary (`27ffca0d`), so the suite would notice a rebuild
 * that lost them.
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
  const resize = (c: number, r: number) => ex.ghostty_terminal_resize(term, c, r)
  /** The viewport as text, one entry per row, trailing blanks trimmed. */
  const screen = (): string[] => {
    ex.ghostty_render_state_update(term)
    const c = ex.ghostty_render_state_get_cols(term)
    const r = ex.ghostty_render_state_get_rows(term)
    const size = c * r * CELL_BYTES
    const buf = allocBuffer(wasm, size)
    try {
      ex.ghostty_render_state_get_viewport(term, buf, c * r)
      const view = new DataView(ex.memory.buffer, buf, size)
      return Array.from({ length: r }, (_row, y) =>
        Array.from({ length: c }, (_cell, x) => {
          const cp = parseCell(view, (y * c + x) * CELL_BYTES).codepoint
          return cp ? String.fromCodePoint(cp) : ' '
        })
          .join('')
          .trimEnd(),
      )
    } finally {
      freeBuffer(wasm, buf, size)
    }
  }
  const cursorY = () => {
    ex.ghostty_render_state_update(term)
    return ex.ghostty_render_state_get_cursor_y(term)
  }
  return { ex, term, write, resize, screen, cursorY }
}

describe('a prompt redrawn after a resize', () => {
  // Upstream `e6076b3a6` (#15199). On a width change the core can clear the
  // prompt and let the shell redraw it. libghostty-vt only does that for a
  // shell that opts in with `OSC 133;A;redraw=1` (Ghostty's own shell
  // integration does; ours doesn't), so these prompts opt in. Reflow copied
  // the prompt-start mark onto every row it split a prompt into, and a joined
  // row took the mark of the last row in it, so the clear started in the
  // wrong place.

  it('leaves exactly one prompt when zsh redraws it at each new width', async () => {
    // What zsh writes after a resize: carriage returns, up by the rows the
    // prompt took above the cursor, erase below, then the prompt again. A
    // first line padded to the full width, as powerlevel10k draws it, took
    // one row above the cursor at every width.
    const p = await pane(80, 10)
    const prompt = (cols: number) =>
      '\x1b]133;A;redraw=1;cl=line\x07LEFT' +
      ' '.repeat(cols - 'LEFTRIGHT'.length) +
      'RIGHT\r\n\x1b]133;P;k=s\x07> \x1b]133;B\x07ls'
    p.write('out\r\n' + prompt(80))
    for (const cols of [60, 80, 60, 80, 100, 80, 40, 80]) {
      p.resize(cols, 10)
      p.write('\r\r\x1b[A\x1b[J' + prompt(cols))
      const text = p.screen().join('\n')
      expect(text.split('out').length - 1, `at ${cols} columns`).toBe(1)
      expect(text.split('LEFT').length - 1, `at ${cols} columns`).toBe(1)
      expect(p.cursorY(), `at ${cols} columns`).toBe(2)
    }
  })

  it('keeps the previous prompt when widening joins its rows', async () => {
    // Two prompts with an empty command between them, each wrapped onto a
    // second row. Widening joins each onto one row; the second prompt lost
    // its start mark, so the clear took the first prompt with it.
    const p = await pane(10, 8)
    p.write(
      'out\r\n' +
        '\x1b]133;A;redraw=1;cl=line\x07P1-abcdefghijk$ \x1b]133;B\x07\r\n' +
        '\x1b]133;D;0\x07' +
        '\x1b]133;A;redraw=1;cl=line\x07P2-abcdefghijk$ \x1b]133;B\x07ls',
    )
    p.resize(30, 8)
    expect(p.screen().slice(0, 2)).toEqual(['out', 'P1-abcdefghijk$'])
  })
})

describe('growing rows and shrinking columns in one resize', () => {
  // Upstream `e0e57281d` (#15141). The row growth pulled lines down from
  // scrollback, then the column change pushed them straight back, unlike
  // the same two resizes done one after the other. Dragging a window corner
  // or changing a split layout does both at once.
  it('pulls scrollback down like two separate resizes', async () => {
    const p = await pane(5, 2)
    // Pulling scrollback down on a resize is what the app turns on.
    p.ex.ghostty_terminal_set_resize_pull_scrollback!(p.term, 1)
    p.write('1A\r\n2B\r\n3C\r\n')
    expect(p.screen()).toEqual(['3C', ''])
    p.resize(4, 4)
    expect(p.screen()).toEqual(['1A', '2B', '3C', ''])
    expect(p.cursorY()).toBe(3)
  })
})
