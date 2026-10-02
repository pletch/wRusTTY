import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { sessionModeReset } from '../sessionModes'
import * as abi from './abi'

/**
 * The two core fixes the `f523504e` re-pin was taken for, plus the palette
 * reset our own session-drop sequence now sends. Each case fails on the
 * previous binary (`f9e82709`), which is what makes it worth keeping: the
 * suite would notice a rebuild that lost them.
 *
 * Against the shipped binary, so it runs on CI. `GHOSTTY_VT_WASM` points it at
 * another build.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = process.env.GHOSTTY_VT_WASM ?? join(here, '../vendor/ghostty-vt.wasm')

/** What a theme would set as palette entry 1, distinct from every built-in. */
const THEME_RED = [1, 2, 3]

function boot(cols: number, rows: number) {
  const mod = new WebAssembly.Module(Uint8Array.from(readFileSync(WASM)))
  const ex = new WebAssembly.Instance(mod, { env: { log: () => {} } }).exports as unknown as abi.GhosttyMainExports
  const slot = ex.ghostty_wasm_alloc_opaque()
  abi.expectOk(ex.ghostty_terminal_new(0, slot, cols, rows), 'terminal_new')
  const term = new DataView(ex.memory.buffer).getUint32(slot, true)
  const palette = ex.ghostty_wasm_alloc(abi.PALETTE_BYTES)
  const out = ex.ghostty_wasm_alloc(16)

  const write = (s: string) => {
    const b = new TextEncoder().encode(s)
    const p = ex.ghostty_wasm_alloc(b.length)
    new Uint8Array(ex.memory.buffer).set(b, p)
    ex.ghostty_terminal_vt_write(term, p, b.length)
    ex.ghostty_wasm_free(p, b.length)
  }
  const red = () => {
    abi.expectOk(ex.ghostty_terminal_get(term, abi.T_DATA_COLOR_PALETTE, palette), 'get palette')
    const d = new DataView(ex.memory.buffer)
    const at = palette + abi.COLOR_RGB_BYTES
    return [d.getUint8(at), d.getUint8(at + 1), d.getUint8(at + 2)]
  }
  /** Set the configured palette the way the shim does for a theme: as the
   * default, which is what a reset goes back to. */
  const setTheme = () => {
    abi.expectOk(ex.ghostty_terminal_get(term, abi.T_DATA_COLOR_PALETTE, palette), 'get palette')
    new Uint8Array(ex.memory.buffer).set(THEME_RED, palette + abi.COLOR_RGB_BYTES)
    abi.expectOk(ex.ghostty_terminal_set(term, abi.T_OPT_COLOR_PALETTE, palette), 'set palette')
  }
  const cursor = () => {
    ex.ghostty_terminal_get(term, abi.T_DATA_CURSOR_X, out)
    const x = new DataView(ex.memory.buffer).getUint16(out, true)
    ex.ghostty_terminal_get(term, abi.T_DATA_CURSOR_Y, out)
    const y = new DataView(ex.memory.buffer).getUint16(out, true)
    return { x, y }
  }
  const resize = (c: number, r: number) => ex.ghostty_terminal_resize(term, c, r)
  return { write, red, setTheme, cursor, resize }
}

describe('the palette a program changed', () => {
  // Upstream `bb20f8e45`. Before it, RIS reset everything but the palette, so
  // a program that recoloured it (OSC 4) left it that way through `reset`.
  it('goes back to the theme on RIS', () => {
    const t = boot(40, 4)
    t.setTheme()
    t.write('\x1b]4;1;rgb:ff/00/00\x07')
    expect(t.red()).toEqual([255, 0, 0])
    t.write('\x1bc')
    expect(t.red()).toEqual(THEME_RED)
  })

  // Ours: a session that drops leaves no chance for the program to undo it,
  // and RIS is out because it would take the scrollback with it.
  it('goes back to the theme when a dropped session is reset', () => {
    const t = boot(40, 4)
    t.setTheme()
    t.write('\x1b]4;1;rgb:ff/00/00\x07')
    t.write(sessionModeReset(false))
    expect(t.red()).toEqual(THEME_RED)
  })
})

// Upstream `f9ab34f10`. A line that filled the row leaves the cursor waiting to
// wrap; widen the pane and the next character still started a new row, though
// the line now had room for it.
describe('a full line, then a wider pane', () => {
  it('carries on along the same row', () => {
    const t = boot(10, 4)
    t.write('abcdefghij')
    t.resize(12, 4)
    t.write('X')
    expect(t.cursor()).toEqual({ x: 11, y: 0 })
  })

  it('still wraps when the line still fills the row', () => {
    const t = boot(10, 4)
    t.write('abcdefghij')
    t.resize(10, 5)
    t.write('X')
    expect(t.cursor()).toEqual({ x: 1, y: 1 })
  })
})
