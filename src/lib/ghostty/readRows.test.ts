import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { GhosttyWasm } from './wasmBindings'

/**
 * What `readRows` gives its three callers (copy, word selection, search)
 * through a real core: joined text, per-column spans, and offset-to-column
 * mapping. Rows are text plus a column index, so the cases that matter are a
 * wide character (text in one column, an empty spacer), a grapheme cluster
 * (several characters in one column), and the blank right edge. Driven
 * through `getSelection` and `search`, with the renderer stubbed.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

type Sel = { start: { x: number; y: number }; end: { x: number; y: number }; rectangular?: boolean }

interface Internals {
  wasm: GhosttyWasm | null
  termPtr: number
  renderer: unknown
  _cols: number
  selection: { selectWordAt(pos: { x: number; y: number }): void }
  needsRedraw: boolean
}

describe('readRows, through its three callers', () => {
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

  afterEach(() => vi.unstubAllGlobals())

  async function engineWith(text: string) {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const engine = new GhosttyEngine()
    const inner = engine as unknown as Internals
    for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
    if (!inner.termPtr || !inner.wasm) throw new Error('core did not load')

    // Nothing is mounted, so size the engine (and the core) explicitly.
    engine.resize(40, 6)

    // Only what the selection path touches. Set after `resize`, which calls
    // `renderer.resize` itself.
    inner.renderer = {
      selection: null as Sel | null,
      getCellSize: () => ({ width: 10, height: 20 }),
      dispose: () => {},
    }
    engine.write(new TextEncoder().encode(text))
    // `readRows` reads the render state, normally refreshed by each drawn frame;
    // without this it reports zero columns.
    inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
    return { engine, inner }
  }

  function select(inner: Internals, start: Sel['start'], end: Sel['end'], rectangular = false) {
    ;(inner.renderer as { selection: Sel }).selection = { start, end, rectangular }
  }

  it('returns the text of a plain row, trailing grid padding trimmed', async () => {
    const { engine, inner } = await engineWith('hello world')
    select(inner, { x: 0, y: 0 }, { x: inner._cols - 1, y: 0 })
    expect(engine.getSelection()).toBe('hello world')
  })

  /** Trailing blanks are kept only when a selection ends partway along a row. */
  it('keeps trailing blanks only when the selection ends mid-row', async () => {
    const { engine, inner } = await engineWith('ab')
    select(inner, { x: 0, y: 0 }, { x: 5, y: 0 })
    expect(engine.getSelection()).toBe('ab    ')
  })

  /**
   * A wide character spans two columns but has one character of text; its
   * second column is an empty spacer.
   */
  it('gives a wide character one character across its two columns', async () => {
    const { engine, inner } = await engineWith('你好x')
    // Columns 0-1 are the two halves of 你, 2-3 of 好, 4 is x.
    select(inner, { x: 0, y: 0 }, { x: 4, y: 0 })
    expect(engine.getSelection()).toBe('你好x')

    // Just the first wide character, spacer included.
    select(inner, { x: 0, y: 0 }, { x: 1, y: 0 })
    expect(engine.getSelection()).toBe('你')

    // Its head column alone still yields the whole character.
    select(inner, { x: 0, y: 0 }, { x: 0, y: 0 + 0 })
    // A zero-width selection is empty, so widen by one column: the spacer adds
    // nothing.
    select(inner, { x: 1, y: 0 }, { x: 2, y: 0 })
    expect(engine.getSelection()).toBe('好')
  })

  /** A grapheme cluster is several characters in one column. */
  it('keeps a combining sequence whole in a single column', async () => {
    const { engine, inner } = await engineWith('éx')
    select(inner, { x: 0, y: 0 }, { x: 1, y: 0 })
    expect(engine.getSelection()).toBe('éx')
    select(inner, { x: 0, y: 0 }, { x: 0, y: 0 })
    // Zero-width selection: start === end short-circuits to ''.
    expect(engine.getSelection()).toBe('')
  })

  it('joins a multi-row selection with newlines', async () => {
    const { engine, inner } = await engineWith('one\r\ntwo\r\nthree')
    select(inner, { x: 0, y: 0 }, { x: inner._cols - 1, y: 2 })
    expect(engine.getSelection()).toBe('one\ntwo\nthree')
  })

  /**
   * A soft-wrapped line copies without a newline at the wrap point.
   */
  it('does not break a soft-wrapped line at the wrap point', async () => {
    const line = 'echo "' + 'x'.repeat(50) + '"' // 58 columns across a 40-column pane
    const { engine, inner } = await engineWith(line)
    select(inner, { x: 0, y: 0 }, { x: inner._cols - 1, y: 1 })
    expect(engine.getSelection()).toBe(line)
  })

  /** Joins follow wrap flags: a real newline after a wrapped line is kept. */
  it('keeps the real newline after a wrapped line', async () => {
    const long = 'a'.repeat(45)
    const { engine, inner } = await engineWith(long + '\r\nnext')
    select(inner, { x: 0, y: 0 }, { x: inner._cols - 1, y: 2 })
    expect(engine.getSelection()).toBe(long + '\nnext')
  })

  /** Every row of a column selection ends at the same arbitrary column, so all
   *  are trimmed. */
  it('trims every row of a rectangular selection', async () => {
    const { engine, inner } = await engineWith('abcdef\r\nghijkl')
    select(inner, { x: 1, y: 0 }, { x: 3, y: 1 }, true)
    expect(engine.getSelection()).toBe('bcd\nhij')
  })

  it('finds a match and reports the columns it covers', async () => {
    const { engine, inner } = await engineWith('the needle here')
    const results: { index: number; count: number }[] = []
    engine.onSearchResult((r) => results.push(r))
    engine.search('needle')
    expect(results.at(-1)?.count).toBe(1)

    // The match's own columns, read back via the selection path.
    select(inner, { x: 4, y: 0 }, { x: 9, y: 0 })
    expect(engine.getSelection()).toBe('needle')
  })

  /** A wide character's spacer adds no phantom character to the search text. */
  it('matches across a wide character without a phantom spacer character', async () => {
    const { engine } = await engineWith('a你b')
    const results: { index: number; count: number }[] = []
    engine.onSearchResult((r) => results.push(r))
    engine.search('a你b')
    expect(results.at(-1)?.count).toBe(1)
  })

  it('reports no match for something absent', async () => {
    const { engine } = await engineWith('nothing to see')
    const results: { index: number; count: number }[] = []
    engine.onSearchResult((r) => results.push(r))
    engine.search('absent')
    expect(results.at(-1)?.count).toBe(0)
  })

  /** Double-click selects a whole path, hence the wide word class. */
  it('selects a path as one word', async () => {
    const { engine, inner } = await engineWith('run /usr/local/bin/tool now')
    inner.selection.selectWordAt({ x: 6, y: 0 })
    expect(engine.getSelection()).toBe('/usr/local/bin/tool')
  })

  /**
   * Output arriving between the last frame and the copy doesn't change what a
   * standing selection yields: the active screen comes from the frame's
   * snapshot, so the scrollback depth must come from the same snapshot.
   */
  it('copies the rows the snapshot holds, not rows shifted by unpainted output', async () => {
    const lines = ['L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08']
    const { engine, inner } = await engineWith(lines.map((l) => l + '\r\n').join(''))
    // Through the engine, since recording the snapshot's depth is under test.
    engine.syncReadState()

    // Rows 0-2 are scrollback (L01-L03); 3-8 the active screen (L04-L08 and the
    // cursor's row).
    select(inner, { x: 0, y: 2 }, { x: inner._cols - 1, y: 5 })
    const before = engine.getSelection()
    expect(before).toBe('L03\nL04\nL05\nL06')

    // Two more lines without a frame: scrollback grows to five while the
    // snapshot holds three.
    engine.write(new TextEncoder().encode('L09\r\nL10\r\n'))

    // Same rows, same text.
    expect(engine.getSelection()).toBe(before)
  })

  it('stops a word at a space on both sides', async () => {
    const { engine, inner } = await engineWith('alpha beta gamma')
    inner.selection.selectWordAt({ x: 7, y: 0 })
    expect(engine.getSelection()).toBe('beta')
  })

  /**
   * Clicking a wide character's spacer resolves to its head. Also pins that the
   * word stops at the spacer (`ab你cd` selects `ab你`), since a spacer reads as
   * a space; unchanged by the row representation, and not addressed here.
   */
  it('resolves a click on a wide character spacer to its head', async () => {
    const { engine, inner } = await engineWith('ab你cd')
    // Column 3 is the trailing half of 你 (columns 2-3).
    inner.selection.selectWordAt({ x: 3, y: 0 })
    expect(engine.getSelection()).toBe('ab你')
  })
})
