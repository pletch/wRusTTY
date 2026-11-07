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
  writeString,
  type GhosttyWasm,
} from '../wasmBindings'

/**
 * Android turns on snapshot tracking and takes a snapshot every 30 seconds, which a
 * desktop terminal never does. If either changed what the terminal holds, output would
 * come out differently on a phone. So these run the same output, shaped like a program
 * redrawing inline, both ways and compare.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = process.env.GHOSTTY_VT_WASM ?? join(here, '../vendor/ghostty-vt.wasm')
const bytes = Uint8Array.from(readFileSync(WASM)).buffer as ArrayBuffer

const COLS = 48
const ROWS = 12

interface Term {
  wasm: GhosttyWasm
  term: number
}

async function open(tracked: boolean): Promise<Term> {
  const wasm = await instantiateGhosttyWasm(bytes)
  const term = createTerminal(wasm, COLS, ROWS, {
    scrollbackLimit: 1024 * 1024,
    fgColor: 0x112233,
    bgColor: 0x445566,
    cursorColor: 0,
  })
  if (tracked) wasm.exports.ghostty_terminal_track_continuation!(term)
  return { wasm, term }
}

function snapshot({ wasm, term }: Term): Uint8Array {
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

function screen({ wasm, term }: Term): string[] {
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

function state(t: Term) {
  return {
    screen: screen(t),
    scrollback: t.wasm.exports.ghostty_terminal_get_scrollback_length(t.term),
    cursor: [
      t.wasm.exports.ghostty_render_state_get_cursor_x(t.term),
      t.wasm.exports.ghostty_render_state_get_cursor_y(t.term),
    ],
  }
}

/** Output the way an inline program writes it: a block of text, then repeatedly moving
 * back up, erasing and drawing it again as it grows, inside synchronized updates. */
function inlineRedraws(): string[] {
  const chunks: string[] = []
  let drawn = 0
  for (let frame = 1; frame <= 40; frame++) {
    const lines = Array.from(
      { length: frame },
      (_, i) => `answer ${frame} line ${i} ` + 'wrapped text '.repeat(i % 5),
    )
    const up = drawn > 0 ? `\x1b[${drawn}A\r\x1b[J` : ''
    const body = lines.join('\r\n')
    chunks.push(`\x1b[?2026h${up}${body}\r\n\x1b[?2026l`)
    // Clamped to what's on screen, as a program can't reach further up.
    drawn = Math.min(ROWS - 1, frame)
  }
  return chunks
}

describe('snapshot tracking', () => {
  it('leaves the same terminal as one that never snapshots', async () => {
    const plain = await open(false)
    const tracked = await open(true)
    for (const chunk of inlineRedraws()) {
      writeString(plain.wasm, plain.term, chunk)
      writeString(tracked.wasm, tracked.term, chunk)
      snapshot(tracked)
      expect(state(tracked)).toEqual(state(plain))
    }
  })

  it('leaves the same terminal when a snapshot cuts through a sequence', async () => {
    const plain = await open(false)
    const tracked = await open(true)
    const stream = inlineRedraws().join('')
    for (let at = 0; at < stream.length; at += 37) {
      const piece = stream.slice(at, at + 37)
      writeString(plain.wasm, plain.term, piece)
      writeString(tracked.wasm, tracked.term, piece)
      snapshot(tracked)
    }
    expect(state(tracked)).toEqual(state(plain))
  })
})

describe('replaying after a rebuild', () => {
  async function restored(snap: Uint8Array): Promise<Term> {
    const wasm = await instantiateGhosttyWasm(bytes)
    const term = wasm.exports.ghostty_terminal_restore!(snap)
    expect(term).not.toBe(0)
    return { wasm, term }
  }

  it('comes out the same as no rebuild at all at the size the output was written for', async () => {
    const chunks = inlineRedraws()
    const whole = await open(true)
    const before = chunks.slice(0, 20)
    for (const chunk of before) writeString(whole.wasm, whole.term, chunk)
    const snap = snapshot(whole)
    for (const chunk of chunks.slice(20)) writeString(whole.wasm, whole.term, chunk)

    const back = await restored(snap)
    for (const chunk of chunks.slice(20)) writeString(back.wasm, back.term, chunk)
    expect(state(back).screen).toEqual(state(whole).screen)
  })

  it('still comes out the same after the new terminal started at another size', async () => {
    // A new webview fits itself first. Replay then goes back to the recorded size.
    const chunks = inlineRedraws()
    const whole = await open(true)
    for (const chunk of chunks.slice(0, 20)) writeString(whole.wasm, whole.term, chunk)
    const snap = snapshot(whole)
    for (const chunk of chunks.slice(20)) writeString(whole.wasm, whole.term, chunk)

    const back = await restored(snap)
    back.wasm.exports.ghostty_terminal_resize(back.term, COLS, 5)
    back.wasm.exports.ghostty_terminal_resize(back.term, COLS, ROWS)
    for (const chunk of chunks.slice(20)) writeString(back.wasm, back.term, chunk)
    expect(state(back).screen).toEqual(state(whole).screen)
  })

  it('leaves different rows if it replays at the wrong size, which is what the recorded size is for', async () => {
    // Text printed once, under a footer redrawn in place, which is how an inline program
    // draws. Eight rows up reaches the footer's top at 12 rows, but stops short at 5.
    const footer = (n: number) =>
      Array.from({ length: 8 }, (_, i) => `footer ${n} row ${i}`).join('\r\n') + '\r\n'
    const redraw = (n: number) => `\x1b[8A\r\x1b[J${n}: printed once\r\n${footer(n)}`

    const whole = await open(true)
    writeString(whole.wasm, whole.term, footer(0))
    const snap = snapshot(whole)
    for (let n = 1; n <= 3; n++) writeString(whole.wasm, whole.term, redraw(n))

    const back = await restored(snap)
    back.wasm.exports.ghostty_terminal_resize(back.term, COLS, 5)
    for (let n = 1; n <= 3; n++) writeString(back.wasm, back.term, redraw(n))
    back.wasm.exports.ghostty_terminal_resize(back.term, COLS, ROWS)
    expect(state(back).screen).not.toEqual(state(whole).screen)

    // And replayed at the recorded size, it matches.
    const right = await restored(snap)
    for (let n = 1; n <= 3; n++) writeString(right.wasm, right.term, redraw(n))
    expect(state(right).screen).toEqual(state(whole).screen)
  })
})
