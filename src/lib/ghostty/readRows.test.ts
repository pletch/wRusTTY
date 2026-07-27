import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { GhosttyWasm } from './wasmBindings'

/**
 * What `readRows` hands its three callers, through a real core.
 *
 * There was no coverage here at all, which is why this exists: copy, word
 * selection and search are the only readers of the cell walk, and each depends
 * on a different part of what it returns — the joined text, the per-column
 * spans, and the mapping from a character offset back to a column. A row is
 * now stored as text plus a column index rather than one string per cell, and
 * the cases that distinguish those two representations are exactly the ones
 * that were never tested: a wide character (one column of text, one empty
 * spacer column), a grapheme cluster (one column, several characters), and the
 * blank right-hand edge.
 *
 * Driven through the public surface — `getSelection`, `search` — with the
 * renderer stubbed, since none of this needs WebGL.
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

    // Nothing is mounted, so the engine has no size of its own — and a row is
    // `_cols` columns wide by definition, so without this every read is empty.
    // `resize` is also what sizes the core, so this is the real path.
    engine.resize(40, 6)

    // Only the members the selection path touches. It never draws. Set after
    // `resize` so its own `renderer.resize` call isn't the stub's problem.
    inner.renderer = {
      selection: null as Sel | null,
      getCellSize: () => ({ width: 10, height: 20 }),
      dispose: () => {},
    }
    engine.write(new TextEncoder().encode(text))
    // `readRows` reads the core's render state, which is populated by
    // `ghostty_render_state_update` on each drawn frame. In the app that has
    // always happened by the time a user can copy or search; here nothing
    // draws, so this stands in for the frame. Without it the render state
    // reports zero columns and every read comes back empty.
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

  /** The blank right-hand edge is grid padding, not content — but a selection
   *  that stops part-way along a row chose the spaces it dragged over. */
  it('keeps trailing blanks only when the selection ends mid-row', async () => {
    const { engine, inner } = await engineWith('ab')
    select(inner, { x: 0, y: 0 }, { x: 5, y: 0 })
    expect(engine.getSelection()).toBe('ab    ')
  })

  /**
   * The case a bare `string` per row cannot represent: a wide character
   * occupies two columns but has one character of text, and its second column
   * is a spacer holding nothing.
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
    // A zero-width selection is empty by definition, so widen by one row-free
    // column: the spacer contributes nothing of its own.
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

  /** Every row of a column selection ends at the same arbitrary column, so
   *  none of them keeps its padding. */
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

    // The match's own columns, read back through the selection path.
    select(inner, { x: 4, y: 0 }, { x: 9, y: 0 })
    expect(engine.getSelection()).toBe('needle')
  })

  /** Search matches on the row's joined text, so a wide character must not
   *  contribute a phantom character for its spacer column. */
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

  /** Double-click selects a whole path, not just the segment under the
   *  pointer — that's the reason the word class is as wide as it is. */
  it('selects a path as one word', async () => {
    const { engine, inner } = await engineWith('run /usr/local/bin/tool now')
    inner.selection.selectWordAt({ x: 6, y: 0 })
    expect(engine.getSelection()).toBe('/usr/local/bin/tool')
  })

  it('stops a word at a space on both sides', async () => {
    const { engine, inner } = await engineWith('alpha beta gamma')
    inner.selection.selectWordAt({ x: 7, y: 0 })
    expect(engine.getSelection()).toBe('beta')
  })

  /**
   * Clicking a wide character's spacer resolves to the character it belongs
   * to rather than selecting nothing.
   *
   * Note what this also pins: the word *stops* at the spacer. Scanning right
   * reads column 3 as empty, `'' || ' '` makes it a space, and a space ends a
   * word — so `ab你cd` double-clicks as `ab你`, not the whole run. That is
   * pre-existing behaviour, identical before and after the row representation
   * changed (the old per-cell form stored `''` for a spacer and hit the same
   * `|| ' '`), and it is recorded here rather than fixed because this pass is
   * about what `readRows` allocates, not about what counts as a word.
   */
  it('resolves a click on a wide character spacer to its head', async () => {
    const { engine, inner } = await engineWith('ab你cd')
    // Column 3 is the trailing half of 你 (columns 2-3).
    inner.selection.selectWordAt({ x: 3, y: 0 })
    expect(engine.getSelection()).toBe('ab你')
  })
})
