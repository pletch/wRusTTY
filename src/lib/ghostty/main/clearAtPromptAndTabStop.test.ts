import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { instantiateMainGhosttyWasm } from './shim'
import { createTerminal, writeString } from '../wasmBindings'
import { pasteIsSafe } from '../pasteEncode'

/**
 * The core changes the `b3dc3d79` re-pin was taken for. Each case fails on
 * the previous binary (`b1d9492c`), so the suite would notice a rebuild that
 * lost them.
 *
 * Against the shipped binary, so it runs on CI. `GHOSTTY_VT_WASM` points it at
 * another build.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = process.env.GHOSTTY_VT_WASM ?? join(here, '../vendor/ghostty-vt.wasm')
const CONFIG = { scrollbackLimit: 1 << 20, fgColor: 0xffffff, bgColor: 0, cursorColor: 0 }

const load = () => instantiateMainGhosttyWasm(readFileSync(WASM).buffer as ArrayBuffer)

describe('paste protection', () => {
  // Upstream `5c9a3d8a9`, found by a reporter. A CR is what the Enter key
  // sends, so on a shell without bracketed paste it runs the line before it.
  it('refuses a lone carriage return between commands', async () => {
    const wasm = await load()
    expect(pasteIsSafe(wasm, 'cd /tmp\rrm -rf build\rls')).toBe(false)
  })
})

describe('Ctrl-L at a prompt', () => {
  // Upstream `ff779564c`. ED 2 at a prompt scrolls the screen into scrollback
  // rather than erasing it, so clearing at a prompt keeps the earlier output.
  // That only worked with the prompt on the last row: the search for it
  // stopped at the first blank row below.
  it('keeps the earlier output in scrollback when the prompt is not on the last row', async () => {
    const wasm = await load()
    const t = createTerminal(wasm, 20, 6, CONFIG)
    writeString(wasm, t, 'out1\r\nout2\r\n\x1b]133;A\x07$ \x1b]133;B\x07')
    writeString(wasm, t, '\x1b[2J')
    expect(wasm.exports.ghostty_terminal_get_scrollback_length(t)).toBe(3)
    wasm.exports.ghostty_terminal_free(t)
  })
})

describe('a bare TBC (CSI g)', () => {
  // Upstream `d0c0d4008`. Its parameter defaults to 0, clear the stop at the
  // cursor, but with no parameter at all it was logged as invalid and dropped.
  it('clears the tab stop at the cursor', async () => {
    const wasm = await load()
    const t = createTerminal(wasm, 40, 2, CONFIG)
    // Column 9 is a default stop; clear it, go home, and tab.
    writeString(wasm, t, '\x1b[1;9H\x1b[g\r\t')
    wasm.exports.ghostty_render_state_update(t)
    expect(wasm.exports.ghostty_render_state_get_cursor_x(t)).toBe(16)
    wasm.exports.ghostty_terminal_free(t)
  })
})
