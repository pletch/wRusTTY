import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseOsc52 } from '../osc52'
import { OSC_PENDING_MAX } from './oscScanner'

/**
 * A clipboard write reaching the pane, through a real engine and a real core.
 *
 * `osc52.test.ts` pins the grammar and `oscScanner.test.ts` pins the dispatch;
 * this pins the two together against the thing that actually breaks — chunking.
 * An OSC 52 payload is the only sequence here whose length is user data, so it is
 * the only one that routinely spans deliveries, and the scanner's carried-over
 * buffer is what has to hold it. At the old 4 KB cap every copy past a few
 * hundred bytes of text was silently dropped on the chunk boundary it happened to
 * straddle, and nothing in either unit test could see that.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

interface Internals {
  termPtr: number
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const osc52 = (text: string) => `\x1b]52;c;${b64(text)}\x07`

describe('a clipboard write arriving over the wire', () => {
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

  /** An engine whose core has loaded, with the clipboard writes it saw. */
  async function ready() {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const engine = new GhosttyEngine()
    const inner = engine as unknown as Internals
    for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
    if (!inner.termPtr) throw new Error('core did not load')

    const writes: string[] = []
    const reads: number[] = []
    engine.registerOscHandler(52, (data) => {
      const req = parseOsc52(data)
      if (req.kind === 'write') writes.push(req.text)
      if (req.kind === 'read') reads.push(1)
      return true
    })

    /** Feeds a sequence the way a socket would: in fixed-size pieces. */
    const writeInChunks = (data: string, chunk: number) => {
      for (let i = 0; i < data.length; i += chunk) engine.write(data.slice(i, i + chunk))
    }
    return { engine, writes, reads, writeInChunks }
  }

  it('delivers one that arrives whole', async () => {
    const { engine, writes } = await ready()
    engine.write(osc52('hello from the far end'))
    expect(writes).toEqual(['hello from the far end'])
    engine.dispose()
  })

  it('delivers one split across deliveries', async () => {
    const { engine, writes, writeInChunks } = await ready()
    writeInChunks(osc52('a modest paragraph of text'), 7)
    expect(writes).toEqual(['a modest paragraph of text'])
    engine.dispose()
  })

  it('delivers a copy far past the old carried-over cap', async () => {
    const { engine, writes, writeInChunks } = await ready()
    // 200 KB of text — a scrollback-sized copy, and ~267 KB once base64'd, so
    // both the sequence and its carried-over buffer are well past the 4 KB that
    // used to drop it.
    const text = 'the quick brown fox jumps over the lazy dog. '.repeat(4600)
    expect(text.length).toBeGreaterThan(200_000)
    writeInChunks(osc52(text), 4096)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toBe(text)
    engine.dispose()
  })

  it('still refuses one that would outgrow the carried-over buffer', async () => {
    const { engine, writes, writeInChunks } = await ready()
    // Unterminated, and past the cap: the bound has to still hold, or a sender
    // that never closes a sequence grows the buffer without limit.
    writeInChunks(`\x1b]52;c;${'A'.repeat(OSC_PENDING_MAX + 1024)}`, 4096)
    engine.write('\x07')
    expect(writes).toEqual([])
    engine.dispose()
  })

  it('keeps text around the sequence out of the clipboard', async () => {
    const { engine, writes } = await ready()
    engine.write(`before${osc52('just this')}after`)
    expect(writes).toEqual(['just this'])
    engine.dispose()
  })

  it('reports a read query without treating it as a write', async () => {
    const { engine, writes, reads } = await ready()
    engine.write('\x1b]52;c;?\x07')
    expect(writes).toEqual([])
    expect(reads).toEqual([1])
    engine.dispose()
  })
})
