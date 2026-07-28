import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * The line between what a *person* sent and what the *engine* sent, through a
 * real core.
 *
 * `onData` is everything headed for the wire — typing, paste, mouse reports,
 * focus reports, and the core's own replies to host queries. `onInput` is the
 * first two only. Anything that redirects input elsewhere — broadcast is the
 * one that exists — has to read `onInput`, because a reply belongs to the host
 * that asked for it and a mouse report describes this pane's geometry alone.
 *
 * Pinned against a live core rather than a stub because the interesting half
 * is a reply the core generates by itself: nothing in the app decides that a
 * DSR gets answered, so nothing in the app can be mocked into forgetting to.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

interface Internals {
  termPtr: number
}

describe('user input versus engine-generated wire traffic', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength),
    }))
    // Nothing is mounted, so these only have to exist.
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  /** An engine whose core has loaded, with both handler sets recording. */
  async function ready() {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const engine = new GhosttyEngine()
    const inner = engine as unknown as Internals
    for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
    if (!inner.termPtr) throw new Error('core did not load')

    const data: string[] = []
    const input: string[] = []
    engine.onData((d) => data.push(d))
    engine.onInput((d) => input.push(d))
    return { engine, data, input }
  }

  /** A cursor position report. The host asked; this pane's engine answered;
   * that answer is addressed to that host and no other. */
  it('keeps a DSR reply out of the input stream', async () => {
    const { engine, data, input } = await ready()
    engine.write('\x1b[6n')
    // Split rather than matched whole: a regex literal can't carry the ESC
    // without tripping `no-control-regex`.
    const reply = data.join('')
    expect(reply.startsWith(String.fromCharCode(27) + '[')).toBe(true)
    expect(reply.slice(2)).toMatch(/^\d+;\d+R$/)
    expect(input).toEqual([])
    engine.dispose()
  })

  /** Device attributes — same shape, different query, because a host that
   * probes in a loop is exactly the case that made this worth splitting. */
  it('keeps a device attributes reply out of the input stream', async () => {
    const { engine, data, input } = await ready()
    engine.write('\x1b[c')
    expect(data.join('')).toContain('\x1b[?')
    expect(input).toEqual([])
    engine.dispose()
  })

  /** Paste is the user, so it goes to both — the single-pane writer reads
   * `onData` and must keep seeing everything it saw before the split. */
  it('reports a paste on both', async () => {
    const { engine, data, input } = await ready()
    engine.paste('uptime')
    expect(data).toEqual(['uptime'])
    expect(input).toEqual(['uptime'])
    engine.dispose()
  })

  /** Bracketed paste travels as one payload, so a broadcast fans out the
   * markers with the text rather than stripping them off one pane's copy. */
  it('reports a bracketed paste identically on both', async () => {
    const { engine, data, input } = await ready()
    engine.write('\x1b[?2004h')
    engine.paste('uptime')
    expect(data).toEqual(['\x1b[200~uptime\x1b[201~'])
    expect(input).toEqual(data)
    engine.dispose()
  })

  /** A disposed engine must drop both sets, not one: a leaked `onInput`
   * handler would keep a torn-down pane broadcasting. */
  it('drops both handler sets on dispose', async () => {
    const { engine, data, input } = await ready()
    engine.dispose()
    engine.paste('after')
    expect(data).toEqual([])
    expect(input).toEqual([])
  })
})
