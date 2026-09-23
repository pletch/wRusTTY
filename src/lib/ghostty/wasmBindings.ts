/**
 * Typed bindings to libghostty-vt's WASM build. The binary itself is a
 * locally-built one vendored at `./vendor/ghostty-vt.wasm` rather than
 * resolved from node_modules — see that directory's README for why and how
 * to rebuild it. The export surface (this file) still matches the
 * `ghostty-web` package pinned in package.json byte-for-byte; only the
 * implementation behind a handful of exports differs.
 *
 * This replaced a hand-built binary with a bespoke 23-export wrapper. That
 * build predated upstream's "clear scrolled row cells" fix, so a row scrolled
 * into view kept the cell memory of a previously erased row: new text landed
 * on stale attributes and inherited the *old* row's colors, which is why
 * uncoloured `ls -l` output came out wearing dmesg's palette.
 *
 * Two ABI differences from that wrapper are load-bearing here:
 *   - Colors arrive **pre-resolved to RGB**. There is no "has explicit color"
 *     flag and no palette lookup left to do on this side; a cell's fg/bg is
 *     simply what should be drawn.
 *   - Cell bytes 12-13 are a hyperlink id, not color flags.
 */

import * as phases from '../writePhases'
import { isMainBuild, shimMainWasm } from './main/shim'

/** Cell flags, matching GHOSTTY_CELL_* in the upstream header. */
export const CELL_BOLD = 1 << 0
export const CELL_ITALIC = 1 << 1
export const CELL_UNDERLINE = 1 << 2
export const CELL_STRIKETHROUGH = 1 << 3
export const CELL_INVERSE = 1 << 4
export const CELL_INVISIBLE = 1 << 5
export const CELL_BLINK = 1 << 6
export const CELL_FAINT = 1 << 7

/**
 * Attributes that did not fit in the cell's `flags` byte, which is full.
 *
 * They live in what used to be the struct's padding, so the cell is still 16
 * bytes and nothing sized against `CELL_BYTES` changed. `CELL_UNDERLINE` above
 * still means "underlined at all" — this only says *which* underline.
 */
export const CELL2_UNDERLINE_MASK = 0x07
export const CELL2_OVERLINE = 1 << 3

/** Underline styles, matching `sgr.Attribute.Underline` in the core. */
export const UNDERLINE_NONE = 0
export const UNDERLINE_SINGLE = 1
export const UNDERLINE_DOUBLE = 2
export const UNDERLINE_CURLY = 3
export const UNDERLINE_DOTTED = 4
export const UNDERLINE_DASHED = 5

/** Cursor shapes reported by `ghostty_render_state_get_cursor_style` (DECSCUSR). */
export const CURSOR_STYLE_BLOCK = 0
export const CURSOR_STYLE_BAR = 1
export const CURSOR_STYLE_UNDERLINE = 2
export const CURSOR_STYLE_BLOCK_HOLLOW = 3

/**
 * DEC private modes we query. `ghostty_terminal_get_mode` takes an
 * `is_ansi` flag; both of these are private modes, so it is always false.
 */
export const MODE_APP_CURSOR_KEYS = 1 // DECCKM
export const MODE_BRACKETED_PASTE = 2004
/** Whether a full-screen program is on the alternate screen. Read only by the
 *  pane dump, where "was this a TUI repainting in place" is the first question
 *  asked of a grid that came out wrong. */
export const MODE_ALT_SCREEN = 1049

/**
 * Mouse reporting. `ghostty_terminal_has_mouse_tracking` answers "is anything
 * being reported at all", which is the cheap gate for deciding between
 * reporting and selecting.
 *
 * There used to be three more constants here — 1002, 1003 and 1006 — because
 * this app decided for itself which events to report and in which format.
 * `MouseEncoder` reads all of that from the terminal now, so the modes are no
 * longer anyone's business out here.
 *
 * DEC 1016 is the exception, and only because it changes how *often* a report
 * is worth sending rather than what one says: it carries pixel coordinates,
 * so a move within a single cell — which says nothing new under every other
 * format, and which `MouseReporter` therefore drops — is the whole point.
 */
export const MODE_MOUSE_SGR_PIXELS = 1016

/** DEC 1004: report CSI I / CSI O when the terminal gains or loses focus. */
export const MODE_FOCUS_REPORTING = 1004

export interface GhosttyExports {
  memory: WebAssembly.Memory

  // Lifecycle
  ghostty_terminal_new(cols: number, rows: number): number
  ghostty_terminal_new_with_config(cols: number, rows: number, config: number): number
  ghostty_terminal_free(term: number): void
  ghostty_terminal_resize(term: number, cols: number, rows: number): void
  /**
   * Whether growing the rows may pull lines back out of scrollback; nonzero
   * allows it, which is also the default. Only the `main` shim provides this —
   * the v1.3.1 build always pulls, and has no way to be told otherwise.
   */
  ghostty_terminal_set_resize_pull_scrollback?(term: number, pull: number): void
  ghostty_terminal_write(term: number, data: number, len: number): void

  // Render state. `update` rebuilds the snapshot and must be called once per
  // frame before reading the viewport.
  ghostty_render_state_update(term: number): number
  /**
   * Nonzero when this frame should not be drawn: the program is holding the
   * screen with synchronized output (mode 2026) and the frame captured when
   * the hold began has already been shown. Keep the redraw pending and ask
   * again next frame. Also where a hold past its timeout is ended, so it needs
   * asking every frame for the timeout to be real. Only the `main` shim
   * provides it; the v1.3.1 build draws through mode 2026 regardless.
   */
  ghostty_render_state_is_held?(term: number): number
  /**
   * Scrollback depth when the render snapshot was last actually rebuilt. The
   * live `terminal_get_scrollback_length` only agrees with the snapshot right
   * after an update that did rebuild it, and during a hold `update` does not.
   * `main` shim only; fall back to the live count without it.
   */
  ghostty_render_state_get_scrollback_length?(term: number): number
  ghostty_render_state_get_cols(term: number): number
  ghostty_render_state_get_rows(term: number): number
  ghostty_render_state_get_cursor_x(term: number): number
  ghostty_render_state_get_cursor_y(term: number): number
  ghostty_render_state_get_cursor_visible(term: number): number
  ghostty_render_state_get_bg_color(term: number): number
  ghostty_render_state_get_fg_color(term: number): number
  ghostty_render_state_is_row_dirty(term: number, y: number): number
  ghostty_render_state_mark_clean(term: number): void
  /** `cells` is a cell count, not a byte count. Returns cells written, or -1. */
  ghostty_render_state_get_viewport(term: number, out: number, cells: number): number
  /**
   * Every codepoint of the grapheme cluster at (row, col), written as u32s.
   * `cap` is a codepoint count; returns how many were written. Only worth
   * calling when the cell's `graphemeLen` is non-zero — a cell's own codepoint
   * is the first of the cluster, and this is the rest of it.
   */
  ghostty_render_state_get_grapheme(term: number, row: number, col: number, out: number, cap: number): number

  // Terminal state
  ghostty_terminal_is_alternate_screen(term: number): number
  ghostty_terminal_has_mouse_tracking(term: number): number
  ghostty_terminal_get_mode(term: number, mode: number, isAnsi: number): number
  ghostty_terminal_is_row_wrapped(term: number, y: number): number
  /** Same question for a scrollback row; offset 0 is the oldest. */
  ghostty_terminal_is_scrollback_row_wrapped(term: number, offset: number): number
  /** DECSCUSR shape as a CURSOR_STYLE_* value. */
  ghostty_render_state_get_cursor_style(term: number): number
  /** Whether DECSCUSR asked for a blinking cursor (DEC mode 12). */
  ghostty_render_state_get_cursor_blinking(term: number): number

  // Scrollback
  ghostty_terminal_get_scrollback_length(term: number): number
  ghostty_terminal_get_scrollback_line(term: number, offset: number, out: number, cells: number): number
  /** As `ghostty_render_state_get_grapheme`, for a row in scrollback. */
  ghostty_terminal_get_scrollback_grapheme(term: number, offset: number, col: number, out: number, cap: number): number

  // Responses (DSR and friends) the terminal wants sent back to the host
  ghostty_terminal_has_response(term: number): number
  ghostty_terminal_read_response(term: number, out: number, len: number): number

  // Memory
  ghostty_wasm_alloc_u8_array(len: number): number
  ghostty_wasm_free_u8_array(ptr: number, len: number): void
}

export interface GhosttyWasm {
  exports: GhosttyExports
  instance: WebAssembly.Instance
}

export const CELL_BYTES = 16

/**
 * Byte layout of GhosttyTerminalConfig: 4 u32s, a 16-entry palette, then two
 * words the **vendored core does not read**.
 *
 * The core takes a fixed 80-byte struct by pointer and ignores anything past
 * it, which is what makes appending safe: the tail is for whoever is behind
 * `GhosttyExports`, and on ghostty `main` it becomes
 * `OPT_DEFAULT_CURSOR_STYLE` / `OPT_DEFAULT_CURSOR_BLINK` — the pair that hold
 * the configured cursor across a RIS. Each is stored **+1 so that zero means
 * "not specified"**, since every cursor style including block is a valid 0.
 */
const CONFIG_CORE_BYTES = 4 * 4 + 16 * 4
const CONFIG_OFF_CURSOR_STYLE = CONFIG_CORE_BYTES
const CONFIG_OFF_CURSOR_BLINK = CONFIG_CORE_BYTES + 4
const CONFIG_BYTES = CONFIG_CORE_BYTES + 8

export interface TerminalConfig {
  /**
   * Scrollback to retain, as a **byte budget** — not a row count, despite the
   * name. It reaches upstream Ghostty's `PageList` as `max_size`. A row-shaped
   * value sits under the core's minimum page and silently retains ~two pages
   * whatever the setting says; **0 means unlimited**. Always go through
   * `scrollbackBudgetBytesFor` in GhosttyEngine, which documents the measurement and
   * guarantees a positive integer inside u32.
   */
  scrollbackLimit: number
  /** 0xRRGGBB. Zero means "let the core pick". */
  fgColor: number
  bgColor: number
  cursorColor: number
  /** The 16 ANSI colors as 0xRRGGBB, or omitted for the core's defaults. */
  palette?: number[]
  /**
   * The cursor a reset returns to, as a `CURSOR_STYLE_*` value, and whether it
   * blinks. Omitted leaves the core's own default (a steady block).
   *
   * These replaced `last_reset_seq` / `last_cursor_style_seq`, the tick pair
   * the host used to compare to decide whether a RIS had discarded the
   * preference. The core now simply keeps it, so there is nothing to decide.
   * The v1.3.1 build reads neither field and ignores them harmlessly.
   */
  cursorStyle?: number
  cursorBlink?: boolean
}

/** Imports for one instance. Built per instance rather than shared: `log` has
 *  to decode out of *that* instance's linear memory, and every instance has
 *  its own. */
function ghosttyImports(memoryOf: () => WebAssembly.Memory) {
  return {
    env: {
      log(ptr: number, len: number) {
        const text = new TextDecoder().decode(new Uint8Array(memoryOf().buffer, ptr, len))
        console.log('[ghostty-vt]', text)
      },
    },
  }
}

/**
 * The compiled module, shared by every pane.
 *
 * Compiling is the expensive half and it produces the same artifact every
 * time, but a `WebAssembly.Instance` cannot be shared — each pane needs its
 * own linear memory, which is the whole point of one instance per pane. So the
 * module is compiled once and instantiated per pane. Measured, that is 0.087 ms
 * per pane against 1.5-3 ms to compile and instantiate from bytes each time,
 * and the gap widens with the size of the binary: it is what makes the
 * `ReleaseFast` build (3 MB, ~12% faster parse) cost nothing at pane open.
 *
 * A rejected compile is evicted rather than cached, so one failed fetch does
 * not permanently poison every pane opened afterwards.
 */
let compiling: Promise<WebAssembly.Module> | null = null

export function compileGhosttyWasm(url: string): Promise<WebAssembly.Module> {
  if (compiling) return compiling
  const started = (async () => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`fetching ${url} returned HTTP ${response.status}`)
    return WebAssembly.compile(await response.arrayBuffer())
  })()
  compiling = started
  started.catch(() => {
    if (compiling === started) compiling = null
  })
  return started
}

/**
 * A fresh instance — its own memory, its own terminal state — of an
 * already-compiled module.
 *
 * A build at ghostty `main` speaks a different ABI and is wrapped in
 * `main/shim.ts`, which presents this exact interface over it. The choice is
 * made from the binary's own export list rather than from a build flag, so the
 * two can never fall out of step: whichever `.wasm` is vendored is the one that
 * decides, and swapping it is the whole of the switch.
 */
export async function instantiateGhosttyModule(module: WebAssembly.Module): Promise<GhosttyWasm> {
  let wasmMemory: WebAssembly.Memory
  const instance = await WebAssembly.instantiate(module, ghosttyImports(() => wasmMemory))
  wasmMemory = instance.exports.memory as WebAssembly.Memory
  if (isMainBuild(instance)) return shimMainWasm(instance)
  const exports = instance.exports as unknown as GhosttyExports
  return { exports, instance }
}

/** Compile-and-instantiate in one step, for callers holding bytes rather than
 *  a URL (the bench's node-side snapshot harness). Panes should go through
 *  `compileGhosttyWasm` + `instantiateGhosttyModule` so they share the compile. */
export async function instantiateGhosttyWasm(bytes: ArrayBuffer): Promise<GhosttyWasm> {
  return instantiateGhosttyModule(await WebAssembly.compile(bytes))
}

/**
 * Create a terminal with theme colors baked in. Passing the palette here is
 * what lets the core hand back pre-resolved RGB, so the renderer never has to
 * know what "color 4" means.
 */
export function createTerminal(
  wasm: GhosttyWasm,
  cols: number,
  rows: number,
  config: TerminalConfig,
): number {
  const ptr = wasm.exports.ghostty_wasm_alloc_u8_array(CONFIG_BYTES)
  if (ptr === 0) return 0
  const view = new DataView(wasm.exports.memory.buffer, ptr, CONFIG_BYTES)
  view.setUint32(0, config.scrollbackLimit, true)
  view.setUint32(4, config.fgColor, true)
  view.setUint32(8, config.bgColor, true)
  view.setUint32(12, config.cursorColor, true)
  for (let i = 0; i < 16; i++) {
    view.setUint32(16 + i * 4, config.palette?.[i] ?? 0, true)
  }
  // +1, so that an unset field is a zero rather than a block cursor.
  view.setUint32(CONFIG_OFF_CURSOR_STYLE, config.cursorStyle === undefined ? 0 : config.cursorStyle + 1, true)
  view.setUint32(CONFIG_OFF_CURSOR_BLINK, config.cursorBlink === undefined ? 0 : (config.cursorBlink ? 2 : 1), true)
  const term = wasm.exports.ghostty_terminal_new_with_config(cols, rows, ptr)
  wasm.exports.ghostty_wasm_free_u8_array(ptr, CONFIG_BYTES)
  return term
}

/** A cell as the renderer consumes it — colors already resolved to RGB. */
export interface WasmCellData {
  codepoint: number
  fgR: number
  fgG: number
  fgB: number
  bgR: number
  bgG: number
  bgB: number
  flags: number
  width: number
  hyperlinkId: number
  /** Extra codepoints beyond the first; 0 for an ordinary cell. */
  graphemeLen: number
  /** Underline style and overline; see CELL2_*. */
  attrs2: number
}

/** A zeroed cell, for use as a caller-owned scratch object with
 * `parseCellInto`. Every field is overwritten on each parse, so the initial
 * values only matter to the type. */
export function emptyCell(): WasmCellData {
  return {
    codepoint: 0,
    fgR: 0, fgG: 0, fgB: 0,
    bgR: 0, bgG: 0, bgB: 0,
    flags: 0,
    width: 0,
    hyperlinkId: 0,
    graphemeLen: 0,
    attrs2: 0,
  }
}

/**
 * Reads one cell into a caller-supplied object rather than returning a fresh
 * one. The render loop destructures the result into locals immediately and
 * never holds onto it, so a per-cell object was pure garbage — at 200x60 and
 * 60fps, ~720k allocations a second that V8 may or may not scalar-replace
 * depending on whether this inlines. Handing in one long-lived object takes
 * the question off the table.
 *
 * Returns `out` so it can still be used as an expression.
 */
export function parseCellInto(view: DataView, byteOffset: number, out: WasmCellData): WasmCellData {
  out.codepoint = view.getUint32(byteOffset, true)
  out.fgR = view.getUint8(byteOffset + 4)
  out.fgG = view.getUint8(byteOffset + 5)
  out.fgB = view.getUint8(byteOffset + 6)
  out.bgR = view.getUint8(byteOffset + 7)
  out.bgG = view.getUint8(byteOffset + 8)
  out.bgB = view.getUint8(byteOffset + 9)
  out.flags = view.getUint8(byteOffset + 10)
  out.width = view.getUint8(byteOffset + 11)
  out.hyperlinkId = view.getUint16(byteOffset + 12, true)
  out.graphemeLen = view.getUint8(byteOffset + 14)
  out.attrs2 = view.getUint8(byteOffset + 15)
  return out
}

/** Allocating form, for the handful of call sites that genuinely want their
 * own object (or run once, not per cell per frame). Hot loops should own a
 * scratch cell and call `parseCellInto`. */
export function parseCell(view: DataView, byteOffset: number): WasmCellData {
  return parseCellInto(view, byteOffset, emptyCell())
}

/**
 * The core's allocator is out of memory.
 *
 * Distinguished from an ordinary error because it is the one failure every
 * caller here used to swallow: `ghostty_wasm_alloc_u8_array` reports failure by
 * returning a null pointer, and each call site simply returned on it. A pane
 * whose writes and repaints have both quietly become no-ops is indistinguishable
 * from a hung terminal — no error, no blank screen, no clue. Whoever catches
 * this should treat the engine as dead and say so.
 */
export class GhosttyOutOfMemoryError extends Error {
  constructor(bytes: number) {
    super(`Ghostty's WASM core could not allocate ${bytes} bytes.`)
    this.name = 'GhosttyOutOfMemoryError'
  }
}

export function allocBuffer(wasm: GhosttyWasm, size: number): number {
  return wasm.exports.ghostty_wasm_alloc_u8_array(size)
}

/** `allocBuffer`, but a failure is raised instead of returned. Prefer this
 *  anywhere a null pointer would otherwise be handled by doing nothing. */
export function allocBufferOrThrow(wasm: GhosttyWasm, size: number): number {
  const ptr = wasm.exports.ghostty_wasm_alloc_u8_array(size)
  if (ptr === 0) throw new GhosttyOutOfMemoryError(size)
  return ptr
}

export function freeBuffer(wasm: GhosttyWasm, ptr: number, size: number): void {
  wasm.exports.ghostty_wasm_free_u8_array(ptr, size)
}

/**
 * Write raw bytes into the terminal. The parser is one state machine fed in
 * byte order, so every caller has to reach it synchronously and in order —
 * deferring a write by even a microtask replays the stream out of sequence and
 * strands SGR state on the wrong output.
 */
export function writeBytes(wasm: GhosttyWasm, termPtr: number, data: Uint8Array): void {
  if (data.length === 0) return
  // A null terminal accepts every byte and parses none: the core null-checks
  // and returns, so the write "succeeds", the bytes vanish, and a benchmark
  // reports the resulting nothing as a very fast parse. That is how the
  // flood-stress rows came to claim 13,000 MB/s. Same rule as a failed
  // allocation — refuse loudly rather than silently drop a write, because a
  // dropped write desynchronises the parser from the stream regardless.
  if (termPtr === 0) throw new Error('Ghostty write to a terminal that does not exist (termPtr is 0).')
  // Sub-phases of the single most expensive thing the app does. The parse cost
  // measured invariant to content shape, grid width and scrollback depth —
  // none of which the buffer handoff touches — so the handoff has to be
  // measured before the core can be blamed for it.
  if (phases.isEnabled()) {
    const bufPtr = phases.time('alloc', () => allocBufferOrThrow(wasm, data.length))
    phases.time('copy', () =>
      new Uint8Array(wasm.exports.memory.buffer, bufPtr, data.length).set(data),
    )
    phases.time('coreWrite', () =>
      wasm.exports.ghostty_terminal_write(termPtr, bufPtr, data.length),
    )
    phases.time('free', () => freeBuffer(wasm, bufPtr, data.length))
    return
  }
  // Throws rather than returning on a failed allocation: silently dropping a
  // write desynchronises the parser's state machine from the byte stream for
  // the rest of the session, which is worse than stopping.
  const bufPtr = allocBufferOrThrow(wasm, data.length)
  new Uint8Array(wasm.exports.memory.buffer, bufPtr, data.length).set(data)
  wasm.exports.ghostty_terminal_write(termPtr, bufPtr, data.length)
  freeBuffer(wasm, bufPtr, data.length)
}

export function writeString(wasm: GhosttyWasm, termPtr: number, str: string): void {
  writeBytes(wasm, termPtr, new TextEncoder().encode(str))
}

/** Drain any DSR-style replies the terminal owes the host. */
export function readResponse(wasm: GhosttyWasm, termPtr: number): Uint8Array | null {
  if (!wasm.exports.ghostty_terminal_has_response(termPtr)) return null
  const cap = 256
  const ptr = allocBufferOrThrow(wasm, cap)
  const n = wasm.exports.ghostty_terminal_read_response(termPtr, ptr, cap)
  const out = n > 0 ? new Uint8Array(wasm.exports.memory.buffer, ptr, n).slice() : null
  freeBuffer(wasm, ptr, cap)
  return out
}
