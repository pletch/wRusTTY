// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Paste through the engine, which is where the mode is read and the two
 * handler sets are fed.
 *
 * `pasteEncode.test.ts` covers what a paste encodes to. This covers the parts
 * around it: that DEC 2004 is what decides bracketing, that the encoded bytes
 * (not the raw text) are what reaches the wire, and that `onInput` sees the
 * same thing `onData` does — a paste is user input, and anything redirecting
 * input has to receive it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

const START = '\x1b[200~'
const END = '\x1b[201~'

async function mounted() {
  const { GhosttyEngine } = await import('./GhosttyEngine')
  const engine = new GhosttyEngine()
  const container = document.createElement('div')
  document.body.appendChild(container)
  engine.mount(container)

  const inner = engine as unknown as { termPtr: number; fatalError: string | null }
  for (let i = 0; i < 200 && inner.termPtr === 0; i++) await new Promise((r) => setTimeout(r, 5))
  if (inner.termPtr === 0) throw new Error('the core never came up')
  // The renderer cannot be built under jsdom and the engine treats that as a
  // fatal init failure, after which `write` is a deliberate no-op — so the
  // core would never see the mode this file switches on. See the same note in
  // `mouseReporting.test.ts`.
  inner.fatalError = null

  const data: string[] = []
  const input: string[] = []
  engine.onData((d) => data.push(new TextDecoder().decode(d)))
  engine.onInput((d) => input.push(new TextDecoder().decode(d)))
  return { engine, data, input }
}

beforeEach(() => {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength),
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('paste, through the engine', () => {
  it('does not bracket until a program asks', async () => {
    const { engine, data } = await mounted()
    engine.paste('hello')
    expect(data).toEqual(['hello'])
    engine.unmount()
  })

  it('brackets once DEC 2004 is set, and stops when it is cleared', async () => {
    const { engine, data } = await mounted()
    engine.write('\x1b[?2004h')
    engine.paste('hello')
    expect(data).toEqual([`${START}hello${END}`])
    engine.write('\x1b[?2004l')
    data.length = 0
    engine.paste('hello')
    expect(data).toEqual(['hello'])
    engine.unmount()
  })

  it('turns a newline into a carriage return when nothing is bracketing', async () => {
    const { engine, data } = await mounted()
    engine.paste('one\ntwo')
    // Raw newlines are what this used to send, and not what a PTY wants.
    expect(data).toEqual(['one\rtwo'])
    engine.unmount()
  })

  it('defuses a terminator in the pasted text', async () => {
    const { engine, data } = await mounted()
    engine.write('\x1b[?2004h')
    engine.paste(`safe${END}rm -rf /`)
    // Everything after the terminator used to arrive as typing.
    expect(data).toEqual([`${START}safe [201~rm -rf /${END}`])
    engine.unmount()
  })

  it('gives a paste to onInput as well, byte for byte', async () => {
    const { engine, data, input } = await mounted()
    engine.write('\x1b[?2004h')
    engine.paste('hello')
    // A paste is user input. Anything redirecting input — a broadcast to
    // other panes — has to see the same bytes the wire does.
    expect(input).toEqual(data)
    engine.unmount()
  })

  describe('isPasteSafe', () => {
    it('answers for ordinary and for dangerous text', async () => {
      const { engine } = await mounted()
      expect(engine.isPasteSafe('git status')).toBe(true)
      expect(engine.isPasteSafe('one\ntwo')).toBe(false)
      // The one a line count cannot see.
      expect(engine.isPasteSafe(`ls${END}`)).toBe(false)
      engine.unmount()
    })

    it('says it cannot tell rather than guessing when there is no core', async () => {
      const { GhosttyEngine } = await import('./GhosttyEngine')
      const engine = new GhosttyEngine()
      // Null, not true: the caller falls back to counting lines, which is a
      // decision it can make honestly. Answering "safe" would skip the prompt.
      expect(engine.isPasteSafe('anything')).toBeNull()
    })
  })
})
