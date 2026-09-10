import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { GhosttyWasm } from './wasmBindings'

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

const COLS = 40
const ROWS = 8

interface Internals {
  wasm: GhosttyWasm | null
  termPtr: number
  renderer: { selection: unknown }
  scrollbackLength: number
}

/**
 * The dump is a diagnostic, so what it must not do is agree with the thing it
 * is diagnosing. These assert it reports the grid independently: the rows come
 * back with their trailing spaces intact, the wrap flag is marked where the
 * core actually set one, and the selection text is the same string copy would
 * have put on the clipboard.
 */
describe('the pane dump', () => {
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

  async function paneWith(text: string) {
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
    e.write(new TextEncoder().encode(text))
    return { e, inner }
  }

  // Wraps at 40 columns, then a hard newline, then a short line.
  const wrapped = 'the pacing loop is now doing light work rather than fighting'
  const payload = `${wrapped}\r\nshort tail`

  it('reports the geometry, every row, and the wrap flags', async () => {
    const { e, inner } = await paneWith(payload)
    inner.renderer.selection = { start: { x: 0, y: 0 }, end: { x: COLS - 1, y: 2 } }
    const dump = e.dumpState()

    expect(dump).toContain(`cols=${COLS} rows=${ROWS}`)
    expect(dump).toContain('altScreen=false')
    expect(dump).toContain('selection=(0,0)..(39,2) rectangular=false')

    // Row 0 is the head of the wrapped line and row 1 continues it, so exactly
    // one of the first two rows is marked -- the same flag copy joins on.
    const rowLines = dump.split('\n').filter((l) => /^\s*\d+ (cont|    ) "/.test(l))
    expect(rowLines.length).toBe(inner.scrollbackLength)
    expect(rowLines[0]).not.toContain('cont')
    expect(rowLines[1]).toContain('cont')
    expect(rowLines[2]).not.toContain('cont')

    // Quoted, so the padding that decides trimming is visible rather than lost.
    expect(rowLines[2]).toContain('"short tail')
    expect(rowLines[2]).toContain(' "')
  })

  it('records the selection text copy would produce, verbatim', async () => {
    const { e, inner } = await paneWith(payload)
    inner.renderer.selection = { start: { x: 0, y: 0 }, end: { x: COLS - 1, y: 2 } }
    const dump = e.dumpState()
    expect(dump).toContain(JSON.stringify(e.getSelection()))
    expect(dump).toContain(JSON.stringify(`${wrapped}\nshort tail`))
  })

  /**
   * The bound is what makes this cheap enough to hit on reflex. A pane with a
   * deep scrollback must not dump all of it, and must still say where in the
   * buffer the rows it did dump came from.
   */
  it('dumps the selection and a margin, not the whole scrollback', async () => {
    const { e, inner } = await paneWith('filler\r\n'.repeat(400))
    const total = inner.scrollbackLength
    inner.renderer.selection = { start: { x: 0, y: 300 }, end: { x: COLS - 1, y: 302 } }
    const dump = e.dumpState()

    const rowLines = dump.split('\n').filter((l) => /^\s*\d+ (cont|    ) "/.test(l))
    expect(total).toBeGreaterThan(400)
    // The three selected rows plus 20 either side, and nothing like the buffer.
    expect(rowLines.length).toBe(43)
    expect(dump).toContain('rows 280..322 of ')
    // Absolute numbering, so a row named here is the row copy read.
    expect(rowLines[0].trim().startsWith('280')).toBe(true)
  })

  it('says so, and says why it matters, when there is no selection', async () => {
    const { e } = await paneWith(payload)
    const dump = e.dumpState()
    expect(dump).toContain('selection=none')
    // A dump with no selection proves only that the grid is fine now, which is
    // never the question. It has to say so rather than read as a clean bill.
    expect(dump).toContain('cannot show what copy produced')
    expect(dump).toContain('before resizing the pane')
  })

  it('records the width the rows were read at', async () => {
    const { e } = await paneWith(payload)
    expect(e.dumpState()).toContain(`rows below are as they are at ${COLS} columns`)
  })

  it('flags a snapshot that has fallen behind the live scrollback', async () => {
    const { e, inner } = await paneWith('filler\r\n'.repeat(30))
    // A frame drew, then more output landed: this is the state a copy taken
    // mid-flood reads from, and the gap is the first thing to rule out.
    inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
    ;(e as unknown as { syncReadState(): void }).syncReadState()
    e.write(new TextEncoder().encode('late\r\n'.repeat(5)))
    expect(e.dumpState()).toContain('MISMATCH')
  })
})
