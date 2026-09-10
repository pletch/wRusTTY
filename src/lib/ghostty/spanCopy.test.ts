import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { GhosttyWasm } from './wasmBindings'

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

const COLS = 66
const ROWS = 8

interface Internals {
  wasm: GhosttyWasm | null
  termPtr: number
  renderer: { selection: unknown }
  scrollbackLength: number
  rowReadFailures: { row: number; why: string }[]
}

/**
 * Copying a range that starts above the visible viewport.
 *
 * `readRows` splits on the scrollback depth: rows above it come one at a time
 * through `get_scrollback_line`, rows at or below it come out of the batched
 * viewport buffer. A selection that begins in scrollback and ends on screen
 * crosses that seam, and the report is that such a copy loses text while the
 * same text copied without scrolling back comes out whole.
 */
describe('a selection spanning scrollback and the visible screen', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('fetch', async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength),
    }))
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  async function pane() {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const e = new GhosttyEngine()
    const inner = e as unknown as Internals
    for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
    if (!inner.termPtr || !inner.wasm) throw new Error('core did not load')
    e.resize(COLS, ROWS)
    inner.renderer = {
      selection: null,
      getCellSize: () => ({ width: 10, height: 20 }),
      resize: () => {},
      dispose: () => {},
    } as never
    return { e, inner }
  }

  const write = (e: { write(b: Uint8Array): void }, s: string) =>
    e.write(new TextEncoder().encode(s))

  /** Paragraphs long enough to wrap at 66 columns, so the seam can land inside
   *  a wrapped line rather than only between whole ones. */
  function paras(n: number): string[] {
    const out: string[] = []
    for (let i = 0; i < n; i++) {
      out.push(
        `Paragraph ${i} is deliberately longer than the pane so that it wraps ` +
          `across more than one row and the join has something to do here.`,
      )
    }
    return out
  }

  it('copies every row of a range that begins above the viewport', async () => {
    const { e, inner } = await pane()
    const body = paras(20)
    write(e, body.join('\r\n') + '\r\n')
    inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
    ;(e as unknown as { syncReadState(): void }).syncReadState()

    const total = inner.scrollbackLength
    // The whole buffer: rows 0..total-1 spans deep scrollback through to the
    // rows still on screen, crossing the seam once.
    inner.renderer.selection = { start: { x: 0, y: 0 }, end: { x: COLS - 1, y: total - 1 } }
    const got = e.getSelection()

    expect(inner.rowReadFailures).toEqual([])
    for (const p of body) expect(got).toContain(p)
  })

  /**
   * The reported case: the pane is scrolled back, and the selection runs from
   * above the visible rows down into them. Copying the same text without
   * scrolling first was said to come out whole, so the scroll position is the
   * variable -- and nothing in `readRows` reads it, which is what makes this
   * worth asserting rather than assuming.
   */
  it('copies a spanning range while the viewport is scrolled back', async () => {
    const { e, inner } = await pane()
    const body = paras(20)
    write(e, body.join('\r\n') + '\r\n')
    inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
    ;(e as unknown as { syncReadState(): void }).syncReadState()

    const total = inner.scrollbackLength
    // Look at the top of the buffer, as a person reading back through it would.
    e.scrollToLine(0)
    inner.renderer.selection = { start: { x: 0, y: 0 }, end: { x: COLS - 1, y: total - 1 } }
    const got = e.getSelection()

    expect(inner.rowReadFailures).toEqual([])
    for (const p of body) expect(got).toContain(p)
  })

  /**
   * The same, with output still arriving while the view is held up the buffer.
   * `pinViewport` grows the offset to hold the text still, the snapshot moves
   * under it every frame, and a copy taken in that state has to agree with
   * both.
   */
  it('copies a spanning range while scrolled back and output is still arriving', async () => {
    const { e, inner } = await pane()
    const body = paras(20)
    write(e, body.join('\r\n') + '\r\n')
    inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
    ;(e as unknown as { syncReadState(): void }).syncReadState()
    e.scrollToLine(0)

    // Output lands while the reader is up the buffer, twice, with a frame
    // between -- which is what makes the snapshot and the live depth diverge.
    write(e, 'late line\r\n'.repeat(3))
    inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
    ;(e as unknown as { syncReadState(): void }).syncReadState()
    write(e, 'later line\r\n'.repeat(3))

    const total = inner.scrollbackLength
    inner.renderer.selection = { start: { x: 0, y: 0 }, end: { x: COLS - 1, y: total - 1 } }
    const got = e.getSelection()

    expect(inner.rowReadFailures).toEqual([])
    for (const p of body) expect(got).toContain(p)
    expect(got).toContain('later line')
  })
})
