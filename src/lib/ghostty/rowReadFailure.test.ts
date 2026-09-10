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
}

/**
 * What copy does when the core declines to hand back a row.
 *
 * `ghostty_terminal_get_scrollback_line` answers 0 when `grid_ref` will not
 * resolve the row, and leaves the caller's buffer untouched when it does.
 * `readRows` used to discard that answer, so the miss reached copy as content:
 * spaces on a fresh buffer, the previous row's text on a reused one.
 *
 * The first test is the one that matters for the reported fault -- a wrapped
 * line whose continuation row misses comes back cut at exactly the pane width,
 * with the line break intact. That is the signature seen in the wild, and it
 * is reproduced here from nothing but a refused read.
 */
describe('a scrollback row the core will not hand back', () => {
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

  /** Makes exactly the given absolute rows refuse to read. */
  function refuse(inner: Internals, rows: number[]) {
    const ex = inner.wasm!.exports as unknown as Record<string, unknown>
    const real = ex.ghostty_terminal_get_scrollback_line as (...a: number[]) => number
    ex.ghostty_terminal_get_scrollback_line = (term: number, off: number, out: number, cells: number) =>
      rows.includes(off) ? 0 : real(term, off, out, cells)
  }

  /** Enough to push the lines above it out of the active screen and into
   *  scrollback, which is the only place `get_scrollback_line` is consulted. */
  const FILLER = 'filler\r\n'.repeat(20)

  // 79 characters: at 66 columns that is a row of 66 and a row of 13.
  const logical =
    'The 4:2:0 inconsistency is back, and I am not dismissing it, a session can go'.padEnd(79, '.')

  it('cuts a wrapped line at exactly the pane width when its continuation misses', async () => {
    const { e, inner } = await pane()
    e.write(new TextEncoder().encode(`${logical}\r\ntail line\r\n${FILLER}`))
    inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
    ;(e as unknown as { syncReadState(): void }).syncReadState()

    // Row 1 is the continuation of the line that began on row 0.
    refuse(inner, [1])
    inner.renderer.selection = { start: { x: 0, y: 0 }, end: { x: COLS - 1, y: 2 } }
    const got = e.getSelection()

    const firstLine = got.split('\n')[0]
    expect(firstLine.length).toBe(COLS)
    expect(firstLine).toBe(logical.slice(0, COLS))
    // The break survives, which is why this reads as a short line rather than
    // as an obviously missing row.
    expect(got.split('\n')[1]).toBe('tail line')
  })

  /**
   * The other shape the same fault takes, and the one that explains the long
   * runs of spaces in a real report. When the row that *starts* a wrapped line
   * misses, the flag still says the next row continues it -- so the blank is
   * kept untrimmed, on purpose, as mid-line content. A pane's width of spaces
   * is spliced into the middle of the text where the words used to be.
   */
  it('splices a pane-width run of spaces in when the first row misses', async () => {
    const { e, inner } = await pane()
    e.write(new TextEncoder().encode(`before\r\n${logical}\r\ntail line\r\n${FILLER}`))
    inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
    ;(e as unknown as { syncReadState(): void }).syncReadState()

    // Row 0 is "before", row 1 starts the wrapped line, row 2 continues it.
    refuse(inner, [1])
    inner.renderer.selection = { start: { x: 0, y: 0 }, end: { x: COLS - 1, y: 3 } }
    const got = e.getSelection()

    const out = got.split('\n')
    expect(out[0]).toBe('before')
    // The lost row is not omitted -- it is kept as its full width in spaces,
    // because the wrap flag still says it runs into the row after it.
    expect(out[1]).toBe(' '.repeat(COLS) + logical.slice(COLS))
    // And the words that were on it are gone without a mark.
    expect(got).not.toContain(logical.slice(0, COLS))
  })

  it('reports the refused rows in the dump instead of passing them off as blank', async () => {
    const { e, inner } = await pane()
    e.write(new TextEncoder().encode(`${logical}\r\ntail line\r\n${FILLER}`))
    inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
    ;(e as unknown as { syncReadState(): void }).syncReadState()
    refuse(inner, [1])
    inner.renderer.selection = { start: { x: 0, y: 0 }, end: { x: COLS - 1, y: 2 } }

    const dump = e.dumpState()
    expect(dump).toContain('row reads: 1 FAILED and read as blank')
    // Named, because a blank from a refused read and a blank from a row the
    // snapshot cannot answer for call for different fixes.
    expect(dump).toContain('refused by the core: 1 (rows 1)')
  })

  /**
   * The other way a blank is invented, and one nothing had to stub: output
   * landing after the last drawn frame. `readRows` maps absolute rows through
   * the snapshot's scrollback depth, so once the live buffer has grown past it
   * the rows at the bottom of the selection fall outside the snapshot's screen
   * and come back blank. Copy between frames is exactly when this happens.
   *
   * Asserted through `getSelection` rather than the dump on purpose: the dump
   * re-syncs before it reads, so it can never see this through its own rows.
   * What it reports instead is the live/snapshot gap on its header line, which
   * it samples before syncing -- see `dumpState`.
   */
  it('refreshes for copy, and names the lost rows for anyone who does not', async () => {
    const { e, inner } = await pane()
    e.write(new TextEncoder().encode('line one\r\ntwo\r\nthree\r\n' + FILLER))
    inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
    ;(e as unknown as { syncReadState(): void }).syncReadState()
    // A frame drew; now more output arrives before anyone copies.
    e.write(new TextEncoder().encode('late\r\n'.repeat(4)))

    const total = inner.scrollbackLength
    inner.renderer.selection = { start: { x: 0, y: 0 }, end: { x: COLS - 1, y: total - 1 } }
    const failuresOf = (e as unknown as { rowReadFailures: { row: number; why: string }[] })

    // A caller that reads without refreshing first loses the tail, and now
    // says which rows and why instead of returning spaces.
    ;(e as unknown as { readRowText(a: number, b: number): unknown }).readRowText(0, total - 1)
    expect(failuresOf.rowReadFailures.length).toBeGreaterThan(0)
    expect(failuresOf.rowReadFailures.every((f) => f.why === 'past the snapshot screen')).toBe(true)
    expect(Math.max(...failuresOf.rowReadFailures.map((f) => f.row))).toBe(total - 1)

    // Copy refreshes, so it keeps its tail: the last thing written is in it,
    // and nothing was invented along the way.
    const got = e.getSelection()
    expect(failuresOf.rowReadFailures).toEqual([])
    expect(got).toContain('late')
    expect(got.split('\n').filter((l) => l.trim() === 'late')).toHaveLength(4)
  })

  it('says every row came back when none refused', async () => {
    const { e, inner } = await pane()
    e.write(new TextEncoder().encode(`${logical}\r\ntail line\r\n${FILLER}`))
    inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
    ;(e as unknown as { syncReadState(): void }).syncReadState()
    inner.renderer.selection = { start: { x: 0, y: 0 }, end: { x: COLS - 1, y: 2 } }

    const dump = e.dumpState()
    expect(dump).toContain('row reads: all rows above came back from the core')
    // And the line is whole, which is what makes the test above meaningful.
    expect(e.getSelection().split('\n')[0]).toBe(logical)
  })
})
