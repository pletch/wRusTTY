import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { instantiateMainGhosttyWasm, isMainBuild } from './shim'
import {
  instantiateGhosttyWasm,
  createTerminal,
  writeBytes,
  writeString,
  readResponse,
  allocBuffer,
  parseCell,
  CELL_BYTES,
  CURSOR_STYLE_BAR,
  CURSOR_STYLE_BLOCK,
  CURSOR_STYLE_UNDERLINE,
  MODE_APP_CURSOR_KEYS,
  MODE_BRACKETED_PASTE,
  type GhosttyWasm,
  type TerminalConfig,
} from '../wasmBindings'
import { PALETTE_16, DEFAULT_FG, DEFAULT_BG } from '../../../bench/gridPalette'

/**
 * The shim answering our ABI, checked against the vendored build answering the
 * same calls — the same input, the same call sequence, the same expectations.
 *
 * The readers underneath are already asserted byte-identical one at a time
 * (`ViewportReader.test.ts`, `ScrollbackReader.test.ts`, `effects.test.ts`).
 * What this covers is everything the shim itself invents: which render state
 * belongs to which terminal, when the snapshot is rebuilt, the config struct
 * unpacked into `set` calls, the cursor style renumbering, and the reply queue
 * rebuilt over a callback. Each of those is a place where both builds return a
 * plausible number and only one of them is right.
 *
 * Skips without a comparison build; see `vendor-main/README.md`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const MAIN_WASM = process.env.GHOSTTY_MAIN_WASM ?? join(here, 'vendor-main/ghostty-vt.wasm')
const VENDORED = join(here, '../vendor-131/ghostty-vt.wasm')

const COLS = 40
const ROWS = 8
const CELLS = COLS * ROWS

const CONFIG: TerminalConfig = {
  scrollbackLimit: 1024 * 1024,
  fgColor: DEFAULT_FG,
  bgColor: DEFAULT_BG,
  cursorColor: 0,
  palette: [...PALETTE_16],
}

const run = existsSync(MAIN_WASM) ? describe : describe.skip

run('the main shim, against the ABI it replaces', () => {
  let mainWasm: Promise<GhosttyWasm> | null = null
  const loadMain = () =>
    (mainWasm ??= instantiateMainGhosttyWasm(readFileSync(MAIN_WASM).buffer as ArrayBuffer))

  let vendored: Promise<GhosttyWasm> | null = null
  const loadVendored = () =>
    (vendored ??= instantiateGhosttyWasm(readFileSync(VENDORED).buffer as ArrayBuffer))

  /**
   * One terminal per case, driven only through `GhosttyExports`. The body is
   * deliberately identical for both builds — anything a case has to do
   * differently is a hole in the shim, not a detail of the test.
   */
  async function withBoth<T>(
    body: (wasm: GhosttyWasm, term: number) => T,
    config: TerminalConfig = CONFIG,
  ): Promise<{ main: T; old: T }> {
    const results: T[] = []
    for (const wasm of [await loadMain(), await loadVendored()]) {
      const term = createTerminal(wasm, COLS, ROWS, config)
      expect(term).not.toBe(0)
      results.push(body(wasm, term))
      wasm.exports.ghostty_terminal_free(term)
    }
    return { main: results[0], old: results[1] }
  }

  const same = async <T,>(body: (wasm: GhosttyWasm, term: number) => T, config?: TerminalConfig) => {
    const { main, old } = await withBoth(body, config)
    expect(main).toEqual(old)
    return main
  }

  it('recognises which build it is looking at', async () => {
    const main = await loadMain()
    const old = await loadVendored()
    expect(isMainBuild(main.instance)).toBe(true)
    expect(isMainBuild(old.instance)).toBe(false)
  })

  it('reports the dimensions it was created with', () =>
    same((wasm, term) => {
      wasm.exports.ghostty_render_state_update(term)
      return [
        wasm.exports.ghostty_render_state_get_cols(term),
        wasm.exports.ghostty_render_state_get_rows(term),
      ]
    }).then((dims) => expect(dims).toEqual([COLS, ROWS])))

  it('fills the viewport buffer with the same bytes', async () => {
    const text = 'hello \x1b[1;31mworld\x1b[0m\r\n\x1b[44mpainted\x1b[K\r\n世界 é done'
    const { main, old } = await withBoth((wasm, term) => {
      writeString(wasm, term, text)
      wasm.exports.ghostty_render_state_update(term)
      const ptr = allocBuffer(wasm, CELLS * CELL_BYTES)
      new Uint8Array(wasm.exports.memory.buffer, ptr, CELLS * CELL_BYTES).fill(0)
      wasm.exports.ghostty_render_state_get_viewport(term, ptr, CELLS)
      const buf = new Uint8Array(wasm.exports.memory.buffer, ptr, CELLS * CELL_BYTES).slice()
      // Bytes 12-13 are the hyperlink id, the one documented divergence.
      for (let i = 0; i < buf.length; i += CELL_BYTES) {
        buf[i + 12] = 0
        buf[i + 13] = 0
      }
      return buf
    })
    for (let i = 0; i < old.length; i += CELL_BYTES) {
      const a = Array.from(old.slice(i, i + CELL_BYTES)).join(' ')
      const b = Array.from(main.slice(i, i + CELL_BYTES)).join(' ')
      if (a !== b) {
        const cell = i / CELL_BYTES
        throw new Error(
          `cell ${cell} (row ${Math.floor(cell / COLS)}, col ${cell % COLS}) differs\n` +
            `  vendored: ${a}\n  shim    : ${b}`,
        )
      }
    }
    expect(main).toEqual(old)
  })

  it('reads no more rows than the caller sized the buffer for', () =>
    same((wasm, term) => {
      writeString(wasm, term, 'one\r\ntwo\r\nthree\r\nfour')
      wasm.exports.ghostty_render_state_update(term)
      // Two rows' worth of a buffer for an eight-row viewport. The tail of a
      // short read has to stay untouched, not carry whatever came before.
      const ptr = allocBuffer(wasm, CELLS * CELL_BYTES)
      new Uint8Array(wasm.exports.memory.buffer, ptr, CELLS * CELL_BYTES).fill(0xee)
      wasm.exports.ghostty_render_state_get_viewport(term, ptr, COLS * 2)
      const buf = new Uint8Array(wasm.exports.memory.buffer, ptr, CELLS * CELL_BYTES)
      return [buf[COLS * 2 * CELL_BYTES], buf[CELLS * CELL_BYTES - 1]]
    }).then((tail) => expect(tail).toEqual([0xee, 0xee])))

  it('tracks the cursor through the same snapshot as the cells', () =>
    same((wasm, term) => {
      writeString(wasm, term, 'abc\r\n\x1b[3;7H')
      wasm.exports.ghostty_render_state_update(term)
      return [
        wasm.exports.ghostty_render_state_get_cursor_x(term),
        wasm.exports.ghostty_render_state_get_cursor_y(term),
        wasm.exports.ghostty_render_state_get_cursor_visible(term),
      ]
    }).then((c) => expect(c).toEqual([6, 2, 1])))

  it('hides the cursor when the program does', () =>
    same((wasm, term) => {
      writeString(wasm, term, '\x1b[?25l')
      wasm.exports.ghostty_render_state_update(term)
      return wasm.exports.ghostty_render_state_get_cursor_visible(term)
    }).then((v) => expect(v).toBe(0)))

  /**
   * The renumbering, stated as behaviour rather than as a mapping table: main
   * numbers bar=0/block=1 where ours numbers block=0/bar=1, so a shim that
   * passed the value straight through would answer every DECSCUSR with the
   * other shape and never fail a call.
   */
  it.each([
    ['steady block', '\x1b[2 q', CURSOR_STYLE_BLOCK],
    ['blinking bar', '\x1b[5 q', CURSOR_STYLE_BAR],
    ['steady underline', '\x1b[4 q', CURSOR_STYLE_UNDERLINE],
  ])('answers DECSCUSR %s with the shape our ABI numbers', (_name, seq, want) =>
    same((wasm, term) => {
      writeString(wasm, term, seq)
      wasm.exports.ghostty_render_state_update(term)
      return wasm.exports.ghostty_render_state_get_cursor_style(term)
    }).then((shape) => expect(shape).toBe(want)))

  it('reports whether DECSCUSR asked for a blinking cursor', () =>
    same((wasm, term) => {
      writeString(wasm, term, '\x1b[5 q')
      wasm.exports.ghostty_render_state_update(term)
      const blinking = wasm.exports.ghostty_render_state_get_cursor_blinking(term)
      writeString(wasm, term, '\x1b[2 q')
      wasm.exports.ghostty_render_state_update(term)
      return [blinking, wasm.exports.ghostty_render_state_get_cursor_blinking(term)]
    }).then((b) => expect(b).toEqual([1, 0])))

  it('hands back the configured default colours', () =>
    same((wasm, term) => {
      wasm.exports.ghostty_render_state_update(term)
      return [
        wasm.exports.ghostty_render_state_get_fg_color(term),
        wasm.exports.ghostty_render_state_get_bg_color(term),
      ]
    }).then((c) => expect(c).toEqual([DEFAULT_FG, DEFAULT_BG])))

  it('resolves palette colours from the 16 the config carries', () =>
    same((wasm, term) => {
      // Index 4 is blue in PALETTE_16; a shim that dropped the palette would
      // answer the core's own blue instead, which is a different blue.
      writeString(wasm, term, '\x1b[34mX')
      wasm.exports.ghostty_render_state_update(term)
      const ptr = allocBuffer(wasm, CELLS * CELL_BYTES)
      new Uint8Array(wasm.exports.memory.buffer, ptr, CELLS * CELL_BYTES).fill(0)
      wasm.exports.ghostty_render_state_get_viewport(term, ptr, CELLS)
      const cell = parseCell(new DataView(wasm.exports.memory.buffer, ptr, CELL_BYTES), 0)
      return [cell.fgR, cell.fgG, cell.fgB]
    }).then((rgb) =>
      expect(rgb).toEqual([(PALETTE_16[4] >> 16) & 0xff, (PALETTE_16[4] >> 8) & 0xff, PALETTE_16[4] & 0xff]),
    ))

  it('answers modes the input path asks about', () =>
    same((wasm, term) => {
      writeString(wasm, term, '\x1b[?1h\x1b[?2004h')
      const on = [
        wasm.exports.ghostty_terminal_get_mode(term, MODE_APP_CURSOR_KEYS, 0),
        wasm.exports.ghostty_terminal_get_mode(term, MODE_BRACKETED_PASTE, 0),
      ]
      writeString(wasm, term, '\x1b[?1l')
      return [...on, wasm.exports.ghostty_terminal_get_mode(term, MODE_APP_CURSOR_KEYS, 0)]
    }).then((m) => expect(m).toEqual([1, 1, 0])))

  it('follows the alternate screen', () =>
    same((wasm, term) => {
      const before = wasm.exports.ghostty_terminal_is_alternate_screen(term)
      writeString(wasm, term, '\x1b[?1049h')
      const during = wasm.exports.ghostty_terminal_is_alternate_screen(term)
      writeString(wasm, term, '\x1b[?1049l')
      return [before, during, wasm.exports.ghostty_terminal_is_alternate_screen(term)]
    }).then((s) => expect(s).toEqual([0, 1, 0])))

  it('reports mouse tracking only while something is tracking', () =>
    same((wasm, term) => {
      const before = wasm.exports.ghostty_terminal_has_mouse_tracking(term)
      writeString(wasm, term, '\x1b[?1002h')
      const during = wasm.exports.ghostty_terminal_has_mouse_tracking(term)
      writeString(wasm, term, '\x1b[?1002l')
      return [before, during, wasm.exports.ghostty_terminal_has_mouse_tracking(term)]
    }).then((t) => expect(t).toEqual([0, 1, 0])))

  it('grows scrollback to the byte budget the config asks for', async () => {
    let s = ''
    for (let i = 0; i < 400; i++) s += `line ${i} of history\r\n`
    const depth = await same((wasm, term) => {
      writeString(wasm, term, s)
      return wasm.exports.ghostty_terminal_get_scrollback_length(term)
    })
    // The number itself is the vendored build's; what matters is that both
    // reach it, i.e. that the budget crossed the boundary at all. main's own
    // default is 10,000 *bytes* and would have stopped far short.
    expect(depth).toBeGreaterThan(300)
  })

  it('reads scrollback rows as the same bytes', async () => {
    let s = ''
    for (let i = 0; i < 40; i++) s += `\x1b[3${i % 8}mrow ${i} of scrollback\x1b[0m\r\n`
    const { main, old } = await withBoth((wasm, term) => {
      writeString(wasm, term, s)
      wasm.exports.ghostty_render_state_update(term)
      const ptr = allocBuffer(wasm, COLS * CELL_BYTES)
      const rows: number[][] = []
      for (const y of [0, 1, 17]) {
        new Uint8Array(wasm.exports.memory.buffer, ptr, COLS * CELL_BYTES).fill(0)
        wasm.exports.ghostty_terminal_get_scrollback_line(term, y, ptr, COLS)
        rows.push(Array.from(new Uint8Array(wasm.exports.memory.buffer, ptr, COLS * CELL_BYTES)))
      }
      return rows
    })
    // Hyperlink ids again: bytes 12-13 of each cell.
    for (const rows of [main, old]) {
      for (const row of rows) {
        for (let i = 0; i < row.length; i += CELL_BYTES) {
          row[i + 12] = 0
          row[i + 13] = 0
        }
      }
    }
    expect(main).toEqual(old)
  })

  it('answers the wrap question in both coordinate spaces', async () => {
    // A line long enough to wrap, then enough output to push it into history,
    // so the same logical line is asked about from both sides of the split.
    const long = 'w'.repeat(COLS + 10)
    const wraps = await same((wasm, term) => {
      writeString(wasm, term, `${long}\r\nshort\r\n`)
      let s = ''
      for (let i = 0; i < 20; i++) s += `filler ${i}\r\n`
      writeString(wasm, term, s)
      wasm.exports.ghostty_render_state_update(term)
      return [
        // The flag marks the *continuation*, which is what `logicalLines`
        // joins on: row 1 carries the tail of the line that began on row 0, so
        // row 1 is the wrapped one and row 0 is not.
        wasm.exports.ghostty_terminal_is_scrollback_row_wrapped(term, 0),
        wasm.exports.ghostty_terminal_is_scrollback_row_wrapped(term, 1),
        wasm.exports.ghostty_terminal_is_row_wrapped(term, 0),
      ]
    })
    expect(wraps[0]).toBe(0)
    expect(wraps[1]).toBe(1)
  })

  it('returns grapheme clusters from the active screen and from scrollback', async () => {
    const combining = 'é'
    let filler = ''
    for (let i = 0; i < 20; i++) filler += `filler ${i}\r\n`
    const { main, old } = await withBoth((wasm, term) => {
      writeString(wasm, term, `${combining} in history\r\n${filler}${combining} on screen`)
      wasm.exports.ghostty_render_state_update(term)
      const scrollbackCount = wasm.exports.ghostty_terminal_get_scrollback_length(term)
      const gPtr = allocBuffer(wasm, 16 * 4)
      const read = (n: number) => {
        const v = new DataView(wasm.exports.memory.buffer, gPtr, 16 * 4)
        return Array.from({ length: n }, (_, i) => v.getUint32(i * 4, true))
      }
      const nHistory = wasm.exports.ghostty_terminal_get_scrollback_grapheme(term, 0, 0, gPtr, 16)
      const history = read(nHistory)
      const activeRow = ROWS - 1
      const nActive = wasm.exports.ghostty_render_state_get_grapheme(term, activeRow, 0, gPtr, 16)
      return { scrollbackCount, history, active: read(nActive) }
    })
    expect(main.history).toEqual([0x65, 0x301])
    expect(main).toEqual(old)
  })

  it('answers queries that our ABI drains from a queue', async () => {
    const { main, old } = await withBoth((wasm, term) => {
      writeString(wasm, term, 'hello\r\nworld\x1b[6n\x1b[c\x1b[5n')
      const replies: string[] = []
      for (let i = 0; i < 64; i++) {
        const r = readResponse(wasm, term)
        if (!r || r.length === 0) break
        replies.push(new TextDecoder().decode(r))
      }
      return replies
    })
    // The vendored side may coalesce several replies into one drain, so the
    // bytes are what is compared, not the chunking.
    expect(main.join('')).toBe(old.join(''))
    expect(main.join('')).toContain('\x1b[2;6R')
  })

  it('says nothing when nothing has been asked', () =>
    same((wasm, term) => {
      writeString(wasm, term, 'plain output\r\n')
      return wasm.exports.ghostty_terminal_has_response(term)
    }).then((n) => expect(n).toBe(0)))

  /**
   * The replacement for `last_reset_seq` / `last_cursor_style_seq`, which the
   * shim answers with 0. Those exist only because RIS discarded the configured
   * cursor and the host had to decide whether to put it back; here the core
   * keeps it. Main-only: the vendored core reads no cursor out of the config
   * and comes back from a reset as a steady block.
   */
  it('returns to the configured cursor after a reset, without being told to', async () => {
    const wasm = await loadMain()
    const term = createTerminal(wasm, COLS, ROWS, {
      ...CONFIG,
      cursorStyle: CURSOR_STYLE_BAR,
      cursorBlink: true,
    })
    const shape = () => {
      wasm.exports.ghostty_render_state_update(term)
      return [
        wasm.exports.ghostty_render_state_get_cursor_style(term),
        wasm.exports.ghostty_render_state_get_cursor_blinking(term),
      ]
    }
    expect(shape()).toEqual([CURSOR_STYLE_BAR, 1])
    writeString(wasm, term, '\x1b[2 q')
    expect(shape()).toEqual([CURSOR_STYLE_BLOCK, 0])
    writeString(wasm, term, '\x1bc')
    expect(shape()).toEqual([CURSOR_STYLE_BAR, 1])
    wasm.exports.ghostty_terminal_free(term)
  })

  it('keeps two terminals in the same instance apart', async () => {
    const wasm = await loadMain()
    const a = createTerminal(wasm, COLS, ROWS, CONFIG)
    const b = createTerminal(wasm, COLS * 2, ROWS + 4, CONFIG)
    writeString(wasm, a, 'in a\x1b[6n')
    writeString(wasm, b, 'in b')
    wasm.exports.ghostty_render_state_update(a)
    wasm.exports.ghostty_render_state_update(b)

    expect(wasm.exports.ghostty_render_state_get_cols(a)).toBe(COLS)
    expect(wasm.exports.ghostty_render_state_get_cols(b)).toBe(COLS * 2)
    // The reply belongs to `a`, and asking `b` must not produce it.
    expect(wasm.exports.ghostty_terminal_has_response(b)).toBe(0)
    expect(wasm.exports.ghostty_terminal_has_response(a)).toBe(1)

    wasm.exports.ghostty_terminal_free(a)
    // Freeing one leaves the other usable — the shared table slot for the
    // effect callback is recycled, and a stale entry would trap here.
    writeString(wasm, b, ' still alive\x1b[6n')
    expect(wasm.exports.ghostty_terminal_has_response(b)).toBe(1)
    wasm.exports.ghostty_terminal_free(b)
  })

  it('resizes', () =>
    same((wasm, term) => {
      wasm.exports.ghostty_terminal_resize(term, COLS + 10, ROWS + 2)
      wasm.exports.ghostty_render_state_update(term)
      return [
        wasm.exports.ghostty_render_state_get_cols(term),
        wasm.exports.ghostty_render_state_get_rows(term),
      ]
    }).then((dims) => expect(dims).toEqual([COLS + 10, ROWS + 2])))

  it('accepts raw bytes through the same write path', () =>
    same((wasm, term) => {
      writeBytes(wasm, term, new TextEncoder().encode('bytes\r\nnot strings'))
      wasm.exports.ghostty_render_state_update(term)
      const ptr = allocBuffer(wasm, CELLS * CELL_BYTES)
      new Uint8Array(wasm.exports.memory.buffer, ptr, CELLS * CELL_BYTES).fill(0)
      wasm.exports.ghostty_render_state_get_viewport(term, ptr, CELLS)
      const v = new DataView(wasm.exports.memory.buffer, ptr, CELLS * CELL_BYTES)
      return parseCell(v, 0).codepoint
    }).then((cp) => expect(cp).toBe('b'.codePointAt(0))))
})
