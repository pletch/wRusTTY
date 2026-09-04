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
 * Two things are being checked here and they are different in kind. The first
 * is that the native path finds what the JS one finds — same hits, same
 * navigation, same highlights — because a search that is *correct* but
 * behaves differently is still a regression for whoever is using the find bar.
 *
 * The second is the reason for the port, and it is deliberately written as a
 * differential: the same situation put to both paths, where the JS one is
 * wrong. Those cases all have the same shape — the terminal moves while the
 * find bar is open — because that is precisely what `SearchController` cannot
 * see. It rebuilds its match list only when `search()` is called again, so
 * output that arrives, a resize, or scrollback eviction leaves its count and
 * its highlights describing a buffer that no longer exists. The core is fed
 * every frame and reconciles.
 *
 * `frame()` below stands in for the render loop, which is what does the
 * feeding in the app. Everything else goes through the engine's public
 * surface, so the routing between the two controllers is exercised rather
 * than bypassed.
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

    // Only what the search paths touch. Nothing draws.
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
    // The JS path reads rows off the render snapshot, which a drawn frame
    // would have built; see readRows.test.ts.
    inner.wasm.exports.ghostty_render_state_update(inner.termPtr)

    return {
      engine,
      inner,
      results,
      highlights: () => renderer.searchHighlights,
      last: () => results[results.length - 1],
      /** What the render loop does for a live search: feed the core and let it
       *  redraw from what came back. */
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

  /** Lines wider than the pane, so halving the width reflows every one of them
   *  and every match lands on a different absolute row. */
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

  /** Upstream's matcher folds ASCII case and cannot be told not to, so a
   *  case-sensitive query is routed to the JS controller instead. Both counts
   *  are asserted, because the routing is invisible from outside and a
   *  silently case-folded "case-sensitive" search would look like it worked. */
  it('routes case-sensitive and regex queries to the JS path', async () => {
    const t = await engineWith('Needle\r\nneedle\r\nNEEDLE\r\n')

    t.engine.search('needle')
    expect(t.last().count, 'native matching folds ASCII case').toBe(3)

    t.engine.search('needle', { caseSensitive: true })
    expect(t.last().count, 'the JS path honours the toggle').toBe(1)

    // And the regex toggle really is a regex rather than a literal: the same
    // string finds nothing when the core matches it byte for byte.
    t.engine.search('ne+dle', { regex: true })
    expect(t.last().count).toBe(3)
    t.engine.search('ne+dle')
    expect(t.last().count).toBe(0)
  })

  /**
   * Direction is worth pinning because the two APIs disagree about which way
   * "next" points. The find bar's Next is a chevron *down* — toward newer
   * content — which is the core's SELECT_PREV, not its SELECT_NEXT.
   *
   * A fresh query lands on the newest hit, the one nearest the prompt, so the
   * counter opens at n/n and Next wraps round to 1/n from there.
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
   * The current hit has to look different from the others, or stepping through
   * them says nothing. The renderer draws `active` amber on dark text and the
   * rest a dim brown, so this asserts the flag it keys off: exactly one, and it
   * moves.
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

    // And a frame that changes nothing must not lose it.
    t.frame()
    expect(activeRows().length).toBe(1)
  })

  /** An incremental keystroke re-runs the query without moving the selection,
   *  which is what stops the view jumping while someone is still typing. */
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
    // "alpha " is six columns, and the endpoints are inclusive.
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
    // And it stays cleared across frames, rather than the feed putting the
    // decorations back.
    t.frame()
    expect(t.highlights()).toBeNull()
  })

  it('reports nothing found without clearing the query', async () => {
    const t = await engineWith(lines(30))
    t.engine.search('haystack')
    expect(t.last()).toEqual({ index: -1, count: 0 })
  })

  /**
   * A scrollback too deep to search inside one frame.
   *
   * Two things are being asserted. The first is that it is genuinely sliced:
   * the keystroke returns with a partial count rather than the pane freezing
   * until the whole history has been read. The second is that the slicing
   * converges on the same answer the JS matcher gets from reading every row,
   * which is the only check that the partial counts are a search in progress
   * rather than a search that stopped early.
   *
   * Progress per frame is bounded by the core's feed chunk, not by our tick
   * budget, so this needs many more frames than a real session would take at
   * 60 Hz — hence the generous cap rather than a fixed count.
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

    // The same buffer read row by row and matched in JS. Both are counting
    // hits in a scrollback the pane's byte budget has already pruned, so the
    // number itself is not predictable — that they agree is the point.
    const j = await engineWith(lines(20000), 80, 24)
    j.engine.search('needle', { regex: true })
    expect(settled).toBe(j.last().count)
  })

  /**
   * The one that shipped broken, and the reason this test exists: highlights
   * have to be for the rows the *pane* is showing.
   *
   * `VIEWPORT_MATCHES` sounds like the field for this and is not — it is
   * relative to the core's own viewport, which never moves, because the
   * offset the renderer draws from is ours and the search is set to
   * SEARCH_SCROLL_NONE so it does not fight us. The first version drew
   * highlights pinned to the bottom of the buffer, so a pane scrolled back —
   * which is where a search leaves you — showed none at all.
   */
  it('highlights the rows the pane is showing, not the ones the core thinks it is', async () => {
    const t = await engineWith(lines(3000), 80, 24)
    t.engine.search('needle')
    // The first keystroke only gets one slice of a 3,000-row buffer, and the
    // rows it has found are all near the bottom. Let it catch up before
    // scrolling somewhere it has not looked yet.
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

    // Every row it claims is one the screen can show; nothing is being drawn
    // for a screen nobody is looking at.
    const top = t.engine.viewportY
    const rows = [...t.highlights()!.keys()]
    expect(rows.every((r) => r >= top - 2 && r < top + 24 + 2)).toBe(true)
  })

  /* ---- the differentials: the terminal moves under an open find bar ---- */

  /**
   * The plainest one. Output arrives while the find bar is open; the count has
   * to follow it. The JS controller rebuilds only inside `search()`, so its
   * answer stays at the old number until the next keystroke.
   */
  it('counts output that arrives after the search, where the JS path does not', async () => {
    const t = await engineWith(lines(30))

    t.engine.search('needle')
    expect(t.last().count).toBe(10)
    t.write('a late needle\r\n')
    t.frame()
    expect(t.last().count, 'the core was fed and saw the new line').toBe(11)

    // Same situation, JS path: the regex toggle is what routes it there.
    const j = await engineWith(lines(30))
    j.engine.search('needle', { regex: true })
    expect(j.last().count).toBe(10)
    j.write('a late needle\r\n')
    j.frame()
    expect(j.last().count, 'nothing re-ran, so nothing noticed').toBe(10)
  })

  /**
   * A resize reflows the buffer, which moves every row a match is on. The JS
   * controller is holding absolute row numbers from before the resize and has
   * no way to learn they moved; the core reconciles on the next feed.
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
    // The rows genuinely moved: at half the width every wrapped line is two
    // rows, so the same hits cannot be on the same absolute rows.
    expect([...after!.keys()]).not.toEqual([...before!.keys()])

    const j = await engineWith(wideLines(20), 40, 6)
    j.engine.search('needle', { regex: true })
    const jBefore = j.highlights()
    j.engine.resize(20, 6)
    j.frame()
    expect([...j.highlights()!.keys()], 'unchanged, and therefore wrong').toEqual([...jBefore!.keys()])
  })

  /**
   * A match scrolled out of a capped scrollback stops existing. The core
   * prunes results that eviction invalidated on the next feed; the JS
   * controller's list still has them, pointing at rows that now hold something
   * else entirely.
   */
  it('drops matches that scrollback eviction took away', async () => {
    const t = await engineWith(lines(20), 40, 6)
    t.engine.search('needle')
    const found = t.last().count
    expect(found).toBeGreaterThan(0)

    // Push them out with content that does not match. The default pane is an
    // 8 MB footprint, which is a *byte* budget of about 4 MB and so roughly
    // eleven thousand rows at this width — see vendor/README.md.
    t.write(Array.from({ length: 15000 }, (_, i) => `filler ${i}`).join('\r\n') + '\r\n')
    t.frame()
    expect(t.last().count, 'the evicted hits are gone').toBeLessThan(found)
  })

  /**
   * Entering and leaving a fullscreen application. The core keeps the primary
   * screen's results and restores them on the way back, so a scrollback search
   * does not restart every time someone opens and closes `vim`.
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
