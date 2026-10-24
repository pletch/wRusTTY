import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { instantiateMainGhosttyWasm } from './shim'
import { createTerminal, writeString } from '../wasmBindings'

/**
 * The core cursor fixes in the `8ef0ec12` re-pin. Each case fails on the
 * previous binary (`b3dc3d79`), so the suite would notice a rebuild that lost
 * them.
 *
 * Against the shipped binary, so it runs on CI. `GHOSTTY_VT_WASM` points it at
 * another build.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = process.env.GHOSTTY_VT_WASM ?? join(here, '../vendor/ghostty-vt.wasm')
const CONFIG = { scrollbackLimit: 1 << 20, fgColor: 0xffffff, bgColor: 0, cursorColor: 0 }

/** The cursor after writing `seq` to a fresh 20x10 terminal, 0-based. */
async function cursorAfter(seq: string) {
  const wasm = await instantiateMainGhosttyWasm(readFileSync(WASM).buffer as ArrayBuffer)
  const ex = wasm.exports
  const t = createTerminal(wasm, 20, 10, CONFIG)
  writeString(wasm, t, seq)
  ex.ghostty_render_state_update(t)
  const at = { x: ex.ghostty_render_state_get_cursor_x(t), y: ex.ghostty_render_state_get_cursor_y(t) }
  ex.ghostty_terminal_free(t)
  return at
}

describe('CHA in origin mode', () => {
  // Upstream `82df0be2c`. In origin mode the handler built the row it meant
  // to keep from the cursor's absolute position, so the scroll margin was
  // added a second time and the cursor jumped down.
  it('keeps the row', async () => {
    // Scroll region rows 3-6, origin mode on, region row 2 (screen row 4,
    // 0-based 3), then column 10.
    expect(await cursorAfter('\x1b[3;6r\x1b[?6h\x1b[2;5H\x1b[10G')).toEqual({ x: 9, y: 3 })
  })
})

describe('CUB at the left margin', () => {
  // Upstream `53fb05c6e`. With reverse wrap off, moving left clamped only at
  // column 0 and ignored a DECSLRM left margin.
  it('stops at the margin', async () => {
    // Left and right margins at columns 5-10, cursor to column 7, left 10.
    expect(await cursorAfter('\x1b[?69h\x1b[5;10s\x1b[1;7H\x1b[10D')).toEqual({ x: 4, y: 0 })
  })
})
