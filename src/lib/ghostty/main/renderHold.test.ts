import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { instantiateMainGhosttyWasm, RENDER_HOLD_TIMEOUT_MS } from './shim'
import {
  allocBuffer,
  createTerminal,
  parseCell,
  writeString,
  CELL_BYTES,
  type GhosttyWasm,
} from '../wasmBindings'

/**
 * Synchronized output (mode 2026) through the shim, against the shipped binary
 * so it runs on CI.
 *
 * Each case drives the exports in the order `GhosttyEngine.renderFrame` does:
 * ask `is_held`, and only if it says draw, `update` and read the viewport. What
 * is asserted is what that frame would have put on screen.
 */

const here = dirname(fileURLToPath(import.meta.url))
const SHIPPED = join(here, '../vendor/ghostty-vt.wasm')

const COLS = 20
const ROWS = 4
const CELLS = COLS * ROWS
const CONFIG = { scrollbackLimit: 1024 * 1024, fgColor: 0xffffff, bgColor: 0, cursorColor: 0 }

const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'

let loaded: Promise<GhosttyWasm> | null = null
const load = () =>
  (loaded ??= instantiateMainGhosttyWasm(readFileSync(SHIPPED).buffer as ArrayBuffer))

async function pane() {
  const wasm = await load()
  const ex = wasm.exports
  const term = createTerminal(wasm, COLS, ROWS, CONFIG)
  const buf = allocBuffer(wasm, CELLS * CELL_BYTES)
  const write = (s: string) => writeString(wasm, term, s)

  /** One animation frame: the text it would draw, or null if it would skip. */
  const frame = (): string | null => {
    if (ex.ghostty_render_state_is_held!(term) === 1) return null
    ex.ghostty_render_state_update(term)
    ex.ghostty_render_state_get_viewport(term, buf, CELLS)
    const view = new DataView(ex.memory.buffer, buf, CELLS * CELL_BYTES)
    const rows: string[] = []
    for (let y = 0; y < ROWS; y++) {
      let row = ''
      for (let x = 0; x < COLS; x++) {
        const cp = parseCell(view, (y * COLS + x) * CELL_BYTES).codepoint
        row += cp === 0 ? ' ' : String.fromCodePoint(cp)
      }
      rows.push(row.trimEnd())
    }
    return rows.join('|').replace(/\|+$/, '')
  }

  const syncOutput = () => ex.ghostty_terminal_get_mode(term, 2026, 0)
  return { ex, term, write, frame, syncOutput, free: () => ex.ghostty_terminal_free(term) }
}

describe('render hold (synchronized output)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps the finished frame on screen while the next one is half-drawn', async () => {
    const p = await pane()
    p.write('frame one')
    expect(p.frame()).toBe('frame one')

    // The redraw arrives in two chunks, with a frame boundary between them.
    // Without the hold that frame showed a cleared screen and half the text.
    p.write(`${BSU}\x1b[2J\x1b[Hframe`)
    expect(p.frame()).toBe('frame one')
    expect(p.frame()).toBeNull()

    p.write(` two${ESU}`)
    expect(p.frame()).toBe('frame two')
    p.free()
  })

  it('draws what came before the hold in the same write', async () => {
    // The capture is taken at the byte where the hold begins, so output ahead
    // of it in the same chunk is part of the frame — the case a check of the
    // mode bit at draw time could never get right.
    const p = await pane()
    p.write(`before${BSU}\r\nduring`)
    expect(p.frame()).toBe('before')
    expect(p.frame()).toBeNull()
    p.write(ESU)
    expect(p.frame()).toBe('before|during')
    p.free()
  })

  it('costs nothing visible when the whole frame arrives in one write', async () => {
    const p = await pane()
    p.write(`${BSU}\x1b[2J\x1b[Hwhole${ESU}`)
    expect(p.frame()).toBe('whole')
    p.free()
  })

  it('gives up on a program that never releases the screen', async () => {
    let now = 1_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const p = await pane()
    p.write(`shown${BSU}\r\nstuck`)
    expect(p.frame()).toBe('shown')
    now += RENDER_HOLD_TIMEOUT_MS - 1
    expect(p.frame()).toBeNull()

    now += 1
    expect(p.frame()).toBe('shown|stuck')
    // Ended in the core too, not just in our bookkeeping, so the next BSU
    // starts a real hold rather than being ignored as already set.
    expect(p.syncOutput()).toBe(0)
    p.free()
  })

  it('does not let the program push the deadline back by setting the mode again', async () => {
    let now = 1_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const p = await pane()
    p.write(BSU)
    p.frame()
    now += RENDER_HOLD_TIMEOUT_MS / 2
    p.write(`${BSU}x`)
    now += RENDER_HOLD_TIMEOUT_MS / 2
    expect(p.frame()).toBe('x')
    p.free()
  })

  it('ends on a resize, which the core releases on its own', async () => {
    const p = await pane()
    p.write(`a${BSU}b`)
    expect(p.frame()).toBe('a')
    p.ex.ghostty_terminal_resize(p.term, COLS, ROWS + 1)
    expect(p.frame()).toBe('ab')
    p.free()
  })

  it('ends on a full reset', async () => {
    const p = await pane()
    p.write(`a${BSU}b`)
    expect(p.frame()).toBe('a')
    p.write('\x1bcafter')
    expect(p.frame()).toBe('after')
    p.free()
  })

  it('reports the scrollback depth the held frame was taken at, not the live one', async () => {
    // The engine maps absolute rows through this depth when copying, and
    // pairs it with the snapshot. Output during a hold scrolls the live grid
    // on past the frame being shown.
    const p = await pane()
    p.write('1\r\n2\r\n3\r\n4\r\n5')
    p.frame()
    const depth = p.ex.ghostty_render_state_get_scrollback_length!(p.term)
    p.write(`${BSU}\r\n6\r\n7\r\n8`)
    p.frame()
    expect(p.ex.ghostty_render_state_get_scrollback_length!(p.term)).toBe(depth)
    expect(p.ex.ghostty_terminal_get_scrollback_length(p.term)).toBe(depth + 3)
    p.write(ESU)
    p.frame()
    expect(p.ex.ghostty_render_state_get_scrollback_length!(p.term)).toBe(depth + 3)
    p.free()
  })
})
