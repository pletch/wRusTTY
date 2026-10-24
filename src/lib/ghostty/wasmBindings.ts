/**
 * Typed bindings to libghostty-vt's WASM build, as the app's ABI: the export
 * surface of the `ghostty-web` (v1.3.1) package. The vendored binary at
 * `./vendor/ghostty-vt.wasm` is a ghostty `main` build, which `main/shim.ts`
 * presents through this same interface; see vendor/README.md.
 *
 * Colors arrive pre-resolved to RGB (no palette lookup here), and cell bytes
 * 12-13 are a hyperlink id.
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
 * Attributes that don't fit in the full `flags` byte, stored in the cell's
 * former padding (still 16 bytes). `CELL_UNDERLINE` means underlined at all;
 * this says which style.
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
 * DEC private modes we query (so `is_ansi` is always false).
 */
export const MODE_APP_CURSOR_KEYS = 1 // DECCKM
export const MODE_BRACKETED_PASTE = 2004
/** Whether a full-screen program is on the alternate screen (for the pane
 *  dump). */
export const MODE_ALT_SCREEN = 1049

/**
 * DEC 1016 (SGR pixel mouse reports). Other mouse modes are read by
 * `MouseEncoder` from the terminal; this one matters here because pixel
 * reports make moves within a cell worth sending (`MouseReporter`).
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
   * Whether growing the rows may pull lines back out of scrollback (nonzero, the
   * default, allows it). `main` shim only; v1.3.1 always pulls.
   */
  ghostty_terminal_set_resize_pull_scrollback?(term: number, pull: number): void
  ghostty_terminal_write(term: number, data: number, len: number): void

  // Render state. `update` rebuilds the snapshot; call it once per frame
  // before reading.
  ghostty_render_state_update(term: number): number
  /**
   * Nonzero when this frame shouldn't be drawn: synchronized output (mode 2026)
   * is holding the screen and the captured frame was already shown. Ask every
   * frame (the hold timeout is enforced here). `main` shim only.
   */
  ghostty_render_state_is_held?(term: number): number
  /**
   * BELs (not OSC terminators) and full resets (RIS) seen since the last call,
   * then zeroed. Counted by the core's callbacks during writes. Main shim only.
   */
  ghostty_terminal_take_bells?(term: number): number
  ghostty_terminal_take_resets?(term: number): number
  /**
   * Scrollback depth when the snapshot was last rebuilt (which differs from the
   * live count during a hold). `main` shim only; fall back to the live count.
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
   * The rest of the grapheme cluster at (row, col) as u32 codepoints (the cell's
   * own codepoint is the first). `cap` is a count; returns how many were
   * written. Only call when the cell's `graphemeLen` is non-zero.
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

  // Replies (DSR and friends) the terminal owes the host
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
 * Byte layout of GhosttyTerminalConfig: 4 u32s and a 16-entry palette (the 80
 * bytes the vendored core reads), then two words read only by the `main` shim
 * (`OPT_DEFAULT_CURSOR_STYLE` / `_BLINK`). Those are stored +1 so zero means
 * "not specified".
 */
const CONFIG_CORE_BYTES = 4 * 4 + 16 * 4
const CONFIG_OFF_CURSOR_STYLE = CONFIG_CORE_BYTES
const CONFIG_OFF_CURSOR_BLINK = CONFIG_CORE_BYTES + 4
const CONFIG_BYTES = CONFIG_CORE_BYTES + 8

export interface TerminalConfig {
  /**
   * Scrollback to retain as a **byte budget**, not rows; **0 means unlimited**.
   * Go through `scrollbackBudgetBytesFor` in GhosttyEngine.
   */
  scrollbackLimit: number
  /** 0xRRGGBB. Zero means "let the core pick". */
  fgColor: number
  bgColor: number
  cursorColor: number
  /** The 16 ANSI colors as 0xRRGGBB, or omitted for the core's defaults. */
  palette?: number[]
  /**
   * The cursor a reset returns to (a `CURSOR_STYLE_*` value) and whether it
   * blinks; the core keeps it across RIS. Omitted leaves the core default (a
   * steady block). Ignored by v1.3.1.
   */
  cursorStyle?: number
  cursorBlink?: boolean
}

/** Imports for one instance; `log` decodes from that instance's own memory. */
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
 * The compiled module, shared by every pane; each pane instantiates its own
 * (separate linear memory). Instantiating is ~0.09 ms against 1.5-3 ms to
 * compile, so the larger `ReleaseFast` build costs nothing at pane open. A
 * rejected compile is evicted so one failed fetch doesn't poison later panes.
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
 * A fresh instance of an already-compiled module. A `main` build is detected
 * from its exports and wrapped in `main/shim.ts`, so the vendored binary alone
 * decides the ABI.
 */
export async function instantiateGhosttyModule(module: WebAssembly.Module): Promise<GhosttyWasm> {
  let wasmMemory: WebAssembly.Memory
  const instance = await WebAssembly.instantiate(module, ghosttyImports(() => wasmMemory))
  wasmMemory = instance.exports.memory as WebAssembly.Memory
  if (isMainBuild(instance)) return shimMainWasm(instance)
  const exports = instance.exports as unknown as GhosttyExports
  return { exports, instance }
}

/** Compile and instantiate from bytes (the bench's node harness). Panes should
 *  use `compileGhosttyWasm` + `instantiateGhosttyModule` to share the compile. */
export async function instantiateGhosttyWasm(bytes: ArrayBuffer): Promise<GhosttyWasm> {
  return instantiateGhosttyModule(await WebAssembly.compile(bytes))
}

/**
 * Create a terminal with theme colors baked in, so the core returns resolved
 * RGB.
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
  // +1, so an unset field is zero rather than a block cursor.
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

/** A zeroed cell, for use as a reusable scratch object with `parseCellInto`. */
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
 * Reads one cell into a caller-supplied object, avoiding a per-cell allocation
 * in the render loop. Returns `out`.
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

/** Allocating form, for call sites that run once rather than per cell. */
export function parseCell(view: DataView, byteOffset: number): WasmCellData {
  return parseCellInto(view, byteOffset, emptyCell())
}

/**
 * The core's allocator is out of memory. Callers should treat the engine as
 * dead and say so; returning quietly on a null pointer leaves a pane that
 * looks hung.
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

/** `allocBuffer`, but a failure throws. Prefer this wherever a null pointer
 *  would otherwise be ignored. */
export function allocBufferOrThrow(wasm: GhosttyWasm, size: number): number {
  const ptr = wasm.exports.ghostty_wasm_alloc_u8_array(size)
  if (ptr === 0) throw new GhosttyOutOfMemoryError(size)
  return ptr
}

export function freeBuffer(wasm: GhosttyWasm, ptr: number, size: number): void {
  wasm.exports.ghostty_wasm_free_u8_array(ptr, size)
}

/**
 * Write raw bytes into the terminal. Callers must write synchronously and in
 * order: the parser is one state machine fed in byte order.
 */
export function writeBytes(wasm: GhosttyWasm, termPtr: number, data: Uint8Array): void {
  if (data.length === 0) return
  // A null terminal would accept and silently drop the bytes (desyncing the
  // parser, and reading as an impossibly fast parse in benchmarks).
  if (termPtr === 0) throw new Error('Ghostty write to a terminal that does not exist (termPtr is 0).')
  // Sub-phase timing, to tell the buffer handoff from the core's parse.
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
  // Throw on allocation failure: a dropped write desyncs the parser.
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
