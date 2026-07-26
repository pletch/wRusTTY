import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { GhosttyWasm } from './wasmBindings'

/**
 * The cursor preference surviving a reset, through a real engine and a real
 * core rather than through the decision function alone.
 *
 * `cursorRestore.test.ts` pins the decision; this pins the wiring around it,
 * which is where every bug in this area actually landed — the preference not
 * reaching a new pane, the blink gated on a flag nothing ever set, the write
 * skipped because the core's default was misremembered. Each of those passed
 * every unit test that existed at the time.
 *
 * So this drives the public surface only: construct an engine, let its core
 * load, write bytes, and ask the core what the cursor is.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

/** What the test needs to reach past the public API for: the core itself, so
 *  the assertion is "what does the terminal think its cursor is" rather than
 *  "what did we send it". */
interface Internals {
  wasm: GhosttyWasm | null
  termPtr: number
}

describe('cursor preference across a full reset', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength),
    }))
    // Nothing is mounted, so these only have to exist.
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  })

  afterEach(() => vi.unstubAllGlobals())

  async function ready(style: 'block' | 'bar' | 'underline', blink: boolean) {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const engine = new GhosttyEngine()
    // Set before the core exists, which is the real order: Terminal.tsx applies
    // settings synchronously on construction and the WASM fetch is still in
    // flight.
    engine.setCursorStyle(style, blink)

    const inner = engine as unknown as Internals
    for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
    if (!inner.termPtr || !inner.wasm) throw new Error('core did not load')

    const cursor = () => {
      const w = inner.wasm!
      w.exports.ghostty_render_state_update(inner.termPtr)
      return {
        style: w.exports.ghostty_render_state_get_cursor_style(inner.termPtr),
        blink: w.exports.ghostty_render_state_get_cursor_blinking(inner.termPtr) !== 0,
      }
    }
    return { engine, cursor }
  }

  const BAR = 1
  const UNDERLINE = 2

  it('reaches the core even though it was set before the core existed', async () => {
    const { engine, cursor } = await ready('bar', true)
    expect(cursor()).toEqual({ style: BAR, blink: true })
    engine.dispose()
  })

  it('comes back after RIS throws it away', async () => {
    const { engine, cursor } = await ready('bar', true)
    engine.write('\x1bc')
    // Without the restore this reads back as the core's own default: a steady
    // block.
    expect(cursor()).toEqual({ style: BAR, blink: true })
    engine.dispose()
  })

  it('comes back after each of several resets, not just the first', async () => {
    const { engine, cursor } = await ready('underline', false)
    for (let i = 0; i < 3; i++) {
      engine.write('\x1bc')
      expect(cursor(), `reset ${i + 1}`).toEqual({ style: UNDERLINE, blink: false })
    }
    engine.dispose()
  })

  it('yields to an application that picks its own cursor after resetting', async () => {
    // The case that makes blind restoration wrong, end to end: both the reset
    // and the application's choice arrive in one write.
    const { engine, cursor } = await ready('bar', true)
    engine.write('\x1bc\x1b[4 q')
    expect(cursor()).toEqual({ style: UNDERLINE, blink: false })
    engine.dispose()
  })

  it('leaves an application cursor alone when no reset is involved', async () => {
    const { engine, cursor } = await ready('bar', true)
    engine.write('\x1b[4 q')
    expect(cursor()).toEqual({ style: UNDERLINE, blink: false })
    engine.dispose()
  })

  it('restores after a reset that arrives split across two writes', async () => {
    // ESC and c in separate writes — the shape that makes scanning the stream
    // for the sequence unreliable, and the reason the core reports it instead.
    const { engine, cursor } = await ready('bar', true)
    engine.write('\x1b')
    engine.write('c')
    expect(cursor()).toEqual({ style: BAR, blink: true })
    engine.dispose()
  })
})
