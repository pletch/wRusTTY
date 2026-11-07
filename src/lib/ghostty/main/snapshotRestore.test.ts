import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { estimateScrollbackRows } from '../GhosttyEngine'
import * as abi from './abi'

/**
 * Holds the core to what `docs/ANDROID_PLAN.md`, "Restoring a terminal", relies
 * on: a snapshot taken in one WASM instance restores in another, and output fed
 * after the restore lands exactly as if nothing had happened.
 *
 * Each restore uses a new instance with its own linear memory, because that's
 * what a new WebView is. Only the snapshot's bytes cross over.
 *
 * Against the shipped binary, so it runs on CI. `GHOSTTY_VT_WASM` points it at
 * another build. `SNAPSHOT_MEASURE=1` also prints size and timing figures.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = process.env.GHOSTTY_VT_WASM ?? join(here, '../vendor/ghostty-vt.wasm')
const module = new WebAssembly.Module(Uint8Array.from(readFileSync(WASM)))

/** Not used by the app yet, so not in `abi.ts`. */
interface SnapshotExports {
  __indirect_function_table: WebAssembly.Table
  ghostty_free(alloc: number, ptr: number, len: number): void
  /** `writer` and `reader` are two-word structs, passed by pointer on wasm32. */
  ghostty_snapshot_encode(term: number, writer: number): number
  ghostty_snapshot_decoder_new(alloc: number, slot: number, reader: number): number
  ghostty_snapshot_encode_alloc(term: number, alloc: number, outPtr: number, outLen: number): number
  ghostty_snapshot_decoder_new_buf(alloc: number, slot: number, ptr: number, len: number): number
  ghostty_snapshot_decoder_decode(decoder: number, slot: number): number
  ghostty_snapshot_decoder_free(decoder: number): void
  ghostty_formatter_terminal_new(alloc: number, slot: number, term: number): number
  ghostty_formatter_set(fmt: number, option: number, value: number): number
  ghostty_formatter_format_alloc(fmt: number, alloc: number, outPtr: number, outLen: number): number
  ghostty_formatter_free(fmt: number): void
}
type Ex = abi.GhosttyMainExports & SnapshotExports

const GHOSTTY_IO_ERROR = -5

const T_OPT_CONTINUATION_MAX_BYTES = abi.T_OPT_CONTINUATION_MAX_BYTES
const CONTINUATION_LIMIT = 64 * 1024

/**
 * Formatter options, set by key since vt-1.0.0 (`formatter.h`). A wrong key
 * would leave an extra off and weaken every comparison, so `formatted output
 * includes the state it's compared on` checks that the extras really are on.
 */
const FORMAT_PLAIN = 0
const FORMAT_VT = 1
const FORMATTER_OPT_EMIT = 1
const FORMATTER_OPT_UNWRAP = 2
const FORMATTER_OPT_TRIM = 3
const FORMATTER_OPT_EXTRAS = 5
/** `GHOSTTY_FORMATTER_EXTRAS_ALL`: palette, modes, regions, tab stops, pwd,
 *  keyboard, cursor, style, hyperlink, protection, Kitty flags, charsets. */
const FORMATTER_EXTRAS_ALL = 0xfff

function newInstance(): Ex {
  return new WebAssembly.Instance(module, { env: { log: () => {} } }).exports as unknown as Ex
}

/**
 * A table entry for a JS function `(i32 x arity) -> i32`. `effects.ts` has the
 * void version; `GhosttyWriterFn` and `GhosttyReaderFn` return a bool.
 */
function tableEntry(ex: Ex, arity: number, cb: (...args: number[]) => number): number {
  const i32s = new Array<number>(arity).fill(0x7f)
  const gets = Array.from({ length: arity }, (_, i) => [0x20, i]).flat()
  const body = [0x00, ...gets, 0x10, 0x00, 0x0b]
  const bytes = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    // type: (i32 x arity) -> i32
    0x01, 5 + arity, 0x01, 0x60, arity, ...i32s, 0x01, 0x7f,
    // import env.cb
    0x02, 0x0a, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x02, 0x63, 0x62, 0x00, 0x00,
    // one function, exported as "f"
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x01,
    0x0a, body.length + 2, 0x01, body.length, ...body,
  ])
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { cb } })
  const table = ex.__indirect_function_table
  const slot = table.grow(1)
  table.set(slot, inst.exports.f as WebAssembly.ExportValue)
  return slot
}

class Term {
  readonly ex: Ex
  readonly term: number

  constructor(ex: Ex, term: number) {
    this.ex = ex
    this.term = term
  }

  private view() {
    return new DataView(this.ex.memory.buffer)
  }

  /** Reads one value through `ghostty_terminal_get`. */
  private get(key: number, read: (v: DataView, at: number) => number): number {
    const out = this.ex.ghostty_wasm_alloc(16)
    abi.expectOk(this.ex.ghostty_terminal_get(this.term, key, out), `terminal_get ${key}`)
    const value = read(this.view(), out)
    this.ex.ghostty_wasm_free(out, 16)
    return value
  }

  setUsize(key: number, value: number) {
    const p = this.ex.ghostty_wasm_alloc(4)
    this.view().setUint32(p, value, true)
    abi.expectOk(this.ex.ghostty_terminal_set(this.term, key, p), `terminal_set ${key}`)
    this.ex.ghostty_wasm_free(p, 4)
  }

  write(data: string | Uint8Array) {
    const b = typeof data === 'string' ? new TextEncoder().encode(data) : data
    if (b.length === 0) return
    const p = this.ex.ghostty_wasm_alloc(b.length)
    new Uint8Array(this.ex.memory.buffer).set(b, p)
    this.ex.ghostty_terminal_vt_write(this.term, p, b.length)
    this.ex.ghostty_wasm_free(p, b.length)
  }

  /** Copies an allocated result out of this instance, then frees it. */
  private takeAlloc(call: (outPtr: number, outLen: number) => number, what: string): Uint8Array {
    const slots = this.ex.ghostty_wasm_alloc(8)
    abi.expectOk(call(slots, slots + 4), what)
    const ptr = this.view().getUint32(slots, true)
    const len = this.view().getUint32(slots + 4, true)
    const out = new Uint8Array(this.ex.memory.buffer, ptr, len).slice()
    if (ptr !== 0) this.ex.ghostty_free(0, ptr, len)
    this.ex.ghostty_wasm_free(slots, 8)
    return out
  }

  encodeResult(): number {
    const slots = this.ex.ghostty_wasm_alloc(8)
    const result = this.ex.ghostty_snapshot_encode_alloc(this.term, 0, slots, slots + 4)
    if (result === abi.GHOSTTY_SUCCESS) {
      this.ex.ghostty_free(0, this.view().getUint32(slots, true), this.view().getUint32(slots + 4, true))
    }
    this.ex.ghostty_wasm_free(slots, 8)
    return result
  }

  snapshot(): Uint8Array {
    return this.takeAlloc(
      (p, l) => this.ex.ghostty_snapshot_encode_alloc(this.term, 0, p, l),
      'snapshot_encode_alloc',
    )
  }

  /**
   * `ghostty_snapshot_encode`, handing each chunk to `onChunk` and copying it out
   * of the heap as it arrives. Returns the core's result code.
   */
  streamTo(onChunk: (chunk: Uint8Array) => boolean): number {
    const slot = this.writerSlot ?? tableEntry(this.ex, 3, (_userdata, ptr, len) =>
      this.onChunk(new Uint8Array(this.ex.memory.buffer, ptr, len).slice()) ? 1 : 0,
    )
    this.writerSlot = slot
    this.onChunk = onChunk
    const writer = this.ex.ghostty_wasm_alloc(8)
    this.view().setUint32(writer, slot, true)
    this.view().setUint32(writer + 4, 0, true)
    const result = this.ex.ghostty_snapshot_encode(this.term, writer)
    this.ex.ghostty_wasm_free(writer, 8)
    return result
  }
  private writerSlot: number | null = null
  private onChunk: (chunk: Uint8Array) => boolean = () => false

  /** The same snapshot through the writer, with how it arrived. */
  streamedSnapshot(): { bytes: Uint8Array; chunks: number; largest: number } {
    const parts: Uint8Array[] = []
    abi.expectOk(this.streamTo((c) => (parts.push(c), true)), 'snapshot_encode')
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
      bytes.set(p, at)
      at += p.length
    }
    return { bytes, chunks: parts.length, largest: Math.max(...parts.map((p) => p.length)) }
  }

  private format(emit: number): string {
    const slot = this.ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(this.ex.ghostty_formatter_terminal_new(0, slot, this.term), 'formatter_new')
    const fmt = this.view().getUint32(slot, true)
    const value = this.ex.ghostty_wasm_alloc(4)
    const set = (option: number, v: number) => {
      this.view().setUint32(value, v, true)
      abi.expectOk(this.ex.ghostty_formatter_set(fmt, option, value), `formatter_set ${option}`)
    }
    set(FORMATTER_OPT_EMIT, emit)
    // As before the option keys: rows as they are, untrimmed, every extra.
    set(FORMATTER_OPT_UNWRAP, 0)
    set(FORMATTER_OPT_TRIM, 0)
    set(FORMATTER_OPT_EXTRAS, FORMATTER_EXTRAS_ALL)
    this.ex.ghostty_wasm_free(value, 4)
    const bytes = this.takeAlloc(
      (p, l) => this.ex.ghostty_formatter_format_alloc(fmt, 0, p, l),
      'formatter_format_alloc',
    )
    this.ex.ghostty_formatter_free(fmt)
    this.ex.ghostty_wasm_free_opaque(slot)
    return new TextDecoder().decode(bytes)
  }

  /** The active screen and its scrollback, with colors, modes and cursor. */
  vt = () => this.format(FORMAT_VT)
  text = () => this.format(FORMAT_PLAIN)

  scrollbackRows = () => this.get(abi.T_DATA_SCROLLBACK_ROWS, (v, at) => v.getUint32(at, true))
  activeScreen = () => this.get(abi.T_DATA_ACTIVE_SCREEN, (v, at) => v.getUint32(at, true))
  scrollbackMaxBytes = () => this.get(abi.T_DATA_SCROLLBACK_MAX_BYTES, (v, at) => v.getUint32(at, true))
  scrollbackMaxLines = () => this.get(abi.T_DATA_SCROLLBACK_MAX_LINES, (v, at) => v.getUint32(at, true))
  cursor = () => ({
    x: this.get(abi.T_DATA_CURSOR_X, (v, at) => v.getUint16(at, true)),
    y: this.get(abi.T_DATA_CURSOR_Y, (v, at) => v.getUint16(at, true)),
  })
  kittyFlags = () => this.get(abi.T_DATA_KITTY_KEYBOARD_FLAGS, (v, at) => v.getUint8(at))

  mode(mode: number): boolean {
    const cfg = this.ex.ghostty_wasm_alloc(abi.MODE_CONFIG_SIZE)
    this.view().setUint16(cfg + abi.MODE_CONFIG_MODE_OFFSET, abi.ansiMode(mode, false), true)
    abi.expectOk(this.ex.ghostty_terminal_get(this.term, abi.T_DATA_MODE, cfg), `mode ${mode}`)
    const on = this.view().getUint8(cfg + abi.MODE_CONFIG_VALUE_OFFSET) !== 0
    this.ex.ghostty_wasm_free(cfg, abi.MODE_CONFIG_SIZE)
    return on
  }
}

function open(cols: number, rows: number, opts: { tracking?: boolean; scrollbackBytes?: number } = {}): Term {
  const ex = newInstance()
  const slot = ex.ghostty_wasm_alloc_opaque()
  abi.expectOk(ex.ghostty_terminal_new(0, slot, cols, rows), 'terminal_new')
  const t = new Term(ex, new DataView(ex.memory.buffer).getUint32(slot, true))
  ex.ghostty_wasm_free_opaque(slot)
  if (opts.tracking !== false) t.setUsize(T_OPT_CONTINUATION_MAX_BYTES, CONTINUATION_LIMIT)
  t.setUsize(abi.T_OPT_SCROLLBACK_MAX_BYTES, opts.scrollbackBytes ?? 8 * 1024 * 1024)
  return t
}

/** Decodes a snapshot in a new instance, as a new WebView would. */
function restore(snapshot: Uint8Array): Term {
  const ex = newInstance()
  const buf = ex.ghostty_wasm_alloc(snapshot.length)
  new Uint8Array(ex.memory.buffer).set(snapshot, buf)
  const slot = ex.ghostty_wasm_alloc_opaque()
  abi.expectOk(ex.ghostty_snapshot_decoder_new_buf(0, slot, buf, snapshot.length), 'decoder_new_buf')
  const decoder = new DataView(ex.memory.buffer).getUint32(slot, true)
  abi.expectOk(ex.ghostty_snapshot_decoder_decode(decoder, slot), 'decoder_decode')
  const term = new DataView(ex.memory.buffer).getUint32(slot, true)
  ex.ghostty_snapshot_decoder_free(decoder)
  ex.ghostty_wasm_free_opaque(slot)
  ex.ghostty_wasm_free(buf, snapshot.length)
  // Tracking isn't retained by default; the next snapshot would need it.
  const t = new Term(ex, term)
  t.setUsize(T_OPT_CONTINUATION_MAX_BYTES, CONTINUATION_LIMIT)
  return t
}

/** As `restore`, but the core pulls the bytes, so they never all sit in the heap. */
function restoreStreamed(snapshot: Uint8Array): Term {
  const ex = newInstance()
  let offset = 0
  const read = tableEntry(ex, 4, (_userdata, buffer, capacity, outRead) => {
    const count = Math.min(capacity, snapshot.length - offset)
    new Uint8Array(ex.memory.buffer).set(snapshot.subarray(offset, offset + count), buffer)
    new DataView(ex.memory.buffer).setUint32(outRead, count, true)
    offset += count
    return 1
  })
  const reader = ex.ghostty_wasm_alloc(8)
  new DataView(ex.memory.buffer).setUint32(reader, read, true)
  new DataView(ex.memory.buffer).setUint32(reader + 4, 0, true)
  const slot = ex.ghostty_wasm_alloc_opaque()
  abi.expectOk(ex.ghostty_snapshot_decoder_new(0, slot, reader), 'decoder_new')
  const decoder = new DataView(ex.memory.buffer).getUint32(slot, true)
  abi.expectOk(ex.ghostty_snapshot_decoder_decode(decoder, slot), 'decoder_decode')
  const term = new DataView(ex.memory.buffer).getUint32(slot, true)
  ex.ghostty_snapshot_decoder_free(decoder)
  ex.ghostty_wasm_free_opaque(slot)
  ex.ghostty_wasm_free(reader, 8)
  const t = new Term(ex, term)
  t.setUsize(T_OPT_CONTINUATION_MAX_BYTES, CONTINUATION_LIMIT)
  return t
}

function expectSame(a: Term, b: Term) {
  expect(b.vt()).toBe(a.vt())
  expect(b.text()).toBe(a.text())
  expect(b.cursor()).toEqual(a.cursor())
  expect(b.activeScreen()).toBe(a.activeScreen())
  expect(b.scrollbackRows()).toBe(a.scrollbackRows())
}

/** What a shell session and a full-screen program put through a terminal. */
const SESSION = [
  'plain line\r\n',
  '\x1b[1;31mbold red\x1b[0m and \x1b[38;2;10;20;30mtruecolor\x1b[0m\r\n',
  'café 日本語 \u{1f600} é\r\n',
  '\x1b]0;a title\x07\x1b]7;file://host/tmp\x1b\\',
  '\x1b]8;;https://example.com\x1b\\a link\x1b]8;;\x1b\\\r\n',
  '\x1b[?2004h\x1b[?1h\x1b[>1u',
  '\x1b[?1049h\x1b[2J\x1b[H',
  '\x1b[?1000h\x1b[?1006h',
  '\x1b[3;20r\x1b[5;5H\x1b[7mstatus\x1b[0m',
  '\x1b(0lqk\x1b(B',
  '\x1b[?1000l\x1b[?1006l\x1b[r',
  '\x1b[?1049l',
  '\x1b[?2004l\x1b[?1l\x1b[<u',
  // Shell integration, then the clear a shell sends for ^L. At a prompt the core
  // scrolls before clearing, so it depends on restored prompt state.
  '\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07output\r\n\x1b]133;D;0\x07',
  '\x1b]133;A\x07back at the prompt $ \x1b]133;B\x07typing',
  '\x1b[H\x1b[2J',
  '\x1b]133;A\x07$ \x1b]133;B\x07',
].join('')

describe('a restored terminal', () => {
  it('formatted output includes the state it is compared on', () => {
    // Without this, a wrong options layout would pass every comparison below by
    // leaving the state out of both sides.
    const t = open(40, 6)
    t.write('\x1b[?2004h\x1b[1;31mred\x1b[0m')
    const vt = t.vt()
    expect(vt).toContain('red')
    expect(vt).toContain('\x1b[?2004h')
    // The formatter spells red as a palette index.
    expect(vt.slice(0, vt.indexOf('red'))).toContain('38;5;1')
    expect(t.text()).not.toContain('\x1b')
  })

  it('keeps the screen, cursor and scrollback', () => {
    const t = open(40, 6)
    for (let i = 0; i < 500; i++) t.write(`line ${i}\r\n`)
    t.write('\x1b[1;32mgreen\x1b[0m prompt$ ')

    const r = restore(t.snapshot())
    expect(t.scrollbackRows()).toBeGreaterThan(400)
    expectSame(t, r)
    expect(r.text()).toContain('line 0\n')
  })

  it('keeps the modes a far-end program set', () => {
    const t = open(40, 6)
    t.write('\x1b[?2004h\x1b[?1h\x1b[?1000h\x1b[?1006h\x1b[>5u')

    const r = restore(t.snapshot())
    expect(r.mode(2004)).toBe(true)
    expect(r.mode(1)).toBe(true)
    expect(r.mode(1000)).toBe(true)
    expect(r.mode(1006)).toBe(true)
    expect(r.kittyFlags()).toBe(5)
  })

  it('keeps both screens while a full-screen program is open', () => {
    const t = open(40, 6)
    for (let i = 0; i < 50; i++) t.write(`shell ${i}\r\n`)
    t.write('$ vim\r\n\x1b[?1049h\x1b[2J\x1b[Hediting a file')

    const r = restore(t.snapshot())
    expect(r.activeScreen()).toBe(abi.SCREEN_ALTERNATE)
    expectSame(t, r)
    expect(r.text()).toContain('editing a file')

    // Leaving the program brings the shell back, with its scrollback.
    t.write('\x1b[?1049l')
    r.write('\x1b[?1049l')
    expect(r.activeScreen()).toBe(abi.SCREEN_PRIMARY)
    expectSame(t, r)
    expect(r.text()).toContain('shell 0\n')
  })

  it('finishes an escape sequence the snapshot cut in half', () => {
    const t = open(40, 6)
    t.write('\x1b[31')

    const r = restore(t.snapshot())
    t.write('mred')
    r.write('mred')
    expectSame(t, r)
    // Text in place of the sequence would mean the parser state was lost.
    expect(r.text()).toBe('red')
  })

  it('finishes a UTF-8 character the snapshot cut in half', () => {
    const smile = new TextEncoder().encode('\u{1f600}')
    const t = open(40, 6)
    t.write(smile.slice(0, 2))

    const r = restore(t.snapshot())
    t.write(smile.slice(2))
    r.write(smile.slice(2))
    expectSame(t, r)
    expect(r.text()).toBe('\u{1f600}')
  })

  it('matches an uninterrupted terminal wherever the stream is cut', () => {
    // The property the design rests on: snapshot at byte N, then replay the bytes
    // after N. Rust will cut wherever a read happened to end.
    const bytes = new TextEncoder().encode(SESSION)
    const control = open(40, 24)
    control.write(bytes)

    for (let cut = 0; cut <= bytes.length; cut++) {
      const before = open(40, 24)
      before.write(bytes.slice(0, cut))
      const after = restore(before.snapshot())
      after.write(bytes.slice(cut))
      try {
        expectSame(control, after)
      } catch (e) {
        throw new Error(`differs when cut at byte ${cut}`, { cause: e })
      }
    }
  })

  it('still scrolls before clearing when the cursor was in shell input', () => {
    // Upstream's `ce920296c8` scenario: OSC 133;B with no row marked as a prompt
    // yet, so only the cursor carries the state. A restore that lost it would
    // clear without scrolling, and the output above would vanish. That commit
    // makes the clear depend on restored state, so this matters most on a re-pin.
    const t = open(10, 15)
    for (let i = 0; i < 10; i++) t.write('x\r\n')
    t.write('\x1b]133;B\x07echo hi')

    const r = restore(t.snapshot())
    for (const term of [t, r]) term.write('\r\nmore\x1b[H\x1b[2J')
    expectSame(t, r)
    expect(r.scrollbackRows()).toBeGreaterThan(0)
  })

  it('can be snapshotted and restored again', () => {
    // A long-lived session goes through this repeatedly.
    let t = open(40, 6)
    const control = open(40, 6)
    for (let round = 0; round < 5; round++) {
      const chunk = `\x1b[3${round}mround ${round}\x1b[0m\r\n`
      control.write(chunk)
      t.write(chunk)
      t = restore(t.snapshot())
    }
    expectSame(control, t)
  })

  it('accepts a resize and carries on', () => {
    const t = open(40, 6)
    for (let i = 0; i < 30; i++) t.write(`line ${i} with some length to it\r\n`)
    const r = restore(t.snapshot())
    expect(t.ex.ghostty_terminal_resize(t.term, 20, 10)).toBe(abi.GHOSTTY_SUCCESS)
    expect(r.ex.ghostty_terminal_resize(r.term, 20, 10)).toBe(abi.GHOSTTY_SUCCESS)
    expectSame(t, r)
  })

  it('keeps the title, directory, palette and scrollback caps', () => {
    // The engine reads these from the core, so what's carried needn't be replayed.
    const t = open(40, 6, { scrollbackBytes: 5 * 1024 * 1024 })
    t.setUsize(abi.T_OPT_SCROLLBACK_MAX_LINES, 1234)
    t.write('\x1b]0;a title\x07\x1b]7;file://host/tmp\x1b\\\x1b]4;1;rgb:01/02/03\x1b\\')

    const r = restore(t.snapshot())
    const str = (key: number) => {
      const out = r.ex.ghostty_wasm_alloc(8)
      abi.expectOk(r.ex.ghostty_terminal_get(r.term, key, out), `terminal_get ${key}`)
      const v = new DataView(r.ex.memory.buffer)
      const bytes = new Uint8Array(r.ex.memory.buffer, v.getUint32(out, true), v.getUint32(out + 4, true))
      return new TextDecoder().decode(bytes)
    }
    expect(str(abi.T_DATA_TITLE)).toBe('a title')
    expect(str(abi.T_DATA_PWD)).toBe('file://host/tmp')
    expect(r.vt()).toContain('4;1;rgb:01/02/03')
    expect(r.scrollbackMaxBytes()).toBe(5 * 1024 * 1024)
    expect(r.scrollbackMaxLines()).toBe(1234)
  })

  it('needs tracking on before the first byte to snapshot mid-sequence', () => {
    // Why the engine has to turn tracking on at creation. Without it, a snapshot
    // works until a read happens to end inside an escape sequence.
    const t = open(40, 6, { tracking: false })
    t.write('hello')
    expect(t.encodeResult()).toBe(abi.GHOSTTY_SUCCESS)
    t.write('\x1b[31')
    expect(t.encodeResult()).not.toBe(abi.GHOSTTY_SUCCESS)
  })

  it('rejects damaged and truncated snapshots', () => {
    // A failed restore has to be noticed, so the app can fall back to a reconnect.
    const t = open(40, 6)
    t.write('hello')
    const good = t.snapshot()

    const decodeResult = (bytes: Uint8Array) => {
      const ex = newInstance()
      const buf = ex.ghostty_wasm_alloc(bytes.length)
      new Uint8Array(ex.memory.buffer).set(bytes, buf)
      const slot = ex.ghostty_wasm_alloc_opaque()
      abi.expectOk(ex.ghostty_snapshot_decoder_new_buf(0, slot, buf, bytes.length), 'decoder_new_buf')
      const decoder = new DataView(ex.memory.buffer).getUint32(slot, true)
      return ex.ghostty_snapshot_decoder_decode(decoder, slot)
    }

    expect(decodeResult(good)).toBe(abi.GHOSTTY_SUCCESS)
    expect(decodeResult(good.slice(0, good.length - 1))).not.toBe(abi.GHOSTTY_SUCCESS)
    const flipped = good.slice()
    flipped[Math.floor(good.length / 2)] ^= 0xff
    expect(decodeResult(flipped)).not.toBe(abi.GHOSTTY_SUCCESS)
  })
})

describe('streaming a snapshot', () => {
  /** Mid-program and mid-sequence, with scrollback on both sides of it. */
  function busy() {
    const t = open(40, 6)
    for (let i = 0; i < 2000; i++) t.write(`\x1b[3${i % 8}mline ${i}\x1b[0m\r\n`)
    t.write('\x1b[?1049h\x1b[2J\x1b[Hediting\x1b[31')
    return t
  }

  it('writes the same bytes as the allocating encoder', () => {
    const t = busy()
    const { bytes, chunks } = t.streamedSnapshot()
    expect(chunks).toBeGreaterThan(1)
    expect(bytes).toEqual(t.snapshot())
  })

  it('restores from a stream, in both directions', () => {
    const t = busy()
    const r = restoreStreamed(t.streamedSnapshot().bytes)
    expectSame(t, r)
    t.write('mred\x1b[?1049l')
    r.write('mred\x1b[?1049l')
    expectSame(t, r)
    expect(r.text()).toContain('line 0\n')
  })

  it('reports a writer that gives up, and leaves the terminal working', () => {
    // Rust refusing a snapshot mustn't cost the live pane anything.
    const t = busy()
    expect(t.streamTo(() => false)).toBe(GHOSTTY_IO_ERROR)
    t.write('mstill here')
    expect(t.text()).toContain('still here')
    expect(t.streamedSnapshot().bytes.length).toBeGreaterThan(0)
  })

  it('leaves the heap about where it was, however often it runs', () => {
    // The reason to stream at all. WASM memory never shrinks, and the allocating
    // encoder grew this same terminal from 33 MB to 65 MB. Bands rather than exact
    // figures, since the heap grows in steps that belong to the core.
    const MB = 1024 * 1024
    const t = open(80, 24, { scrollbackBytes: 32 * MB })
    const chunk = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do\r\n'.repeat(1000)
    const feed = estimateScrollbackRows(32 * MB, 80) * 1.5
    for (let fed = 0; fed < feed; fed += 1000) t.write(chunk)

    const before = t.ex.memory.buffer.byteLength
    let last: Uint8Array = new Uint8Array()
    for (let i = 0; i < 5; i++) last = t.streamedSnapshot().bytes
    expect(t.ex.memory.buffer.byteLength).toBeLessThan(before * 1.15)

    const r = restoreStreamed(last)
    expect(r.ex.memory.buffer.byteLength).toBeLessThan(before * 1.15)
    expectSame(t, r)
  })
})

/** Prints what the engine integration has to plan around. Not asserted: timing
 * here says little about a phone, and heap growth steps are the core's own. */
describe.runIf(process.env.SNAPSHOT_MEASURE)('snapshot cost', () => {
  it('prints size and time by scrollback budget', () => {
    const MB = 1024 * 1024
    const rows: string[] = []
    for (const budget of [8, 32, 64, 128]) {
      const t = open(80, 24, { scrollbackBytes: budget * MB })
      const line = `${'\x1b[32m'}lorem ipsum dolor sit amet${'\x1b[0m'} consectetur adipiscing elit sed do\r\n`
      const chunk = line.repeat(1000)
      // A fixed amount past saturation. Not "until the row count settles": whole
      // pages are evicted at the cap, so it keeps moving.
      const feed = estimateScrollbackRows(budget * MB, 80) * 1.5
      for (let fed = 0; fed < feed; fed += 1000) t.write(chunk)
      const heapBefore = t.ex.memory.buffer.byteLength
      const t0 = performance.now()
      const snap = t.snapshot()
      const t1 = performance.now()
      const r = restore(snap)
      const t2 = performance.now()
      rows.push(
        `${budget} MB budget: ${t.scrollbackRows()} rows, snapshot ${(snap.length / MB).toFixed(1)} MB, ` +
          `encode ${(t1 - t0).toFixed(0)} ms, decode ${(t2 - t1).toFixed(0)} ms, heap ` +
          `${(heapBefore / MB).toFixed(0)} -> ${(t.ex.memory.buffer.byteLength / MB).toFixed(0)} MB, ` +
          `restored heap ${(r.ex.memory.buffer.byteLength / MB).toFixed(0)} MB`,
      )
    }
    console.log(rows.join('\n'))
  }, 300_000)

  it('prints the same for the streaming paths', () => {
    const MB = 1024 * 1024
    const mb = (t: Term) => (t.ex.memory.buffer.byteLength / MB).toFixed(0)
    const rows: string[] = []
    for (const budget of [8, 32, 64, 128]) {
      const t = open(80, 24, { scrollbackBytes: budget * MB })
      const line = `${'\x1b[32m'}lorem ipsum dolor sit amet${'\x1b[0m'} consectetur adipiscing elit sed do\r\n`
      const chunk = line.repeat(1000)
      const feed = estimateScrollbackRows(budget * MB, 80) * 1.5
      for (let fed = 0; fed < feed; fed += 1000) t.write(chunk)

      const before = mb(t)
      const t0 = performance.now()
      const first = t.streamedSnapshot()
      const t1 = performance.now()
      const afterFirst = mb(t)
      // Periodic snapshots are the point, so the second and later ones matter.
      for (let i = 0; i < 3; i++) t.streamedSnapshot()
      const afterMore = mb(t)
      const t2 = performance.now()
      const r = restoreStreamed(first.bytes)
      const t3 = performance.now()
      rows.push(
        `${budget} MB budget: snapshot ${(first.bytes.length / MB).toFixed(1)} MB in ${first.chunks} chunks ` +
          `(largest ${(first.largest / 1024).toFixed(0)} KB), encode ${(t1 - t0).toFixed(0)} ms, ` +
          `heap ${before} -> ${afterFirst} -> ${afterMore} MB, decode ${(t3 - t2).toFixed(0)} ms, ` +
          `restored heap ${mb(r)} MB`,
      )
    }
    console.log(rows.join('\n'))
  }, 300_000)
})
