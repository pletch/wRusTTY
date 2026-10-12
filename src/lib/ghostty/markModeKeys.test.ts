// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Mark mode's grip on the keyboard, through the engine's real listeners.
 * `markMode.test.ts` covers the rules; this covers the wiring: the mode (a
 * capture listener on the container) must take a key before the input
 * handler (on the textarea inside) encodes it.
 *
 * The renderer is stubbed, so no WebGL is needed. The core is real: encoding
 * needs a terminal, and a coreless pane sends nothing, which would pass every
 * assertion for the wrong reason. The binary is served through the engine's
 * `fetch`, and `mounted` waits for it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

const CELL = { width: 10, height: 20 }

type Sel = { start: { x: number; y: number }; end: { x: number; y: number } }

async function mounted() {
  const { GhosttyEngine } = await import('./GhosttyEngine')
  const engine = new GhosttyEngine()
  const container = document.createElement('div')
  document.body.appendChild(container)
  engine.mount(container)

  // The core loads asynchronously; wait on the pointer, which appears with
  // the encoder.
  const inner = engine as unknown as { renderer: unknown; termPtr: number }
  for (let i = 0; i < 200 && inner.termPtr === 0; i++) await new Promise((r) => setTimeout(r, 5))
  if (inner.termPtr === 0) throw new Error('the core never came up')

  // After the wait: the real renderer fails in jsdom (no WebGL), so replace it.
  inner.renderer = { selection: null as Sel | null, getCellSize: () => CELL, dispose: () => {} }

  const sent: string[] = []
  engine.onData((d) => sent.push(new TextDecoder().decode(d)))

  const input = container.querySelector('textarea')!
  // `code` as well as `key`, since the encoder reads the physical key.
  const press = (key: string, mods: KeyboardEventInit = {}) =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, code: key, ...mods }),
    )
  const selection = () => (inner.renderer as { selection: Sel | null }).selection

  return { engine, container, sent, press, selection }
}

beforeEach(() => {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength),
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('mark mode and the wire', () => {
  it('leaves the arrow keys to the program while it is off', async () => {
    const { engine, sent, press } = await mounted()
    press('ArrowUp')
    press('ArrowUp', { shiftKey: true })
    // These belong to the running program; shift+arrow is a sequence programs
    // bind.
    expect(sent).toEqual(['\x1b[A', '\x1b[1;2A'])
    engine.unmount()
  })

  it('takes the arrow keys once it is on, and sends nothing', async () => {
    const { engine, sent, press, selection } = await mounted()
    engine.toggleMarkMode()
    expect(engine.isMarkMode()).toBe(true)
    // Downward: a fresh terminal has no scrollback and the cursor opens on
    // row 0, where up is clamped.
    const from = selection()!.end.y
    press('ArrowDown')
    press('ArrowDown', { shiftKey: true })
    // Nothing reached the wire.
    expect(sent).toEqual([])
    expect(selection()!.end.y).toBe(from + 2)
    // The second press was shifted, so it left a selection.
    expect(selection()!.start.y).toBe(from + 1)
    engine.unmount()
  })

  it('gives them back on Escape', async () => {
    const { engine, sent, press } = await mounted()
    engine.toggleMarkMode()
    press('Escape')
    expect(engine.isMarkMode()).toBe(false)
    // Escape is consumed by the exit.
    expect(sent).toEqual([])
    press('ArrowUp')
    expect(sent).toEqual(['\x1b[A'])
    engine.unmount()
  })

  it('hands the selection over when the mouse takes it', async () => {
    const { engine, container, press, sent } = await mounted()
    engine.toggleMarkMode()
    const canvas = container.querySelector('canvas')!
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 }))
    // Otherwise the arrows stay captured over a replaced selection.
    expect(engine.isMarkMode()).toBe(false)
    press('ArrowUp')
    expect(sent).toEqual(['\x1b[A'])
    engine.unmount()
  })

  it('stops intercepting once the pane is unmounted', async () => {
    const { engine, press, sent } = await mounted()
    engine.toggleMarkMode()
    engine.unmount()
    press('ArrowUp')
    // The listener is on the container, which outlives the engine; a mode left
    // armed would swallow keys.
    expect(sent).toEqual([])
    expect(engine.isMarkMode()).toBe(false)
  })
})
