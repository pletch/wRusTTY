import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseWindowTitle, parseCwd } from '../remoteIdentity'

/**
 * A host's title and working directory reaching the pane, through a real
 * engine and a real core.
 *
 * `remoteIdentity.test.ts` pins the grammar; this pins that the sequences
 * carrying it survive the trip. Two assumptions are worth the cost of a live
 * core to check:
 *
 *   - **Single-digit identifiers.** OSC 0, 2 and 7 are the shortest this app
 *     handles, and the scanner reads a digit run — `0` sitting next to a
 *     payload that itself starts with digits is exactly where an off-by-one
 *     would hide.
 *   - **Terminator.** Shells emit these with BEL far more often than with ST,
 *     and both appear in the wild from the same host in the same session.
 *
 * A title also arrives interleaved with ordinary screen output rather than on
 * a chunk boundary of its own, which is what the split-delivery case covers.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

interface Internals {
  termPtr: number
  wasm: { exports: { ghostty_render_state_update(term: number): number } } | null
  _cols: number
  renderer: unknown
}

type Sel = { start: { x: number; y: number }; end: { x: number; y: number } }

describe('a host reporting its title and directory over the wire', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength),
    }))
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  async function ready() {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const engine = new GhosttyEngine()
    const inner = engine as unknown as Internals
    for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
    if (!inner.termPtr || !inner.wasm) throw new Error('core did not load')

    const titles: (string | null)[] = []
    const dirs: string[] = []
    for (const ident of [0, 2]) {
      engine.registerOscHandler(ident, (data) => {
        titles.push(parseWindowTitle(data))
        return false
      })
    }
    engine.registerOscHandler(7, (data) => {
      const cwd = parseCwd(data)
      if (cwd) dirs.push(cwd)
      return cwd !== null
    })

    const writeInChunks = (data: string, chunk: number) => {
      for (let i = 0; i < data.length; i += chunk) engine.write(data.slice(i, i + chunk))
    }
    return { engine, inner, titles, dirs, writeInChunks }
  }

  it('delivers a title set with BEL, the terminator shells actually use', async () => {
    const { engine, titles } = await ready()
    engine.write('\x1b]2;dev@build01: ~/src\x07$ ')
    expect(titles).toEqual(['dev@build01: ~/src'])
  })

  it('delivers a title set with ST', async () => {
    const { engine, titles } = await ready()
    engine.write('\x1b]2;dev@build01\x1b\\$ ')
    expect(titles).toEqual(['dev@build01'])
  })

  it('reads OSC 0 as a title too, without swallowing it', async () => {
    // Returning false is deliberate — OSC 0 also sets the icon name, which
    // this doesn't implement, and the core keeps its own title from the same
    // bytes. The handler still has to see it.
    const { engine, titles } = await ready()
    engine.write('\x1b]0;both at once\x07')
    expect(titles).toEqual(['both at once'])
  })

  it('does not mistake the payload for part of the identifier', async () => {
    // `0` followed by a payload starting with a digit: if the scanner's digit
    // run ran on past the semicolon, this would arrive as OSC 07 or worse.
    const { engine, titles } = await ready()
    engine.write('\x1b]0;7 jobs running\x07')
    expect(titles).toEqual(['7 jobs running'])
  })

  it('delivers a working directory as a file URL', async () => {
    const { engine, dirs } = await ready()
    engine.write('\x1b]7;file://build01/home/dev/src\x07')
    expect(dirs).toEqual(['/home/dev/src'])
  })

  it('follows a shell that reports both on every prompt', async () => {
    // What PROMPT_COMMAND actually emits: directory and title together, over
    // and over, with the prompt itself between them.
    const { engine, titles, dirs } = await ready()
    for (const dir of ['/home/dev', '/home/dev/src', '/etc']) {
      engine.write(`\x1b]7;file://h${dir}\x07\x1b]2;dev@h: ${dir}\x07${dir}$ `)
    }
    expect(dirs).toEqual(['/home/dev', '/home/dev/src', '/etc'])
    expect(titles).toEqual(['dev@h: /home/dev', 'dev@h: /home/dev/src', 'dev@h: /etc'])
  })

  it('survives delivery one byte at a time', async () => {
    // A sequence split across PTY chunks is ordinary, not exotic — and a title
    // is long enough to be split most times it is sent.
    const { titles, dirs, writeInChunks } = await ready()
    writeInChunks('\x1b]7;file://h/srv/www\x07\x1b]2;a long enough title to be split\x07', 1)
    expect(dirs).toEqual(['/srv/www'])
    expect(titles).toEqual(['a long enough title to be split'])
  })

  it('reports a cleared title as cleared, not as a blank one', async () => {
    const { engine, titles } = await ready()
    engine.write('\x1b]2;something\x07\x1b]2;\x07')
    expect(titles).toEqual(['something', null])
  })

  it('leaves the screen itself untouched', async () => {
    // The whole point of these sequences: they say something *about* the
    // session without printing anything into it. A scanner that got the
    // extent of a sequence wrong would spill its payload onto the grid, which
    // is invisible to a test that only checks what the handlers received.
    const { engine, inner } = await ready()
    engine.resize(40, 6)
    inner.renderer = {
      selection: null as Sel | null,
      getCellSize: () => ({ width: 10, height: 20 }),
      dispose: () => {},
    }
    engine.write('\x1b]2;a title\x07\x1b]7;file://h/tmp\x07hello')
    // Stands in for the frame that would populate the render state in the app.
    inner.wasm!.exports.ghostty_render_state_update(inner.termPtr)
    ;(inner.renderer as { selection: Sel }).selection = {
      start: { x: 0, y: 0 },
      end: { x: inner._cols - 1, y: 0 },
    }
    expect(engine.getSelection()).toBe('hello')
  })
})
