import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseOsc9, parseOsc777 } from '../appProgress'
import type { AppProgress } from '../appProgress'

/**
 * A program's own progress report reaching the pane, through a real engine and
 * a real core.
 *
 * `appProgress.test.ts` pins the grammar; this pins that the sequences carrying
 * it are actually recognised as OSC by the scanner and dispatched — which is
 * not free of assumptions. OSC 9 is the shortest identifier this app handles
 * and OSC 777 the longest, so between them they cover the digit-run parsing,
 * and progress arrives interleaved with an application's normal screen output
 * rather than on a chunk boundary of its own.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

interface Internals {
  termPtr: number
}

describe('an application reporting its own progress over the wire', () => {
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
    if (!inner.termPtr) throw new Error('core did not load')

    const progress: (AppProgress | null)[] = []
    const notes: string[] = []
    engine.registerOscHandler(9, (data) => {
      const result = parseOsc9(data)
      if (result.kind === 'progress') progress.push(result.progress)
      if (result.kind === 'notify') notes.push(result.notification.body)
      return true
    })
    engine.registerOscHandler(777, (data) => {
      const note = parseOsc777(data)
      if (note) notes.push(note.body)
      return note !== null
    })

    const writeInChunks = (data: string, chunk: number) => {
      for (let i = 0; i < data.length; i += chunk) engine.write(data.slice(i, i + chunk))
    }
    return { engine, progress, notes, writeInChunks }
  }

  it('delivers a busy-then-done cycle amongst ordinary output', async () => {
    const { engine, progress } = await ready()
    // What a full-screen tool actually emits: progress wrapped in the screen
    // painting it is doing anyway, not sitting alone in a chunk.
    engine.write('\x1b[2J\x1b[H\x1b]9;4;3\x07working...\r\n')
    engine.write('done\r\n\x1b]9;4;0\x07')
    expect(progress).toEqual([{ state: 'active', percent: null }, null])
    engine.dispose()
  })

  it('delivers a determinate report split across deliveries', async () => {
    const { engine, progress, writeInChunks } = await ready()
    // One byte at a time is the worst case the coalescer can hand over, and
    // the case that exercises the scanner's carried-over pending buffer for
    // every byte of the sequence.
    writeInChunks('\x1b]9;4;1;40\x07', 1)
    expect(progress).toEqual([{ state: 'active', percent: 40 }])
    engine.dispose()
  })

  it('delivers notifications under both identifiers', async () => {
    const { engine, notes } = await ready()
    // ST-terminated rather than BEL, which is the other legal framing and the
    // one a longer identifier is more likely to be written with.
    engine.write('\x1b]777;notify;Backup;finished in 4m\x1b\\')
    engine.write('\x1b]9;backup finished\x07')
    expect(notes).toEqual(['finished in 4m', 'backup finished'])
    engine.dispose()
  })
})
