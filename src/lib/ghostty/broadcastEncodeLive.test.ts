// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { InputIntent } from '../terminalEngine'

/**
 * Broadcast re-encodes input for each target: the bytes the origin pane sent
 * depend on its program's modes, and a target whose program never asked for
 * the Kitty keyboard protocol or bracketed paste must not receive them.
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
  // See `pasteLive.test.ts`: jsdom can't build the renderer, which the engine
  // treats as fatal, after which `write` is a no-op.
  inner.fatalError = null

  const sent: { data: string; intent?: InputIntent }[] = []
  engine.onInput((d, intent) => sent.push({ data: new TextDecoder().decode(d), intent }))
  return { engine, sent }
}

const decode = (b: Uint8Array | null | undefined) => (b ? new TextDecoder().decode(b) : b)

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

describe('broadcast input, encoded per target', () => {
  it('pastes unbracketed into a target that never asked for bracketing', async () => {
    const origin = await mounted()
    const target = await mounted()
    origin.engine.write('\x1b[?2004h')
    origin.engine.paste('one\ntwo')

    const [{ data, intent }] = origin.sent
    expect(data).toBe(`${START}one\ntwo${END}`)
    expect(intent).toEqual({ kind: 'paste', text: 'one\ntwo' })
    expect(decode(target.engine.encodeIntent(intent!))).toBe('one\rtwo')

    target.engine.write('\x1b[?2004h')
    expect(decode(target.engine.encodeIntent(intent!))).toBe(`${START}one\ntwo${END}`)
    origin.engine.unmount()
    target.engine.unmount()
  })

  it("encodes a key with the target's keyboard protocol, not the origin's", async () => {
    const origin = await mounted()
    const target = await mounted()
    // Kitty "report all keys as escape codes": Enter is no longer a CR.
    origin.engine.write('\x1b[>8u')
    const enter: InputIntent = {
      kind: 'key',
      event: new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter' }),
    }
    expect(decode(origin.engine.encodeIntent(enter))).not.toBe('\r')
    expect(decode(target.engine.encodeIntent(enter))).toBe('\r')
    origin.engine.unmount()
    target.engine.unmount()
  })

  it("applies the target's own Backspace setting", async () => {
    const target = await mounted()
    const backspace: InputIntent = {
      kind: 'key',
      event: new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace' }),
    }
    expect(decode(target.engine.encodeIntent(backspace))).toBe('\x7f')
    target.engine.setBackspaceSendsCtrlH(true)
    expect(decode(target.engine.encodeIntent(backspace))).toBe('\x08')
    target.engine.unmount()
  })

  it('leaves typed text to the original bytes', async () => {
    const target = await mounted()
    expect(target.engine.encodeIntent({ kind: 'text' })).toBeNull()
    target.engine.unmount()
  })
})
