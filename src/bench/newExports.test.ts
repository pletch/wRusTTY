/**
 * The two exports added when we took ownership of the WASM shim, both of which
 * closed a parity gap that used to be marked "upstream, cannot be fixed here".
 *
 *   ghostty_terminal_is_scrollback_row_wrapped  — search across a wrapped line
 *   ghostty_render_state_get_cursor_style       — DECSCUSR shape
 *
 * Driven against the core directly rather than through GhosttyEngine: both are
 * one call deep, and a DOM-less test says plainly which side a failure is on.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  instantiateGhosttyWasm,
  createTerminal,
  writeBytes,
  type GhosttyWasm,
  CURSOR_STYLE_BLOCK,
  CURSOR_STYLE_BAR,
  CURSOR_STYLE_UNDERLINE,
} from '../lib/ghostty/wasmBindings'
import { cursorStyleSequence } from '../lib/settings'

const here = dirname(fileURLToPath(import.meta.url))
const WASM_PATH = join(here, '../lib/ghostty/vendor/ghostty-vt.wasm')

let wasm: GhosttyWasm
const enc = new TextEncoder()

beforeAll(async () => {
  wasm = await instantiateGhosttyWasm(readFileSync(WASM_PATH).buffer as ArrayBuffer)
})

function term(cols: number, rows: number, scrollback = 200) {
  const ptr = createTerminal(wasm, cols, rows, {
    scrollbackLimit: scrollback,
    fgColor: 0xcccccc,
    bgColor: 0,
    cursorColor: 0,
  })
  if (ptr === 0) throw new Error('terminal_new failed')
  return ptr
}

const write = (ptr: number, s: string) => writeBytes(wasm, ptr, enc.encode(s))

describe('ghostty_terminal_is_scrollback_row_wrapped', () => {
  it('marks the continuations of a wrapped line, and only those', () => {
    const cols = 10
    const ptr = term(cols, 3)
    // 25 characters over 10 columns is three visual rows for one logical line:
    // the first is a fresh line, the next two continue it. Then enough short
    // lines to push all of it into the scrollback.
    write(ptr, 'x'.repeat(25) + '\r\n')
    for (let i = 0; i < 6; i++) write(ptr, `s${i}\r\n`)

    const len = wasm.exports.ghostty_terminal_get_scrollback_length(ptr)
    expect(len).toBeGreaterThanOrEqual(4)

    const wrapped = Array.from({ length: 4 }, (_, y) =>
      wasm.exports.ghostty_terminal_is_scrollback_row_wrapped(ptr, y) !== 0,
    )
    // Row 0 starts the line; rows 1 and 2 continue it; row 3 is the next line.
    expect(wrapped).toEqual([false, true, true, false])
  })

  it('refuses out-of-range rows rather than reading past the buffer', () => {
    const ptr = term(10, 3)
    write(ptr, 'hello\r\n')
    const len = wasm.exports.ghostty_terminal_get_scrollback_length(ptr)
    expect(wasm.exports.ghostty_terminal_is_scrollback_row_wrapped(ptr, -1)).toBeFalsy()
    expect(wasm.exports.ghostty_terminal_is_scrollback_row_wrapped(ptr, len + 100)).toBeFalsy()
  })
})

describe('ghostty_render_state_get_cursor_style', () => {
  const shape = (ptr: number) => {
    wasm.exports.ghostty_render_state_update(ptr)
    return wasm.exports.ghostty_render_state_get_cursor_style(ptr)
  }

  it('reports the DECSCUSR shape the stream asked for', () => {
    const ptr = term(20, 3)
    expect(shape(ptr)).toBe(CURSOR_STYLE_BLOCK)

    for (const [seq, want] of [
      ['\x1b[5 q', CURSOR_STYLE_BAR], // blinking bar
      ['\x1b[6 q', CURSOR_STYLE_BAR], // steady bar
      ['\x1b[3 q', CURSOR_STYLE_UNDERLINE],
      ['\x1b[4 q', CURSOR_STYLE_UNDERLINE],
      ['\x1b[1 q', CURSOR_STYLE_BLOCK],
      ['\x1b[2 q', CURSOR_STYLE_BLOCK],
    ] as const) {
      write(ptr, seq)
      expect(shape(ptr), seq).toBe(want)
    }
  })

  it('reports blink separately, so steady and blinking variants differ', () => {
    // The half of DECSCUSR that was ignored: honouring only the shape made
    // ESC[1 q and ESC[2 q render identically, because the engine blinked on its
    // own timer regardless.
    const ptr = term(20, 3)
    const blinking = () => {
      wasm.exports.ghostty_render_state_update(ptr)
      return wasm.exports.ghostty_render_state_get_cursor_blinking(ptr) !== 0
    }
    for (const [seq, wantShape, wantBlink] of [
      ['[1 q', CURSOR_STYLE_BLOCK, true],
      ['[2 q', CURSOR_STYLE_BLOCK, false],
      ['[3 q', CURSOR_STYLE_UNDERLINE, true],
      ['[4 q', CURSOR_STYLE_UNDERLINE, false],
      ['[5 q', CURSOR_STYLE_BAR, true],
      ['[6 q', CURSOR_STYLE_BAR, false],
    ] as const) {
      write(ptr, seq)
      expect(shape(ptr), seq).toBe(wantShape)
      expect(blinking(), seq).toBe(wantBlink)
    }
  })

  it('leaves a fresh terminal STEADY, which is why the preference is always written', () => {
    // The assumption that broke the blinking cursor. A fresh terminal looks
    // like a block, so it is tempting to read that as "blinking block, same as
    // the default preference, no need to write anything" — but the core leaves
    // DEC mode 12 off, so the shape matches and the blink does not. Skipping
    // the write on that basis left mode 12 false while the preference said
    // blink, and once the render loop started taking blink from the core the
    // cursor stopped blinking entirely.
    const ptr = term(20, 3)
    wasm.exports.ghostty_render_state_update(ptr)
    expect(wasm.exports.ghostty_render_state_get_cursor_style(ptr)).toBe(CURSOR_STYLE_BLOCK)
    expect(wasm.exports.ghostty_render_state_get_cursor_blinking(ptr)).toBeFalsy()

    // ...and the default preference is not that, so it has real work to do.
    write(ptr, cursorStyleSequence('block', true))
    wasm.exports.ghostty_render_state_update(ptr)
    expect(wasm.exports.ghostty_render_state_get_cursor_blinking(ptr)).toBeTruthy()
  })

  it('is read off the render state, so it follows an update rather than leading it', () => {
    // The shape has to belong to the same snapshot as the cursor position; if
    // it were sampled before update() it would describe the previous frame.
    const ptr = term(20, 3)
    write(ptr, '\x1b[5 q')
    expect(shape(ptr)).toBe(CURSOR_STYLE_BAR)
    write(ptr, '\x1b[2 q')
    expect(shape(ptr)).toBe(CURSOR_STYLE_BLOCK)
  })
})
