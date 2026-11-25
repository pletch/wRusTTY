import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { instantiateMainGhosttyWasm } from './shim'
import { createTerminal, writeString } from '../wasmBindings'

/**
 * The core changes the `9fd1ebf2` re-pin was taken for. Each case fails on
 * the previous binary (`9ad3c422`), so the suite would notice a rebuild that
 * lost them.
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
  return {
    write: (s: string) => writeString(wasm, term, s),
    /** Whether row `y` continues the row above it (a wrap continuation). */
    continues: (y: number) => ex.ghostty_terminal_is_row_wrapped(term, y) === 1,
    cursorX: () => {
      ex.ghostty_render_state_update(term)
      return ex.ghostty_render_state_get_cursor_x(term)
    },
    free: () => ex.ghostty_terminal_free(term),
  }
}

describe('soft wraps when a program scrolls with IL and DL', () => {
  // Upstream `4917fd8a1` (#15309). Insert and delete line inside a full-width
  // scroll region, which is how vim, less and tmux scroll part of the screen,
  // cleared the wrap flag of every row they moved. A URL across a soft wrap
  // then read as two links, and a copy put a line break inside a wrapped line,
  // until the program redrew. Rows that move together keep their wrap now.

  it('keeps the wrap of rows insert line pushes down', async () => {
    // "ABC" wraps into "DE" on a 3-column screen.
    const p = await pane(3, 4)
    p.write('ABCDE')
    // Scroll region rows 1-3, cursor home, insert one line. "ABC" moves to
    // row 1, so "DE" on row 2 still continues it.
    p.write('\x1b[1;3r\x1b[1;1H\x1b[L')
    expect([p.continues(1), p.continues(2)]).toEqual([false, true])
    p.free()
  })

  it('keeps the wrap of rows delete line pulls up', async () => {
    // "1", then "ABC" wrapping into "DE". Deleting the first line moves both
    // up a row, so "DE" on row 1 still continues "ABC".
    const p = await pane(3, 4)
    p.write('1\r\nABCDE')
    p.write('\x1b[1;3r\x1b[1;1H\x1b[M')
    expect([p.continues(0), p.continues(1)]).toEqual([false, true])
    p.free()
  })
})

describe('a skin tone modifier with grapheme clustering on', () => {
  // Upstream `77c2f8b9f` (#15337). Under mode 2027, a skin tone after an emoji
  // drawn as text by default left the cluster one cell wide, where the same
  // base with VS16 took two. The rest of the line then sat one cell left of
  // where the program drew it.
  it('widens ☝ to two cells, as VS16 does', async () => {
    for (const second of ['\u{1F3FB}', '\u{1F3FF}', '\u{FE0F}']) {
      const p = await pane(10, 2)
      p.write('\x1b[?2027h☝' + second)
      expect(p.cursorX(), `U+261D then U+${second.codePointAt(0)!.toString(16)}`).toBe(2)
      p.free()
    }
  })
})
