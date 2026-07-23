/**
 * Typed bindings to libghostty-vt's WASM build, as shipped by the
 * `ghostty-web` package (pinned exactly in package.json — the binary is
 * resolved from node_modules rather than vendored, so the version in the
 * lockfile is the version that runs).
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
 * DEC private modes we query. `ghostty_terminal_get_mode` takes an
 * `is_ansi` flag; both of these are private modes, so it is always false.
 */
export const MODE_APP_CURSOR_KEYS = 1 // DECCKM
export const MODE_BRACKETED_PASTE = 2004

export interface GhosttyExports {
  memory: WebAssembly.Memory

  // Lifecycle
  ghostty_terminal_new(cols: number, rows: number): number
  ghostty_terminal_new_with_config(cols: number, rows: number, config: number): number
  ghostty_terminal_free(term: number): void
  ghostty_terminal_resize(term: number, cols: number, rows: number): void
  ghostty_terminal_write(term: number, data: number, len: number): void

  // Render state. `update` rebuilds the snapshot and must be called once per
  // frame before reading the viewport.
  ghostty_render_state_update(term: number): number
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

  // Terminal state
  ghostty_terminal_is_alternate_screen(term: number): number
  ghostty_terminal_has_mouse_tracking(term: number): number
  ghostty_terminal_get_mode(term: number, mode: number, isAnsi: number): number
  ghostty_terminal_is_row_wrapped(term: number, y: number): number

  // Scrollback
  ghostty_terminal_get_scrollback_length(term: number): number
  ghostty_terminal_get_scrollback_line(term: number, offset: number, out: number, cells: number): number

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

/** Byte layout of GhosttyTerminalConfig: 4 u32s then a 16-entry palette. */
const CONFIG_BYTES = 4 * 4 + 16 * 4

export interface TerminalConfig {
  scrollbackLimit: number
  /** 0xRRGGBB. Zero means "let the core pick". */
  fgColor: number
  bgColor: number
  cursorColor: number
  /** The 16 ANSI colors as 0xRRGGBB, or omitted for the core's defaults. */
  palette?: number[]
}

export async function instantiateGhosttyWasm(bytes: ArrayBuffer): Promise<GhosttyWasm> {
  let wasmMemory: WebAssembly.Memory

  const { instance } = await WebAssembly.instantiate(bytes, {
    env: {
      log(ptr: number, len: number) {
        const text = new TextDecoder().decode(new Uint8Array(wasmMemory.buffer, ptr, len))
        console.log('[ghostty-vt]', text)
      },
    },
  })

  wasmMemory = instance.exports.memory as WebAssembly.Memory
  const exports = instance.exports as unknown as GhosttyExports
  return { exports, instance }
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
}

export function parseCell(view: DataView, byteOffset: number): WasmCellData {
  return {
    codepoint: view.getUint32(byteOffset, true),
    fgR: view.getUint8(byteOffset + 4),
    fgG: view.getUint8(byteOffset + 5),
    fgB: view.getUint8(byteOffset + 6),
    bgR: view.getUint8(byteOffset + 7),
    bgG: view.getUint8(byteOffset + 8),
    bgB: view.getUint8(byteOffset + 9),
    flags: view.getUint8(byteOffset + 10),
    width: view.getUint8(byteOffset + 11),
    hyperlinkId: view.getUint16(byteOffset + 12, true),
    graphemeLen: view.getUint8(byteOffset + 14),
  }
}

export function allocBuffer(wasm: GhosttyWasm, size: number): number {
  return wasm.exports.ghostty_wasm_alloc_u8_array(size)
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
  const bufPtr = allocBuffer(wasm, data.length)
  if (bufPtr === 0) return
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
  const ptr = allocBuffer(wasm, cap)
  if (ptr === 0) return null
  const n = wasm.exports.ghostty_terminal_read_response(termPtr, ptr, cap)
  const out = n > 0 ? new Uint8Array(wasm.exports.memory.buffer, ptr, n).slice() : null
  freeBuffer(wasm, ptr, cap)
  return out
}
