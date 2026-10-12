import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { SearchResult } from '../terminalEngine'
import type { GhosttyWasm } from './wasmBindings'
import type { SearchHighlight } from './WebGLRenderer'

/**
 * The core's find-in-scrollback, against the binary that ships.
 *
 * Checks two things: that the native path finds and navigates what the JS
 * one does, and (as differentials) the cases where the JS one is wrong. Those
 * all involve the terminal moving while the find bar is open: output, a
 * resize, eviction. `SearchController` only rebuilds inside `search()`, while
 * the core is fed every frame and reconciles.
 *
 * `frame()` stands in for the render loop; everything else goes through the
 * engine's public surface, so routing between the controllers is exercised.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

interface Internals {
  wasm: GhosttyWasm | null
  termPtr: number
  renderer: unknown
  _cols: number
  nativeSearch: { onFrame(): void } | null
  needsRedraw: boolean
}

describe('native find-in-scrollback', () => {
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

  async function engineWith(text: string, cols = 40, rows = 6) {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const engine = new GhosttyEngine()
    const inner = engine as unknown as Internals
    for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
    if (!inner.termPtr || !inner.wasm) throw new Error('core did not load')
    engine.resize(cols, rows)

    // Only what the search paths touch; nothing draws.
    const renderer = {
      searchHighlights: null as Map<number, SearchHighlight[]> | null,
      selection: null,
      getCellSize: () => ({ width: 10, height: 20 }),
      resize: () => {},
      dispose: () => {},
    }
    inner.renderer = renderer

    const results: SearchResult[] = []
    engine.onSearchResult((r) => results.push(r))
    if (text) engine.write(new TextEncoder().encode(text))
    // The JS path reads rows off the render snapshot (see readRows.test.ts).
    inner.wasm.exports.ghostty_render_state_update(inner.termPtr)

    return {
      engine,
      inner,
      results,
      highlights: () => renderer.searchHighlights,
      last: () => results[results.length - 1],
      /** What the render loop does for a live search: feed the core and redraw
       *  from the result. */
      frame: () => {
        inner.nativeSearch?.onFrame()
        inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
      },
      write: (s: string) => {
        engine.write(new TextEncoder().encode(s))
        inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
      },
    }
  }

  const lines = (n: number, needleEvery = 3) =>
    Array.from({ length: n }, (_, i) => (i % needleEvery === 0 ? `row ${i} needle here` : `row ${i} plain`)).join(
      '\r\n',
    ) + '\r\n'

  /** Lines wider than the pane, so halving the width reflows every one. */
  const wideLines = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      i % 3 === 0
        ? `row ${i} ${'pad '.repeat(6)}needle ${'tail '.repeat(4)}`
        : `row ${i} ${'pad '.repeat(6)}plain ${'tail '.repeat(4)}`,
    ).join('\r\n') + '\r\n'

  it('is the path a plain query takes, and it finds every hit', async () => {
    const t = await engineWith(lines(30))
    expect(t.inner.nativeSearch, 'the shipped binary should have the search API').not.toBeNull()

    t.engine.search('needle')
    expect(t.last().count).toBe(10)
  })

  /** Upstream's matcher always folds ASCII case, so case-sensitive queries go to
   *  the JS controller. Both counts are asserted, since the routing is invisible
   *  from outside. */
  it('routes case-sensitive and regex queries to the JS path', async () => {
    const t = await engineWith('Needle\r\nneedle\r\nNEEDLE\r\n')

    t.engine.search('needle')
    expect(t.last().count, 'native matching folds ASCII case').toBe(3)

    t.engine.search('needle', { caseSensitive: true })
    expect(t.last().count, 'the JS path honors the toggle').toBe(1)

    // The regex toggle really is a regex: the core finds nothing byte for byte.
    t.engine.search('ne+dle', { regex: true })
    expect(t.last().count).toBe(3)
    t.engine.search('ne+dle')
    expect(t.last().count).toBe(0)
  })

  /**
   * The find bar's Next (a down chevron, toward newer content) is the core's
   * SELECT_PREV. A fresh query lands on the newest hit (n/n), and Next wraps
   * to 1/n.
   */
  it('walks forward and back through the hits', async () => {
    const t = await engineWith(lines(30))
    t.engine.search('needle')
    const count = t.last().count
    expect(t.last().index, 'a fresh query starts at the newest hit').toBe(count - 1)

    t.engine.search('needle')
    expect(t.last().index, 'forward from the newest wraps to the oldest').toBe(0)
    t.engine.search('needle')
    expect(t.last().index).toBe(1)

    t.engine.search('needle', { back: true })
    expect(t.last().index).toBe(0)
    t.engine.search('needle', { back: true })
    expect(t.last().index, 'back from the oldest wraps to the newest').toBe(count - 1)
  })

  /**
   * Exactly one highlight is `active` (drawn amber), and it moves.
   */
  it('marks exactly one highlight as the current hit, and moves it', async () => {
    const t = await engineWith(`a needle 0\r\nb needle 1\r\nc needle 2\r\nd needle 3\r\n`, 40, 8)
    const activeRows = () => {
      const byRow = t.highlights()
      if (!byRow) return []
      return [...byRow.entries()].filter(([, hl]) => hl.some((h) => h.active)).map(([row]) => row)
    }

    t.engine.search('needle')
    expect(activeRows().length).toBe(1)
    const first = activeRows()[0]

    t.engine.search('needle')
    expect(activeRows().length).toBe(1)
    expect(activeRows()[0]).not.toBe(first)

    // A frame that changes nothing keeps it.
    t.frame()
    expect(activeRows().length).toBe(1)
  })

  /** An incremental keystroke re-runs the query without moving the selection. */
  it('holds its place on an incremental keystroke', async () => {
    const t = await engineWith(lines(30))
    t.engine.search('needle')
    const at = t.last().index
    t.engine.search('needle', { incremental: true })
    expect(t.last().index).toBe(at)
  })

  it('highlights the columns the hit actually occupies', async () => {
    const t = await engineWith('alpha needle omega\r\n')
    t.engine.search('needle')
    const byRow = t.highlights()
    expect(byRow, 'a match should produce highlights').not.toBeNull()
    const rows = [...byRow!.entries()].filter(([, hl]) => hl.length > 0)
    expect(rows.length).toBe(1)
    const [, hl] = rows[0]
    // "alpha " is six columns; endpoints are inclusive.
    expect(hl[0].from).toBe(6)
    expect(hl[0].to).toBe(11)
    expect(hl[0].active).toBe(true)
  })

  it('clears everything when the query goes away', async () => {
    const t = await engineWith(lines(30))
    t.engine.search('needle')
    expect(t.highlights()).not.toBeNull()
    t.engine.search('')
    expect(t.highlights()).toBeNull()
    // Stays cleared across frames.
    t.frame()
    expect(t.highlights()).toBeNull()
  })

  it('reports nothing found without clearing the query', async () => {
    const t = await engineWith(lines(30))
    t.engine.search('haystack')
    expect(t.last()).toEqual({ index: -1, count: 0 })
  })

  /**
   * A scrollback too deep to search in one frame: the keystroke returns a
   * partial count rather than freezing, and the slices converge on what the JS
   * matcher counts. Progress per frame is bounded by the core's feed chunk,
   * hence the generous frame cap.
   */
  it('finishes a deep search across frames rather than blocking one', async () => {
    const t = await engineWith(lines(20000), 80, 24)
    t.engine.search('needle')
    const firstSlice = t.last().count
    expect(firstSlice, 'the first slice should find something').toBeGreaterThan(0)

    let stable = 0
    for (let i = 0; i < 600 && stable < 3; i++) {
      const before = t.last().count
      t.frame()
      stable = t.last().count === before ? stable + 1 : 0
    }
    const settled = t.last().count
    expect(settled, 'a slice is a partial answer, not the whole one').toBeGreaterThan(firstSlice)

    // The same buffer matched in JS; the count depends on pruning, so only
    // agreement is asserted.
    const j = await engineWith(lines(20000), 80, 24)
    j.engine.search('needle', { regex: true })
    expect(settled).toBe(j.last().count)
  })

  /**
   * Highlights are for the rows the pane is showing. `VIEWPORT_MATCHES` is
   * relative to the core's viewport, which never moves (our renderer owns the
   * offset, with SEARCH_SCROLL_NONE).
   */
  it('highlights the rows the pane is showing, not the ones the core thinks it is', async () => {
    const t = await engineWith(lines(3000), 80, 24)
    t.engine.search('needle')
    // The first keystroke only searches one slice of 3,000 rows; let it catch up
    // before scrolling.
    for (let i = 0; i < 200; i++) t.frame()

    const visible = () => {
      const byRow = t.highlights()
      if (!byRow) return 0
      const top = t.engine.viewportY
      return [...byRow.keys()].filter((r) => r >= top && r < top + 24).length
    }
    expect(visible(), 'at the bottom of the buffer').toBeGreaterThan(0)

    t.engine.scrollLines(-1500)
    t.frame()
    expect(visible(), 'and 1,500 rows back, where the bug was').toBeGreaterThan(0)

    // Every highlighted row is on screen.
    const top = t.engine.viewportY
    const rows = [...t.highlights()!.keys()]
    expect(rows.every((r) => r >= top - 2 && r < top + 24 + 2)).toBe(true)
  })

  /**
   * A query typed while scrolled back starts from what's on screen. The scan
   * runs newest to oldest within a per-frame budget, so the selection keeps
   * walking back over later frames; asserting after only one frame would pass
   * a build that settles for whatever it found first.
   */
  it('starts a fresh query from the viewport, not the bottom of the buffer', async () => {
    const t = await engineWith(lines(3000), 80, 24)
    t.engine.scrollLines(-1500)
    for (let i = 0; i < 5; i++) t.frame()
    const anchor = t.engine.viewportY
    expect(anchor, 'scrolled well back').toBeLessThan(2000)

    t.engine.search('needle')
    for (let i = 0; i < 200; i++) t.frame()

    expect(t.last().count, 'the whole buffer, however far the view is from it').toBe(1000)
    // It selects the first match at or after the row the query was typed at.
    const rows = [...t.highlights()!.keys()]
    expect(Math.min(...rows), 'the selection is near where the user was reading').toBeGreaterThanOrEqual(
      anchor - 24,
    )
    expect(Math.max(...rows)).toBeLessThan(anchor + 48)
  })

  /* ---- the differentials: the terminal moves under an open find bar ---- */

  /**
   * Output arriving while the find bar is open updates the count; the JS
   * controller keeps the old number until the next keystroke.
   */
  it('counts output that arrives after the search, where the JS path does not', async () => {
    const t = await engineWith(lines(30))

    t.engine.search('needle')
    expect(t.last().count).toBe(10)
    t.write('a late needle\r\n')
    t.frame()
    expect(t.last().count, 'the core was fed and saw the new line').toBe(11)

    // Same situation on the JS path (the regex toggle routes there).
    const j = await engineWith(lines(30))
    j.engine.search('needle', { regex: true })
    expect(j.last().count).toBe(10)
    j.write('a late needle\r\n')
    j.frame()
    expect(j.last().count, 'nothing re-ran, so nothing noticed').toBe(10)
  })

  /**
   * A resize reflows the buffer; the JS controller keeps stale absolute rows,
   * while the core reconciles on the next feed.
   */
  it('survives a resize, where the JS path is left holding stale rows', async () => {
    const t = await engineWith(wideLines(20), 40, 6)
    t.engine.search('needle')
    const before = t.highlights()
    expect(before).not.toBeNull()

    t.engine.resize(20, 6)
    t.frame()
    const after = t.highlights()
    expect(after, 'still highlighting something after the reflow').not.toBeNull()
    // At half width every wrapped line is two rows, so the rows moved.
    expect([...after!.keys()]).not.toEqual([...before!.keys()])

    const j = await engineWith(wideLines(20), 40, 6)
    j.engine.search('needle', { regex: true })
    const jBefore = j.highlights()
    j.engine.resize(20, 6)
    j.frame()
    expect([...j.highlights()!.keys()], 'unchanged, and therefore wrong').toEqual([...jBefore!.keys()])
  })

  /**
   * Matches evicted from a capped scrollback are pruned on the next feed; the
   * JS controller's list still points at rows now holding something else.
   */
  it('drops matches that scrollback eviction took away', async () => {
    const t = await engineWith(lines(20), 40, 6)
    t.engine.search('needle')
    const found = t.last().count
    expect(found).toBeGreaterThan(0)

    // The default 8 MB footprint is a ~4 MB byte budget, roughly eleven thousand
    // rows at this width (see vendor/README.md).
    t.write(Array.from({ length: 15000 }, (_, i) => `filler ${i}`).join('\r\n') + '\r\n')
    t.frame()
    expect(t.last().count, 'the evicted hits are gone').toBeLessThan(found)
  })

  /**
   * The core keeps the primary screen's results across an alternate-screen
   * round trip, so opening `vim` doesn't restart a search.
   */
  it('keeps the primary screen results across an alternate-screen round trip', async () => {
    const t = await engineWith(lines(30))
    t.engine.search('needle')
    const before = t.last().count
    expect(before).toBe(10)

    t.write('\x1b[?1049h')
    t.frame()
    expect(t.last().count, 'the alternate screen has none of it').toBe(0)

    t.write('\x1b[?1049l')
    t.frame()
    expect(t.last().count).toBe(before)
  })
})
