/**
 * The two exports our WASM shim added:
 *
 *   ghostty_terminal_is_scrollback_row_wrapped  — search across a wrapped line
 *   ghostty_render_state_get_cursor_style       — DECSCUSR shape
 *
 * Driven against the core directly, so a failure is plainly on that side.
 * The configured cursor surviving a reset is a terminal property on ghostty
 * `main`, tested below.
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
    // The half of DECSCUSR that was ignored: honoring only the shape made
    // ESC[1 q and ESC[2 q render identically, because the engine blinked on its
    // own timer regardless.
    const ptr = term(20, 3)
    const blinking = () => {
      wasm.exports.ghostty_render_state_update(ptr)
      return wasm.exports.ghostty_render_state_get_cursor_blinking(ptr) !== 0
    }
    for (const [seq, wantShape, wantBlink] of [
      ['\x1b[1 q', CURSOR_STYLE_BLOCK, true],
      ['\x1b[2 q', CURSOR_STYLE_BLOCK, false],
      ['\x1b[3 q', CURSOR_STYLE_UNDERLINE, true],
      ['\x1b[4 q', CURSOR_STYLE_UNDERLINE, false],
      ['\x1b[5 q', CURSOR_STYLE_BAR, true],
      ['\x1b[6 q', CURSOR_STYLE_BAR, false],
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

/**
 * The configured cursor across a full reset. RIS returns to the default
 * cursor, and on ghostty `main` the embedder sets that default through the
 * config, so the core holds it. An application's DECSCUSR after the reset
 * simply wins.
 */
describe('the cursor a reset returns to', () => {
  const configured = (style: number, blink: boolean) => {
    const ptr = createTerminal(wasm, 20, 3, {
      scrollbackLimit: 200,
      fgColor: 0xcccccc,
      bgColor: 0,
      cursorColor: 0,
      cursorStyle: style,
      cursorBlink: blink,
    })
    if (ptr === 0) throw new Error('terminal_new failed')
    return ptr
  }

  const shape = (ptr: number) => {
    wasm.exports.ghostty_render_state_update(ptr)
    return wasm.exports.ghostty_render_state_get_cursor_style(ptr)
  }

  const blinking = (ptr: number) => {
    wasm.exports.ghostty_render_state_update(ptr)
    return !!wasm.exports.ghostty_render_state_get_cursor_blinking(ptr)
  }

  it('is the core default when the embedder configured nothing', () => {
    const ptr = term(20, 3)
    write(ptr, cursorStyleSequence('bar', true))
    write(ptr, 'c')
    expect(shape(ptr)).toBe(CURSOR_STYLE_BLOCK)
    expect(blinking(ptr)).toBe(false)
  })

  it('is the configured cursor when there is one, with no host involvement', () => {
    // Done by the core: nothing writes DECSCUSR between reset and assertion.
    const ptr = configured(CURSOR_STYLE_BAR, true)
    expect(shape(ptr)).toBe(CURSOR_STYLE_BAR)
    write(ptr, '[2 q')
    expect(shape(ptr)).toBe(CURSOR_STYLE_BLOCK)
    write(ptr, 'c')
    expect(shape(ptr)).toBe(CURSOR_STYLE_BAR)
    expect(blinking(ptr)).toBe(true)
  })

  it('does not overwrite a cursor the application sets after resetting', () => {
    // The case the counter comparison existed for: a TUI resets and then asks
    // for its own cursor, both inside one write.
    const ptr = configured(CURSOR_STYLE_BAR, true)
    write(ptr, 'c[3 q')
    expect(shape(ptr)).toBe(CURSOR_STYLE_UNDERLINE)
  })

  it('survives a second reset, not just the first', () => {
    const ptr = configured(CURSOR_STYLE_UNDERLINE, false)
    write(ptr, 'c')
    expect(shape(ptr)).toBe(CURSOR_STYLE_UNDERLINE)
    write(ptr, '[5 q')
    write(ptr, 'c')
    expect(shape(ptr)).toBe(CURSOR_STYLE_UNDERLINE)
  })

  it('is answered by DECSCUSR 0, which asks for the default explicitly', () => {
    const ptr = configured(CURSOR_STYLE_BAR, true)
    write(ptr, '[2 q')
    write(ptr, '[0 q')
    expect(shape(ptr)).toBe(CURSOR_STYLE_BAR)
  })

  it('is restored by a soft reset too, as xterm does', () => {
    // DECSTR (since upstream f473f3109) resets as xterm's soft reset does,
    // cursor style included, back to the configured default as for RIS.
    const ptr = configured(CURSOR_STYLE_UNDERLINE, false)
    write(ptr, cursorStyleSequence('bar', true))
    write(ptr, '[!p')
    expect(shape(ptr)).toBe(CURSOR_STYLE_UNDERLINE)
    expect(blinking(ptr)).toBe(false)
  })
})
