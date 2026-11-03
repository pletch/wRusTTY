import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  CELL_BYTES,
  allocBuffer,
  createTerminal,
  freeBuffer,
  instantiateGhosttyWasm,
  parseCell,
  readResponse,
  writeString,
  type GhosttyWasm,
} from '../wasmBindings'

/**
 * Snapshots through the shim the app uses, not the raw core, which
 * `snapshotRestore.test.ts` covers. What's added here is that a restored terminal
 * is set up like a new one: the readers work and its callbacks are installed.
 * Each restore gets its own instance, as a new webview would.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = process.env.GHOSTTY_VT_WASM ?? join(here, '../vendor/ghostty-vt.wasm')
const bytes = Uint8Array.from(readFileSync(WASM)).buffer as ArrayBuffer

const COLS = 40
const ROWS = 6
const FG = 0x112233
const BG = 0x445566

async function open(): Promise<{ wasm: GhosttyWasm; term: number }> {
  const wasm = await instantiateGhosttyWasm(bytes)
  const term = createTerminal(wasm, COLS, ROWS, {
    scrollbackLimit: 1024 * 1024,
    fgColor: FG,
    bgColor: BG,
    cursorColor: 0,
  })
  wasm.exports.ghostty_terminal_track_continuation!(term)
  return { wasm, term }
}

function snapshot(wasm: GhosttyWasm, term: number): Uint8Array {
  const chunks: Uint8Array[] = []
  const result = wasm.exports.ghostty_terminal_snapshot!(term, (c) => {
    chunks.push(c)
    return true
  })
  expect(result).toBe(0)
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

async function restored(snap: Uint8Array): Promise<{ wasm: GhosttyWasm; term: number }> {
  const wasm = await instantiateGhosttyWasm(bytes)
  const term = wasm.exports.ghostty_terminal_restore!(snap)
  expect(term).not.toBe(0)
  return { wasm, term }
}

/** The screen as the renderer reads it. */
function screen({ wasm, term }: { wasm: GhosttyWasm; term: number }): string[] {
  const ex = wasm.exports
  ex.ghostty_render_state_update(term)
  const cells = COLS * ROWS
  const size = cells * CELL_BYTES
  const ptr = allocBuffer(wasm, size)
  ex.ghostty_render_state_get_viewport(term, ptr, cells)
  const view = new DataView(ex.memory.buffer)
  const rows: string[] = []
  for (let r = 0; r < ROWS; r++) {
    let row = ''
    for (let c = 0; c < COLS; c++) {
      const cp = parseCell(view, ptr + (r * COLS + c) * CELL_BYTES).codepoint
      row += cp === 0 ? ' ' : String.fromCodePoint(cp)
    }
    rows.push(row.trimEnd())
  }
  freeBuffer(wasm, ptr, size)
  return rows
}

describe('a terminal restored through the shim', () => {
  it('draws the same screen through the renderer readers', async () => {
    const a = await open()
    writeString(a.wasm, a.term, 'first line\r\nsecond \x1b[31mred\x1b[0m\r\n$ ')
    const b = await restored(snapshot(a.wasm, a.term))
    expect(screen(b)).toEqual(screen(a))
    expect(screen(b)[1]).toBe('second red')
  })

  it('keeps scrollback readable', async () => {
    const a = await open()
    for (let i = 0; i < 200; i++) writeString(a.wasm, a.term, `line ${i}\r\n`)
    const b = await restored(snapshot(a.wasm, a.term))
    const held = b.wasm.exports.ghostty_terminal_get_scrollback_length(b.term)
    expect(held).toBe(a.wasm.exports.ghostty_terminal_get_scrollback_length(a.term))
    expect(held).toBeGreaterThan(100)
  })

  it('answers queries, since its callbacks are installed', async () => {
    // Without them the core ignores queries, and a program waiting on one hangs.
    const a = await open()
    const b = await restored(snapshot(a.wasm, a.term))
    writeString(b.wasm, b.term, '\x1b[6n')
    expect(new TextDecoder().decode(readResponse(b.wasm, b.term)!)).toBe('\x1b[1;1R')
  })

  it('counts bells', async () => {
    const a = await open()
    const b = await restored(snapshot(a.wasm, a.term))
    writeString(b.wasm, b.term, '\x07')
    expect(b.wasm.exports.ghostty_terminal_take_bells!(b.term)).toBe(1)
  })

  it('does not answer a query the snapshot already saw', async () => {
    // The reply went out when it arrived. Sending it again would be stray input
    // to whatever's running now.
    const a = await open()
    writeString(a.wasm, a.term, '\x1b[6n')
    readResponse(a.wasm, a.term)
    const b = await restored(snapshot(a.wasm, a.term))
    expect(readResponse(b.wasm, b.term)).toBeNull()
  })

  it('finishes a sequence the snapshot cut in half', async () => {
    const a = await open()
    writeString(a.wasm, a.term, '\x1b[3')
    const b = await restored(snapshot(a.wasm, a.term))
    writeString(b.wasm, b.term, '1mred')
    expect(screen(b)[0]).toBe('red')
  })

  it('can be snapshotted again while still mid-sequence', async () => {
    // A session restored twice, the second time before the far end finished what
    // it was sending when the first snapshot was taken.
    const a = await open()
    writeString(a.wasm, a.term, 'x\x1b[3')
    const b = await restored(snapshot(a.wasm, a.term))
    const c = await restored(snapshot(b.wasm, b.term))
    writeString(c.wasm, c.term, '1my')
    expect(screen(c)[0]).toBe('xy')
  })

  it('keeps the theme colors the terminal was given', async () => {
    const a = await open()
    const b = await restored(snapshot(a.wasm, a.term))
    b.wasm.exports.ghostty_render_state_update(b.term)
    expect(b.wasm.exports.ghostty_render_state_get_fg_color(b.term)).toBe(FG)
    expect(b.wasm.exports.ghostty_render_state_get_bg_color(b.term)).toBe(BG)
  })

  it('refuses a damaged snapshot rather than restoring something wrong', async () => {
    const a = await open()
    writeString(a.wasm, a.term, 'hello')
    const snap = snapshot(a.wasm, a.term)
    snap[Math.floor(snap.length / 2)] ^= 0xff
    const fresh = await instantiateGhosttyWasm(bytes)
    expect(fresh.exports.ghostty_terminal_restore!(snap)).toBe(0)
  })

  it('reports a receiver that gave up, and keeps working', async () => {
    const a = await open()
    writeString(a.wasm, a.term, 'hello')
    expect(a.wasm.exports.ghostty_terminal_snapshot!(a.term, () => false)).not.toBe(0)
    writeString(a.wasm, a.term, ' there')
    expect(screen(a)[0]).toBe('hello there')
    expect(snapshot(a.wasm, a.term).length).toBeGreaterThan(0)
  })

  it('can be freed like any other', async () => {
    const a = await open()
    const b = await restored(snapshot(a.wasm, a.term))
    expect(() => b.wasm.exports.ghostty_terminal_free(b.term)).not.toThrow()
  })
})
