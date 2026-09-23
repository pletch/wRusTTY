import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { allocBuffer, parseCell, CELL_BYTES, type GhosttyWasm } from './wasmBindings'
import { RENDER_HOLD_TIMEOUT_MS } from './main/shim'

/**
 * Synchronized output through a real engine's `renderFrame`, with the renderer
 * replaced by one that records what each frame drew.
 *
 * `main/renderHold.test.ts` pins the shim, but it asks `is_held` on every
 * frame, and the engine does not: it only reaches that question while a redraw
 * is pending. That difference hid a bug the shim tests could not see. The
 * frame that draws a hold's captured snapshot cleared the pending flag, so the
 * timeout was never checked again and a program that set 2026 and died froze
 * the pane until something else wrote to it. Found in a browser; pinned here.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

interface Internals {
  wasm: GhosttyWasm | null
  termPtr: number
  renderer: unknown
  renderFrame(): void
}

describe('synchronized output through the render loop', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength),
    }))
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function ready() {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const engine = new GhosttyEngine()
    const inner = engine as unknown as Internals
    for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
    if (!inner.termPtr || !inner.wasm) throw new Error('core did not load')
    const wasm = inner.wasm
    const cols = wasm.exports.ghostty_render_state_get_cols(inner.termPtr) || 80

    /** Text of row 0 as each drawn frame saw it; nothing for a skipped one. */
    const drawn: string[] = []
    inner.renderer = {
      isContextLost: false,
      cursor: null,
      linkRanges: null,
      searchHighlights: null,
      getCellSize: () => ({ width: 8, height: 16 }),
      updateStaticGrid: () => {
        const buf = allocBuffer(wasm, cols * CELL_BYTES)
        wasm.exports.ghostty_render_state_get_viewport(inner.termPtr, buf, cols)
        const view = new DataView(wasm.exports.memory.buffer, buf, cols * CELL_BYTES)
        let row = ''
        for (let x = 0; x < cols; x++) {
          const cp = parseCell(view, x * CELL_BYTES).codepoint
          row += cp === 0 ? ' ' : String.fromCodePoint(cp)
        }
        wasm.exports.ghostty_wasm_free_u8_array(buf, cols * CELL_BYTES)
        drawn.push(row.trimEnd())
      },
    }
    /** One animation frame; the row it drew, or null if it drew nothing. */
    const frame = () => {
      const before = drawn.length
      inner.renderFrame()
      return drawn.length > before ? drawn[drawn.length - 1] : null
    }
    return { engine, frame }
  }

  it('draws the frame captured at the hold, then nothing until it ends', async () => {
    const { engine, frame } = await ready()
    engine.write('one')
    expect(frame()).toBe('one')
    engine.write('\x1b[?2026h\x1b[2J\x1b[Htw')
    expect(frame()).toBe('one')
    expect(frame()).toBeNull()
    engine.write('o\x1b[?2026l')
    expect(frame()).toBe('two')
  })

  it('releases a hold the program never ends, with no further output', async () => {
    let now = 5_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { engine, frame } = await ready()
    engine.write('shown')
    frame()
    engine.write('\x1b[?2026h\x1b[2J\x1b[Hstuck')
    expect(frame()).toBe('shown')
    expect(frame()).toBeNull()
    // No write from here on: only the loop asking again can end the hold.
    now += RENDER_HOLD_TIMEOUT_MS
    expect(frame()).toBe('stuck')
    // And once released, an idle pane goes back to drawing nothing.
    expect(frame()).toBeNull()
  })
})
