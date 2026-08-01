// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Mark mode's grip on the keyboard, through the engine's real listeners.
 *
 * `markMode.test.ts` covers the rules; this covers the one thing only the wiring
 * can get wrong, and the thing the whole feature rests on: that a key the mode
 * claims is taken *before* the input handler turns it into a sequence on the
 * wire. The two live on different elements — the mode listens on the container
 * in the capture phase, the input handler on the textarea inside it — and
 * nothing about that ordering is visible from either file alone.
 *
 * The core is deliberately absent, as in the drag tests: the renderer is stubbed
 * to the members the selection path uses, which is what lets this run without
 * WebGL or WASM.
 */

const CELL = { width: 10, height: 20 }

type Sel = { start: { x: number; y: number }; end: { x: number; y: number } }

async function mounted() {
  const { GhosttyEngine } = await import('./GhosttyEngine')
  const engine = new GhosttyEngine()
  const container = document.createElement('div')
  document.body.appendChild(container)
  engine.mount(container)

  const inner = engine as unknown as { renderer: unknown }
  inner.renderer = { selection: null as Sel | null, getCellSize: () => CELL, dispose: () => {} }

  const sent: string[] = []
  engine.onData((d) => sent.push(d))

  const input = container.querySelector('textarea')!
  const press = (key: string, mods: KeyboardEventInit = {}) =>
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...mods }))
  const selection = () => (inner.renderer as { selection: Sel | null }).selection

  return { engine, container, sent, press, selection }
}

beforeEach(() => {
  vi.stubGlobal('fetch', async () => ({
    ok: false,
    status: 404,
    arrayBuffer: async () => new ArrayBuffer(0),
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
    // The reason keyboard selection is a mode at all: these belong to whatever
    // is running, and shift+arrow is a sequence programs bind.
    expect(sent).toEqual(['\x1b[A', '\x1b[1;2A'])
    engine.unmount()
  })

  it('takes the arrow keys once it is on, and sends nothing', async () => {
    const { engine, sent, press, selection } = await mounted()
    engine.toggleMarkMode()
    expect(engine.isMarkMode()).toBe(true)
    // Downwards: with no core there is no scrollback and the cursor opens on
    // row 0, where up is clamped.
    const from = selection()!.end.y
    press('ArrowDown')
    press('ArrowDown', { shiftKey: true })
    // Nothing reached the wire: a key that both moved the mark cursor and got
    // sent would be doing two contradictory things at once.
    expect(sent).toEqual([])
    expect(selection()!.end.y).toBe(from + 2)
    // The second press was shifted, so it left a selection behind rather than
    // just a cursor.
    expect(selection()!.start.y).toBe(from + 1)
    engine.unmount()
  })

  it('gives them back on Escape', async () => {
    const { engine, sent, press } = await mounted()
    engine.toggleMarkMode()
    press('Escape')
    expect(engine.isMarkMode()).toBe(false)
    // Escape itself is consumed by the exit — it is the way out of the mode.
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
    // Left on, the mode would keep the arrow keys captured while pointing at a
    // selection the drag has already replaced.
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
    // The listener lives on the container, which outlives the engine — a mode
    // left armed on a dead pane would swallow keys with nothing to show for it.
    expect(sent).toEqual([])
    expect(engine.isMarkMode()).toBe(false)
  })
})
