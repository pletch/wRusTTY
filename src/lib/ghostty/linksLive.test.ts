import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { GhosttyWasm } from './wasmBindings'
import type { Link } from './LinkController'

/**
 * Link detection against the real core.
 *
 * The unit tests above it stub the buffer, which is the right shape for the
 * rules but cannot catch the thing that actually breaks here: a URL that has
 * wrapped, or scrolled into history, is reassembled from `readRows` and
 * `readWrapFlags`, and those two have a scrollback path and an active-screen
 * path that are entirely different code. This drives a real terminal at a
 * known width and asks what is under a cell.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

const COLS = 40
const ROWS = 6

interface Internals {
  wasm: GhosttyWasm | null
  termPtr: number
  renderer: unknown
  links: { linkAt(pos: { x: number; y: number }): Link | null; linksInViewport(): Link[] }
}

describe('links, through a real core', () => {
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

    engine.resize(COLS, ROWS)
    // Nothing draws here; the links path only ever asks the renderer whether
    // it exists (through the engine's own guards) and hands it a highlight.
    inner.renderer = { linkHighlight: null, getCellSize: () => ({ width: 10, height: 20 }), dispose: () => {} }
    engine.write(new TextEncoder().encode(text))
    // `readRows` reads the core's render state, which a drawn frame would have
    // populated. Nothing draws in this test, so this stands in for the frame.
    inner.wasm.exports.ghostty_render_state_update(inner.termPtr)
    return { engine, inner }
  }

  it('finds a URL on a plain row', async () => {
    const { inner } = await engineWith('see https://example.com/x here')
    expect(inner.links.linkAt({ x: 6, y: 0 })?.url).toBe('https://example.com/x')
    expect(inner.links.linkAt({ x: 1, y: 0 })).toBeNull()
  })

  /**
   * The case row-at-a-time detection gets wrong. At 40 columns this URL runs
   * past the right margin, so the core stores it as two rows joined by a wrap
   * flag — and half a URL is worse than none, because half a URL still opens.
   */
  it('reassembles a URL that wrapped across two rows', async () => {
    const url = 'https://example.com/a/rather/long/path/that/wraps'
    const { inner } = await engineWith(url)
    // Both halves answer with the whole URL, and the second half is where the
    // join is doing the work.
    expect(inner.links.linkAt({ x: 10, y: 0 })?.url).toBe(url)
    expect(inner.links.linkAt({ x: 2, y: 1 })?.url).toBe(url)
    // One link, not two.
    expect(inner.links.linksInViewport()).toHaveLength(1)
    expect(inner.links.linkAt({ x: 2, y: 1 })?.segments).toHaveLength(2)
  })

  /** The scrollback path is different code from the active-screen path, and
   *  this is the boundary it breaks at first. */
  it('finds a URL that has scrolled into history', async () => {
    const { engine, inner } = await engineWith(
      'go https://example.com/old\r\n' + 'filler\r\n'.repeat(10),
    )
    // Scrolled back to the top, where the URL now lives in scrollback.
    engine.scrollToLine(0)
    const found = inner.links.linksInViewport()
    expect(found.map((l) => l.url)).toContain('https://example.com/old')
  })

  it('offers nothing on a screen with no URL in it', async () => {
    const { inner } = await engineWith('drwxr-xr-x 2 tim tim 4096 src\r\nmake: nothing to do')
    expect(inner.links.linksInViewport()).toEqual([])
  })

  /** Wide characters make a column and a character offset different numbers,
   *  which is exactly what the offset-to-column mapping exists for. */
  it('reports the right columns for a URL after a wide character', async () => {
    const { inner } = await engineWith('你好 https://example.com/x')
    // 你好 takes four columns, then a space: the URL starts at column 5.
    const link = inner.links.linkAt({ x: 5, y: 0 })
    expect(link?.url).toBe('https://example.com/x')
    expect(link?.segments[0].from).toBe(5)
  })
})
