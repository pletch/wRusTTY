/**
 * Our original export ABI (`GhosttyExports`), implemented over ghostty
 * `main`, so the app's call sites didn't have to move with the binary. The
 * readers it composes are each tested byte-identical to the export they
 * replace (`ViewportReader.test.ts`, `ScrollbackReader.test.ts`,
 * `effects.test.ts`). The shim handles the bookkeeping our ABI hides:
 *
 * - **Render state is a separate object** on `main`, so each terminal maps to
 *   its own.
 * - **Update and read are ours to order**: `render_state_update` runs once a
 *   frame, and `readRows` reads that snapshot without updating.
 * - **Replies are a callback**, buffered by `MainEffects` and handed back through
 *   `has_response`/`read_response`.
 * - **Synchronized output is a callback** that must snapshot at the byte where
 *   the hold begins; see `RenderHold`.
 * - **Cursor styles are renumbered** (ours: block=0, bar=1; main: bar=0,
 *   block=1).
 *
 * `last_reset_seq`/`last_cursor_style_seq` aren't carried: `main` keeps the
 * default cursor across RIS (`OPT_DEFAULT_CURSOR_STYLE`/`_BLINK`, fed by
 * `TerminalConfig.cursorStyle`). A preference changed mid-session doesn't
 * update the reset default, though `setCursorStyle` still fixes the live
 * cursor. `hyperlinkId` is always 0; see `ViewportReader`.
 */
import * as abi from './abi'
import { MainViewportReader } from './ViewportReader'
import { MainScrollbackReader, SPACE_ACTIVE, SPACE_SCREEN } from './ScrollbackReader'
import { MainEffects } from './effects'
import {
  CURSOR_STYLE_BLOCK,
  CURSOR_STYLE_BAR,
  CURSOR_STYLE_UNDERLINE,
  CURSOR_STYLE_BLOCK_HOLLOW,
  type GhosttyExports,
  type GhosttyWasm,
} from '../wasmBindings'

/** `GhosttyTerminalConfig` as `createTerminal` packs it: 4 u32s then 16
 *  palette entries. */
const CONFIG_OFF_SCROLLBACK = 0
const CONFIG_OFF_FG = 4
const CONFIG_OFF_BG = 8
const CONFIG_OFF_CURSOR = 12
const CONFIG_OFF_PALETTE = 16
const CONFIG_PALETTE_ENTRIES = 16
/** Past the struct the vendored core reads; see `TerminalConfig`. Stored +1,
 *  so zero means "not specified". */
const CONFIG_OFF_CURSOR_STYLE = 80
const CONFIG_OFF_CURSOR_BLINK = 84

/**
 * Scrollback for a terminal created without a config. `main`'s own default is
 * 10,000 bytes (about 370 rows at 200 columns); our ABI and tests assume
 * thousands.
 */
const DEFAULT_SCROLLBACK_BYTES = 1024 * 1024

/**
 * `scrollbackLimit: 0` means unlimited in our ABI; `main` has no sentinel, so
 * use the largest wasm32 `size_t`.
 */
const UNLIMITED_SCROLLBACK_BYTES = 0xffffffff

/**
 * main's `GhosttyRenderStateCursorVisualStyle` onto our `CURSOR_STYLE_*`. A
 * function rather than a module-scope table: `wasmBindings` imports this
 * module, and a table built during that cycle would hit the temporal dead zone.
 */
function cursorStyleForMain(style: number): number {
  switch (style) {
    case abi.RS_CURSOR_BAR:
      return CURSOR_STYLE_BAR
    case abi.RS_CURSOR_UNDERLINE:
      return CURSOR_STYLE_UNDERLINE
    case abi.RS_CURSOR_BLOCK_HOLLOW:
      return CURSOR_STYLE_BLOCK_HOLLOW
    default:
      return CURSOR_STYLE_BLOCK
  }
}

/**
 * The reverse mapping, for `OPT_DEFAULT_CURSOR_STYLE` (which numbers the same
 * as the visual style enum).
 */
function mainCursorStyleFor(ours: number): number {
  switch (ours) {
    case CURSOR_STYLE_BAR:
      return abi.RS_CURSOR_BAR
    case CURSOR_STYLE_UNDERLINE:
      return abi.RS_CURSOR_UNDERLINE
    case CURSOR_STYLE_BLOCK_HOLLOW:
      return abi.RS_CURSOR_BLOCK_HOLLOW
    default:
      return abi.RS_CURSOR_BLOCK
  }
}

type MainExports = abi.GhosttyMainExports & { __indirect_function_table?: WebAssembly.Table }

/** Everything one terminal needs on the far side of the boundary. */
interface TerminalState {
  reader: MainViewportReader
  scrollback: MainScrollbackReader
  effects: MainEffects
  /** Replies taken from the callback and not yet read by the host. */
  pending: Uint8Array[]
  /** Created lazily; nothing in the app asks for row dirtiness. */
  dirtyIter: number
  /**
   * Whether this frame's `RS_DATA_CURSOR` / `RS_DATA_COLORS` have been read.
   * Cleared by `render_state_update`; see `snapshotCursor`.
   */
  cursorRead: boolean
  colorsRead: boolean
  /** Scrollback depth when the render snapshot was last actually rebuilt. */
  snapshotScrollback: number
  hold: RenderHold
}

/**
 * Synchronized output (mode 2026). The core calls back at the byte where a
 * program starts a multi-step redraw; the snapshot taken there (the last
 * complete frame) is kept until the program ends the hold, so a redraw split
 * across chunks is never drawn half-finished.
 */
interface RenderHold {
  active: boolean
  /** `performance.now()` when the hold began, for the timeout. */
  since: number
  /**
   * The captured frame hasn't been drawn yet. A hold can start mid-write, so the
   * first frame inside it still draws, from the capture.
   */
  fresh: boolean
}

/**
 * The longest a program may freeze the screen. The core never ends a hold
 * itself, so a program that dies mid-hold would freeze the pane. One second,
 * as upstream suggests and other terminals use.
 */
export const RENDER_HOLD_TIMEOUT_MS = 1000

class MainShim {
  private readonly ex: MainExports
  private readonly terms = new Map<number, TerminalState>()
  private readonly scratch: number
  private readonly slot: number
  private readonly palette: number
  private readonly cursorBuf: number
  private readonly colorsBuf: number
  private view: DataView

  constructor(ex: MainExports) {
    this.ex = ex
    this.view = new DataView(ex.memory.buffer)
    this.scratch = ex.ghostty_wasm_alloc(16)
    this.slot = ex.ghostty_wasm_alloc_opaque()
    this.palette = ex.ghostty_wasm_alloc(abi.PALETTE_BYTES)
    // Separate buffers for the larger structs (colors carries the palette).
    this.cursorBuf = ex.ghostty_wasm_alloc(abi.RS_CURSOR_SIZE)
    this.colorsBuf = ex.ghostty_wasm_alloc(abi.RS_COLORS_SIZE)
  }

  /** Re-created only when memory growth detached the previous one. */
  private dv(): DataView {
    if (this.view.buffer !== this.ex.memory.buffer) this.view = new DataView(this.ex.memory.buffer)
    return this.view
  }

  private state(term: number): TerminalState | undefined {
    return this.terms.get(term)
  }

  /* ---------------------------------------------------------------- reads */

  /** `render_state_get` into the scratch; false on any non-success. */
  private rsGet(term: number, key: number): boolean {
    const st = this.state(term)
    if (!st) return false
    return this.ex.ghostty_render_state_get(st.reader.state, key, this.scratch) === abi.GHOSTTY_SUCCESS
  }

  private tGet(term: number, key: number): boolean {
    return this.ex.ghostty_terminal_get(term, key, this.scratch) === abi.GHOSTTY_SUCCESS
  }

  /** Dimensions and cursor coordinates are `uint16_t`, not words. */
  private rsU16(term: number, key: number): number {
    return this.rsGet(term, key) ? this.dv().getUint16(this.scratch, true) : 0
  }

  /**
   * Reads `RS_DATA_CURSOR` once per frame into `cursorBuf`, serving our ABI's
   * per-field cursor getters from it. Safe because only `render_state_update`
   * changes the snapshot (and clears the flag); `readRows` reads mid-frame and
   * must see the same cursor as its cells.
   */
  private snapshotCursor(term: number): boolean {
    const st = this.state(term)
    if (!st) return false
    if (!st.cursorRead) {
      // Sized struct: write its size first.
      this.dv().setUint32(this.cursorBuf + abi.RS_CURSOR_OFF_SIZE, abi.RS_CURSOR_SIZE, true)
      if (
        this.ex.ghostty_render_state_get(st.reader.state, abi.RS_DATA_CURSOR, this.cursorBuf) !==
        abi.GHOSTTY_SUCCESS
      ) {
        return false
      }
      st.cursorRead = true
    }
    return true
  }

  /** The same, for `RS_DATA_COLORS`. */
  private snapshotColors(term: number): boolean {
    const st = this.state(term)
    if (!st) return false
    if (!st.colorsRead) {
      this.dv().setUint32(this.colorsBuf + abi.RS_COLORS_OFF_SIZE, abi.RS_COLORS_SIZE, true)
      if (
        this.ex.ghostty_render_state_get(st.reader.state, abi.RS_DATA_COLORS, this.colorsBuf) !==
        abi.GHOSTTY_SUCCESS
      ) {
        return false
      }
      st.colorsRead = true
    }
    return true
  }

  /**
   * Whether `viewport_x`/`_y` are defined (they aren't for a cursor scrolled out
   * of view).
   */
  private cursorHasPosition(): boolean {
    return this.dv().getUint8(this.cursorBuf + abi.RS_CURSOR_OFF_VIEWPORT_HAS_VALUE) !== 0
  }

  /** Three packed bytes at `off` in a snapshot buffer, as 0xRRGGBB. */
  private rgbAt(base: number, off: number): number {
    const d = this.dv()
    return (d.getUint8(base + off) << 16) | (d.getUint8(base + off + 1) << 8) | d.getUint8(base + off + 2)
  }

  /* --------------------------------------------------------------- writes */

  /** A `size_t` option. Every `set` takes a pointer *at* the value. */
  private setUsize(term: number, option: number, value: number): number {
    this.dv().setUint32(this.scratch, value, true)
    return this.ex.ghostty_terminal_set(term, option, this.scratch)
  }

  /** A `GhosttyColorRgb` option: three packed bytes, no padding. */
  private setColor(term: number, option: number, rgb: number): number {
    const d = this.dv()
    d.setUint8(this.scratch, (rgb >> 16) & 0xff)
    d.setUint8(this.scratch + 1, (rgb >> 8) & 0xff)
    d.setUint8(this.scratch + 2, rgb & 0xff)
    return this.ex.ghostty_terminal_set(term, option, this.scratch)
  }

  /* ---------------------------------------------------------- lifecycle */

  newTerminal(cols: number, rows: number, configPtr = 0): number {
    const { ex } = this
    if (ex.ghostty_terminal_new(0, this.slot, cols, rows) !== abi.GHOSTTY_SUCCESS) return 0
    const term = this.dv().getUint32(this.slot, true)
    if (term === 0) return 0

    if (configPtr !== 0) this.applyConfig(term, configPtr)
    else this.setUsize(term, abi.T_OPT_SCROLLBACK_MAX_BYTES, DEFAULT_SCROLLBACK_BYTES)

    this.terms.set(term, {
      reader: new MainViewportReader({ ex, term }),
      scrollback: new MainScrollbackReader({ ex, term }),
      // Installed before any byte is written: `vt_write` ignores queries until
      // then.
      effects: new MainEffects({ ex, term, onRenderHold: (held) => this.onRenderHold(term, held) }),
      pending: [],
      dirtyIter: 0,
      cursorRead: false,
      colorsRead: false,
      snapshotScrollback: 0,
      hold: { active: false, since: 0, fresh: false },
    })
    return term
  }

  /**
   * Applies our packed `GhosttyTerminalConfig` as individual `set` calls (`main`
   * has no constructor options).
   */
  private applyConfig(term: number, ptr: number): void {
    const d = this.dv()
    const budget = d.getUint32(ptr + CONFIG_OFF_SCROLLBACK, true)
    this.setUsize(
      term,
      abi.T_OPT_SCROLLBACK_MAX_BYTES,
      budget === 0 ? UNLIMITED_SCROLLBACK_BYTES : budget,
    )

    this.applyColors(term, ptr)

    this.applyPalette(term, ptr)
    this.applyCursor(term, ptr)
  }

  /**
   * The cursor a reset returns to; the core keeps it across `ESC c` and
   * `CSI 0 q` (verified). Stored +1 so "unspecified" differs from block (0).
   */
  private applyCursor(term: number, ptr: number): void {
    const d = this.dv()
    const style = d.getUint32(ptr + CONFIG_OFF_CURSOR_STYLE, true)
    const blink = d.getUint32(ptr + CONFIG_OFF_CURSOR_BLINK, true)
    if (style !== 0) {
      this.dv().setUint32(this.scratch, mainCursorStyleFor(style - 1), true)
      this.ex.ghostty_terminal_set(term, abi.T_OPT_DEFAULT_CURSOR_STYLE, this.scratch)
    }
    if (blink !== 0) {
      this.dv().setUint8(this.scratch, blink === 2 ? 1 : 0)
      this.ex.ghostty_terminal_set(term, abi.T_OPT_DEFAULT_CURSOR_BLINK, this.scratch)
    }
  }

  /**
   * Foreground, background and cursor. Foreground and background are always set
   * together: setting only one leaves the render state reporting the other as
   * plain white, while `terminal_get` reports correctly. A zero field (which is
   * also how `#000000` packs) uses the core's current value.
   */
  private applyColors(term: number, ptr: number): void {
    const d = this.dv()
    const fg = d.getUint32(ptr + CONFIG_OFF_FG, true)
    const bg = d.getUint32(ptr + CONFIG_OFF_BG, true)
    const cursor = d.getUint32(ptr + CONFIG_OFF_CURSOR, true)
    this.setColor(term, abi.T_OPT_COLOR_FOREGROUND, fg !== 0 ? fg : this.currentColor(term, abi.T_DATA_COLOR_FOREGROUND, 0xffffff))
    this.setColor(term, abi.T_OPT_COLOR_BACKGROUND, bg !== 0 ? bg : this.currentColor(term, abi.T_DATA_COLOR_BACKGROUND, 0x000000))
    if (cursor !== 0) this.setColor(term, abi.T_OPT_COLOR_CURSOR, cursor)
  }

  /** What the terminal already holds for a color, or `fallback`. */
  private currentColor(term: number, key: number, fallback: number): number {
    if (!this.tGet(term, key)) return fallback
    const d = this.dv()
    return (d.getUint8(this.scratch) << 16) | (d.getUint8(this.scratch + 1) << 8) | d.getUint8(this.scratch + 2)
  }

  /**
   * Our 16 ANSI colors over `main`'s 256-entry palette: read the current table,
   * overwrite the first 16, set it back, leaving the derived 240 as they were.
   * An all-zero block means no palette was passed.
   */
  private applyPalette(term: number, ptr: number): void {
    const d = this.dv()
    let any = false
    for (let i = 0; i < CONFIG_PALETTE_ENTRIES; i++) {
      if (d.getUint32(ptr + CONFIG_OFF_PALETTE + i * 4, true) !== 0) {
        any = true
        break
      }
    }
    if (!any) return
    if (this.ex.ghostty_terminal_get(term, abi.T_DATA_COLOR_PALETTE, this.palette) !== abi.GHOSTTY_SUCCESS) {
      return
    }
    const w = this.dv()
    for (let i = 0; i < CONFIG_PALETTE_ENTRIES; i++) {
      const rgb = w.getUint32(ptr + CONFIG_OFF_PALETTE + i * 4, true)
      const at = this.palette + i * abi.COLOR_RGB_BYTES
      w.setUint8(at, (rgb >> 16) & 0xff)
      w.setUint8(at + 1, (rgb >> 8) & 0xff)
      w.setUint8(at + 2, rgb & 0xff)
    }
    // The array pointer itself; a pointer-to-pointer leaves every color black.
    this.ex.ghostty_terminal_set(term, abi.T_OPT_COLOR_PALETTE, this.palette)
  }

  freeTerminal(term: number): void {
    const st = this.state(term)
    if (st) {
      st.effects.dispose()
      st.scrollback.dispose()
      st.reader.dispose()
      if (st.dirtyIter !== 0) this.ex.ghostty_render_state_row_iterator_free(st.dirtyIter)
      this.terms.delete(term)
    }
    this.ex.ghostty_terminal_free(term)
  }

  /* --------------------------------------------------------- snapshots */

  /**
   * Rebuilds the render snapshot and records the scrollback depth. The only
   * place the cursor and color caches are invalidated.
   */
  private snapshot(term: number, st: TerminalState): void {
    st.reader.update()
    st.cursorRead = false
    st.colorsRead = false
    st.snapshotScrollback = this.tGet(term, abi.T_DATA_SCROLLBACK_ROWS)
      ? this.dv().getUint32(this.scratch, true)
      : 0
  }

  /**
   * Runs inside `vt_write`, where the core allows snapshots and reads but not
   * terminal writes.
   */
  private onRenderHold(term: number, held: boolean): void {
    const st = this.state(term)
    if (!st) return
    if (held) {
      this.snapshot(term, st)
      st.hold = { active: true, since: performance.now(), fresh: true }
    } else {
      st.hold.active = false
    }
  }

  /**
   * Ends a hold that outlived the timeout, via `T_OPT_MODE` (which doesn't fire
   * the callback). Re-setting 2026 during a hold doesn't extend the deadline.
   */
  private expireHold(term: number, st: TerminalState): void {
    if (!st.hold.active || performance.now() - st.hold.since < RENDER_HOLD_TIMEOUT_MS) return
    const d = this.dv()
    d.setUint16(this.scratch + abi.MODE_CONFIG_MODE_OFFSET, abi.MODE_SYNC_OUTPUT, true)
    d.setUint8(this.scratch + abi.MODE_CONFIG_VALUE_OFFSET, 0)
    this.ex.ghostty_terminal_set(term, abi.T_OPT_MODE, this.scratch)
    st.hold.active = false
  }

  /* ---------------------------------------------------------- responses */

  private drain(term: number): Uint8Array[] {
    const st = this.state(term)
    if (!st) return []
    const fresh = st.effects.takeResponses()
    if (fresh.length > 0) st.pending.push(...fresh)
    return st.pending
  }

  /* -------------------------------------------------------------- dirty */

  /**
   * Per-row dirty, using `next_dirty` to jump through dirty rows (ascending)
   * until reaching or passing `y`. Unused by the app (the renderer redraws the
   * whole viewport), but implemented because a stub answering "clean" would hide
   * bugs.
   */
  private rowDirty(term: number, y: number): boolean {
    const { ex } = this
    const st = this.state(term)
    if (!st) return false
    if (st.dirtyIter === 0) {
      if (ex.ghostty_render_state_row_iterator_new(0, this.slot) !== abi.GHOSTTY_SUCCESS) return false
      st.dirtyIter = this.dv().getUint32(this.slot, true)
    }
    // `get` wants the slot holding the handle.
    this.dv().setUint32(this.slot, st.dirtyIter, true)
    if (ex.ghostty_render_state_get(st.reader.state, abi.RS_DATA_ROW_ITERATOR, this.slot) !== abi.GHOSTTY_SUCCESS) {
      return false
    }
    const iter = this.dv().getUint32(this.slot, true)
    // A bool, not a result; `outY` is only written when it advances.
    while (ex.ghostty_render_state_row_iterator_next_dirty(iter, this.scratch)) {
      const at = this.dv().getUint16(this.scratch, true)
      if (at === y) return true
      if (at > y) return false
    }
    return false
  }

  /* ------------------------------------------------------------- facade */

  /** The object the app talks to, shaped like the vendored exports. */
  exports(): GhosttyExports {
    const { ex } = this

    return {
      memory: ex.memory,

      ghostty_terminal_new: (cols, rows) => this.newTerminal(cols, rows),
      ghostty_terminal_new_with_config: (cols, rows, config) => this.newTerminal(cols, rows, config),
      ghostty_terminal_free: (term) => this.freeTerminal(term),
      ghostty_terminal_resize: (term, cols, rows) => {
        ex.ghostty_terminal_resize(term, cols, rows)
      },
      ghostty_terminal_set_resize_pull_scrollback: (term, pull) => {
        // `bool*`: one byte.
        this.dv().setUint8(this.scratch, pull !== 0 ? 1 : 0)
        ex.ghostty_terminal_set(term, abi.T_OPT_RESIZE_PULL_SCROLLBACK, this.scratch)
      },
      // Void on both sides; main reports failure via T_DATA_VT_PROCESSING_ERROR.
      // Don't wrap it in a result check.
      ghostty_terminal_write: (term, data, len) => ex.ghostty_terminal_vt_write(term, data, len),

      ghostty_render_state_update: (term) => {
        const st = this.state(term)
        if (!st) return 0
        this.expireHold(term, st)
        // During a hold the captured snapshot is the frame to show.
        if (st.hold.active) st.hold.fresh = false
        else this.snapshot(term, st)
        return 0
      },
      ghostty_render_state_is_held: (term) => {
        const st = this.state(term)
        if (!st) return 0
        this.expireHold(term, st)
        return st.hold.active && !st.hold.fresh ? 1 : 0
      },
      ghostty_render_state_get_scrollback_length: (term) => this.state(term)?.snapshotScrollback ?? 0,
      ghostty_render_state_get_cols: (term) => this.rsU16(term, abi.RS_DATA_COLS),
      ghostty_render_state_get_rows: (term) => this.rsU16(term, abi.RS_DATA_ROWS),
      // The cursor getters share one `RS_DATA_CURSOR` read per frame.
      ghostty_render_state_get_cursor_x: (term) =>
        this.snapshotCursor(term) && this.cursorHasPosition()
          ? this.dv().getUint16(this.cursorBuf + abi.RS_CURSOR_OFF_VIEWPORT_X, true)
          : 0,
      ghostty_render_state_get_cursor_y: (term) =>
        this.snapshotCursor(term) && this.cursorHasPosition()
          ? this.dv().getUint16(this.cursorBuf + abi.RS_CURSOR_OFF_VIEWPORT_Y, true)
          : 0,
      // Not visible without a viewport position (scrolled out of view).
      ghostty_render_state_get_cursor_visible: (term) =>
        this.snapshotCursor(term) &&
        this.dv().getUint8(this.cursorBuf + abi.RS_CURSOR_OFF_VISIBLE) !== 0 &&
        this.cursorHasPosition()
          ? 1
          : 0,
      ghostty_render_state_get_cursor_blinking: (term) =>
        this.snapshotCursor(term) && this.dv().getUint8(this.cursorBuf + abi.RS_CURSOR_OFF_BLINKING) !== 0
          ? 1
          : 0,
      ghostty_render_state_get_cursor_style: (term) =>
        this.snapshotCursor(term)
          ? cursorStyleForMain(this.dv().getUint32(this.cursorBuf + abi.RS_CURSOR_OFF_VISUAL_STYLE, true))
          : CURSOR_STYLE_BLOCK,
      // One `RS_DATA_COLORS` read serves both.
      ghostty_render_state_get_fg_color: (term) =>
        this.snapshotColors(term) ? this.rgbAt(this.colorsBuf, abi.RS_COLORS_OFF_FOREGROUND) : 0,
      ghostty_render_state_get_bg_color: (term) =>
        this.snapshotColors(term) ? this.rgbAt(this.colorsBuf, abi.RS_COLORS_OFF_BACKGROUND) : 0,
      ghostty_render_state_is_row_dirty: (term, y) => (this.rowDirty(term, y) ? 1 : 0),
      ghostty_render_state_mark_clean: (term) => {
        const st = this.state(term)
        if (!st) return
        // Clears both dirty layers; setting `RS_OPTION_DIRTY` alone leaves the
        // per-row flags set.
        ex.ghostty_render_state_clean(st.reader.state)
      },

      ghostty_render_state_get_viewport: (term, out, cells) => {
        const st = this.state(term)
        if (!st) return -1
        const cols = this.rsU16(term, abi.RS_DATA_COLS)
        if (cols <= 0) return 0
        // Truncate to the caller's buffer.
        const rows = Math.min(this.rsU16(term, abi.RS_DATA_ROWS), Math.floor(cells / cols))
        return st.reader.read(out, cols, rows)
      },
      ghostty_render_state_get_grapheme: (term, row, col, out, cap) =>
        this.state(term)?.scrollback.graphemes(row, col, out, cap, SPACE_ACTIVE) ?? 0,

      ghostty_terminal_is_alternate_screen: (term) =>
        this.tGet(term, abi.T_DATA_ACTIVE_SCREEN) &&
        this.dv().getUint32(this.scratch, true) === abi.SCREEN_ALTERNATE
          ? 1
          : 0,
      ghostty_terminal_has_mouse_tracking: (term) =>
        this.tGet(term, abi.T_DATA_MOUSE_TRACKING) && this.dv().getUint8(this.scratch) !== 0 ? 1 : 0,
      // main folds `is_ansi` into bit 15 of the mode, and reads modes through
      // the generic getter with the in/out `T_DATA_MODE` struct.
      ghostty_terminal_get_mode: (term, mode, isAnsi) => {
        this.dv().setUint16(
          this.scratch + abi.MODE_CONFIG_MODE_OFFSET,
          abi.ansiMode(mode, isAnsi !== 0),
          true,
        )
        return ex.ghostty_terminal_get(term, abi.T_DATA_MODE, this.scratch) ===
          abi.GHOSTTY_SUCCESS &&
          this.dv().getUint8(this.scratch + abi.MODE_CONFIG_VALUE_OFFSET) !== 0
          ? 1
          : 0
      },
      // main addresses the active screen and scrollback in one space.
      ghostty_terminal_is_row_wrapped: (term, y) =>
        this.state(term)?.scrollback.isRowWrapped(y, SPACE_ACTIVE) ? 1 : 0,
      ghostty_terminal_is_scrollback_row_wrapped: (term, offset) =>
        this.state(term)?.scrollback.isRowWrapped(offset, SPACE_SCREEN) ? 1 : 0,

      ghostty_terminal_get_scrollback_length: (term) =>
        this.tGet(term, abi.T_DATA_SCROLLBACK_ROWS) ? this.dv().getUint32(this.scratch, true) : 0,
      ghostty_terminal_get_scrollback_line: (term, offset, out, cells) => {
        const st = this.state(term)
        if (!st) return 0
        return st.scrollback.readRow(out, offset, cells, SPACE_SCREEN) ? cells : 0
      },
      ghostty_terminal_get_scrollback_grapheme: (term, offset, col, out, cap) =>
        this.state(term)?.scrollback.graphemes(offset, col, out, cap, SPACE_SCREEN) ?? 0,

      ghostty_terminal_has_response: (term) => (this.drain(term).length > 0 ? 1 : 0),
      ghostty_terminal_read_response: (term, out, len) => {
        const queue = this.drain(term)
        const reply = queue.shift()
        if (!reply) return 0
        // Truncated rather than split; replies (CPR, DA, DSR, XTVERSION) are far
        // shorter than the 256 bytes `readResponse` provides.
        const n = Math.min(reply.length, len)
        new Uint8Array(ex.memory.buffer, out, n).set(reply.subarray(0, n))
        return n
      },

      ghostty_wasm_alloc_u8_array: (len) => ex.ghostty_wasm_alloc(len),
      ghostty_wasm_free_u8_array: (ptr, len) => ex.ghostty_wasm_free(ptr, len),
    }
  }
}

/**
 * Whether an instance is a `main` build rather than v1.3.1, keyed on
 * `vt_write` (which only `main` has), so the ABI is chosen from the binary
 * itself.
 */
export function isMainBuild(instance: WebAssembly.Instance): boolean {
  return typeof (instance.exports as Record<string, unknown>).ghostty_terminal_vt_write === 'function'
}

/** Wraps a `main` instance as the `GhosttyWasm` the app consumes. */
export function shimMainWasm(instance: WebAssembly.Instance): GhosttyWasm {
  const shim = new MainShim(instance.exports as unknown as MainExports)
  return { exports: shim.exports(), instance }
}

/** Compile and wrap, for node-side test harnesses holding bytes. */
export async function instantiateMainGhosttyWasm(bytes: ArrayBuffer): Promise<GhosttyWasm> {
  const module = await WebAssembly.compile(bytes)
  const instance = await WebAssembly.instantiate(module, {
    env: { log: () => {} },
  })
  return shimMainWasm(instance)
}
