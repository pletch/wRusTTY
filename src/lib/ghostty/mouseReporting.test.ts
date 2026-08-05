// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Mouse reporting end to end: a real DOM event on the real canvas, through the
 * real core, to the bytes that leave for the far end.
 *
 * `MouseEncoder.test.ts` covers what an event encodes to. This covers the part
 * only the wiring can get wrong, and which nothing covered before: that the
 * engine hands the encoder the right button, the right pixels and the right
 * geometry, and that it does so for the events a program actually wants. Every
 * bug this file exists to catch — a `MouseEvent.button` passed through
 * untranslated, a surface never sized, a listener wired to the wrong reporter
 * call — leaves `MouseEncoder.test.ts` entirely green.
 *
 * The renderer is stubbed to the members the mouse path uses, which is what
 * lets this run without WebGL. The core is not stubbed: tracking mode is real
 * terminal state, so a program has to be able to turn it on the way a program
 * does, by writing the sequence.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

const CELL = { width: 10, height: 20 }
const COLS = 80
const ROWS = 24

async function mounted() {
  const { GhosttyEngine } = await import('./GhosttyEngine')
  const engine = new GhosttyEngine()
  const container = document.createElement('div')
  document.body.appendChild(container)
  engine.mount(container)

  const inner = engine as unknown as {
    renderer: unknown
    termPtr: number
    fatalError: string | null
  }
  for (let i = 0; i < 200 && inner.termPtr === 0; i++) await new Promise((r) => setTimeout(r, 5))
  if (inner.termPtr === 0) throw new Error('the core never came up')

  // Building the real renderer is what fails under jsdom — there is no canvas
  // context to take a font from — and the engine treats that as a fatal init
  // failure, after which every `write` is a deliberate no-op. So the core
  // would never see the sequence that turns tracking on and this whole file
  // would assert silence. The core itself came up fine; only the drawing did
  // not, and nothing below draws.
  inner.fatalError = null

  inner.renderer = {
    selection: null,
    getCellSize: () => CELL,
    resize: () => {},
    dispose: () => {},
  }
  // Forced, so it runs even though the grid is not changing: this is what
  // hands the encoder its geometry, and without a renderer there was nothing
  // to measure when the engine tried on its own.
  engine.resize(COLS, ROWS, true)

  const sent: string[] = []
  engine.onData((d) => sent.push(d))

  const canvas = container.querySelector('canvas')!
  const at = (x: number, y: number) => ({ clientX: x, clientY: y, bubbles: true, cancelable: true })
  const down = (x: number, y: number, button = 0, init: MouseEventInit = {}) =>
    canvas.dispatchEvent(new MouseEvent('mousedown', { ...at(x, y), button, detail: 1, ...init }))
  const move = (x: number, y: number) =>
    canvas.dispatchEvent(new MouseEvent('mousemove', at(x, y)))
  const up = (x: number, y: number, button = 0) =>
    window.dispatchEvent(new MouseEvent('mouseup', { ...at(x, y), button }))
  const wheel = (dy: number) =>
    canvas.dispatchEvent(new WheelEvent('wheel', { ...at(15, 25), deltaY: dy }))
  const wheelX = (dx: number) =>
    canvas.dispatchEvent(new WheelEvent('wheel', { ...at(15, 25), deltaX: dx }))

  return { engine, sent, down, move, up, wheel, wheelX, container }
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

describe('mouse reporting, from the canvas to the wire', () => {
  it('says nothing while no program has asked', async () => {
    const { engine, sent, down, move, up } = await mounted()
    down(15, 25)
    move(35, 25)
    up(15, 25)
    // The default, and the reason the pointer is free to select text.
    expect(sent).toEqual([])
    engine.unmount()
  })

  it('reports a press once a program turns tracking on', async () => {
    const { engine, sent, down } = await mounted()
    engine.write('\x1b[?1000h\x1b[?1006h')
    down(15, 25)
    expect(sent).toEqual(['\x1b[<0;2;2M'])
    engine.unmount()
  })

  it('translates the DOM button numbering', async () => {
    const { engine, sent, down } = await mounted()
    engine.write('\x1b[?1000h\x1b[?1006h')
    // DOM 1 is the middle button; the protocol's 1 is the left one. Passing
    // `MouseEvent.button` through untranslated reports this as a right click,
    // and nothing else in the suite would notice.
    down(15, 25, 1)
    expect(sent).toEqual(['\x1b[<1;2;2M'])
    engine.unmount()
  })

  it('reports the release of the button that was held', async () => {
    const { engine, sent, down, up } = await mounted()
    engine.write('\x1b[?1000h\x1b[?1006h')
    down(15, 25, 2)
    sent.length = 0
    up(15, 25, 2)
    expect(sent).toEqual(['\x1b[<2;2;2m'])
    engine.unmount()
  })

  it('reports the wheel as a button, which is how a pager scrolls', async () => {
    const { engine, sent, wheel } = await mounted()
    engine.write('\x1b[?1000h\x1b[?1006h')
    wheel(-1)
    wheel(1)
    expect(sent).toEqual(['\x1b[<64;2;2M', '\x1b[<65;2;2M'])
    engine.unmount()
  })

  it('reports a horizontal wheel on its own buttons', async () => {
    const { engine, sent, wheelX } = await mounted()
    engine.write('\x1b[?1000h\x1b[?1006h')
    wheelX(-1)
    wheelX(1)
    // 66 and 67. A trackpad sends both axes at once, so the dominant one wins
    // rather than both being reported.
    expect(sent).toEqual(['\x1b[<66;2;2M', '\x1b[<67;2;2M'])
    engine.unmount()
  })

  it('reports a drag at most once per cell', async () => {
    const { engine, sent, down, move } = await mounted()
    engine.write('\x1b[?1002h\x1b[?1006h')
    down(15, 25)
    sent.length = 0
    move(35, 25)
    // Same cell: pixel motion inside one cell says nothing new, and reporting
    // it would put a burst of identical sequences on the wire.
    move(36, 25)
    move(39, 25)
    move(45, 25)
    expect(sent).toEqual(['\x1b[<32;4;2M', '\x1b[<32;5;2M'])
    engine.unmount()
  })

  it('reports every pixel of a drag once the program asks in pixels', async () => {
    const { engine, sent, down, move } = await mounted()
    engine.write('\x1b[?1002h\x1b[?1016h')
    down(15, 25)
    sent.length = 0
    move(35, 25)
    // Same cell as the last move, and it still reports: under 1016 that is
    // the entire point, and the per-cell check above would throw it away.
    move(36, 25)
    expect(sent).toEqual(['\x1b[<32;35;25M', '\x1b[<32;36;25M'])
    engine.unmount()
  })

  it('keeps reporting a drag that has left the pane, against the edge', async () => {
    const { engine, sent, down, move } = await mounted()
    engine.write('\x1b[?1002h\x1b[?1006h')
    down(15, 25)
    sent.length = 0
    // Far outside the surface. Unclamped this encodes to nothing at all and
    // the drag simply goes quiet, which is not what any terminal does.
    move(5000, 25)
    expect(sent).toEqual(['\x1b[<32;80;2M'])
    engine.unmount()
  })

  it('leaves the mouse to the terminal while shift is held', async () => {
    const { engine, sent, down } = await mounted()
    engine.write('\x1b[?1000h\x1b[?1006h')
    // Shift is the long-standing way to reach the terminal's own selection
    // while a full-screen program is grabbing the mouse.
    down(15, 25, 0, { shiftKey: true })
    expect(sent).toEqual([])
    engine.unmount()
  })

  it('stops reporting when the program turns tracking back off', async () => {
    const { engine, sent, down } = await mounted()
    engine.write('\x1b[?1000h\x1b[?1006h')
    down(15, 25)
    expect(sent).toHaveLength(1)
    engine.write('\x1b[?1000l')
    sent.length = 0
    down(15, 25)
    expect(sent).toEqual([])
    engine.unmount()
  })
})
