/**
 * Our 83-export ABI, implemented over ghostty `main`'s 202.
 *
 * ## Why a shim rather than porting the call sites
 *
 * The port's status list ended at "select the reader in `GhosttyEngine` /
 * `WebGLRenderer`", which is two call sites for the viewport — but the viewport
 * was never the whole surface. `GhosttyEngine` alone reaches for twenty-odd
 * `ghostty_*` exports across the render loop, search, links, mark mode, mouse
 * reporting and resize, and every one of them would have to move at the same
 * time as the binary. That is a single unreviewable change, and if the screen
 * comes out wrong afterwards there is nothing to bisect.
 *
 * So the boundary moves instead of the callers. This presents exactly the
 * `GhosttyExports` object the app already talks to, backed by `main`. Every
 * consumer above it — the renderer, `readRows`, `SearchController`,
 * `LinkController`, `MouseReporter` — is untouched, and the whole port becomes
 * one swappable object with the existing suite standing over it.
 *
 * The three readers this composes are each already asserted byte-identical to
 * the export they replace (`ViewportReader.test.ts`, `ScrollbackReader.test.ts`,
 * `effects.test.ts`). What is new here is the *bookkeeping* our ABI hides and
 * `main` does not:
 *
 * - **A render state is a separate object on `main`.** Ours is implicit in the
 *   terminal, so `render_state_get_cols(term)` has to find the state that
 *   belongs to that terminal. Hence the per-terminal map.
 * - **Update and read are ours to order.** `render_state_update` is called once
 *   a frame and the cells, dimensions and cursor are then read off that one
 *   snapshot; `readRows` reads the same snapshot mid-frame without updating. So
 *   the shim updates only where our ABI updates.
 * - **Replies are a callback, not a queue** — buffered by `MainEffects` and
 *   handed back through `has_response`/`read_response`.
 * - **The cursor style enum is renumbered.** Ours is block=0, bar=1; main's is
 *   bar=0, block=1. Nothing about a mis-mapping looks like an error: you get a
 *   cursor, just the wrong shape, so it is translated in one place here.
 *
 * ## What it does not carry
 *
 * `last_reset_seq` / `last_cursor_style_seq` are **gone from the ABI**, not
 * shimmed. They existed only so the host could tell whether a RIS had thrown
 * the configured cursor away and nothing had claimed it since; `main` holds
 * that preference across the reset itself, through the
 * `OPT_DEFAULT_CURSOR_STYLE` / `_BLINK` pair that `TerminalConfig.cursorStyle`
 * feeds. `cursorResetLive.test.ts` still passes unchanged, through an entirely
 * different mechanism, which is the evidence that this was a fair trade.
 *
 * The one thing that does not carry over is a preference *changed mid-session*:
 * the default is set when the terminal is made, so a RIS after a settings
 * change returns the cursor the pane opened with. The live cursor is still
 * correct — `setCursorStyle` writes DECSCUSR either way.
 *
 * `hyperlinkId` is 0 on every cell, as documented in `ViewportReader`.
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

/** `GhosttyTerminalConfig`, as `createTerminal` packs it: 4 u32s then 16 more. */
const CONFIG_OFF_SCROLLBACK = 0
const CONFIG_OFF_FG = 4
const CONFIG_OFF_BG = 8
const CONFIG_OFF_CURSOR = 12
const CONFIG_OFF_PALETTE = 16
const CONFIG_PALETTE_ENTRIES = 16
/** Past the struct the vendored core reads; see `TerminalConfig`. Both are
 *  stored +1, so zero means "not specified". */
const CONFIG_OFF_CURSOR_STYLE = 80
const CONFIG_OFF_CURSOR_BLINK = 84

/**
 * What a terminal created without a config gets.
 *
 * `main`'s own default is **10,000 bytes** — measured, not read: it retains 370
 * rows at 200 columns, where our ABI's no-config path and every test that uses
 * it assume thousands. A budget rather than a row count because that is the
 * unit both ABIs settle on; see `TerminalConfig.scrollbackLimit`.
 */
const DEFAULT_SCROLLBACK_BYTES = 1024 * 1024

/**
 * `scrollbackLimit: 0` means unlimited in our ABI. `main` has no such sentinel —
 * a max of 0 is a max of 0 — so it becomes the largest budget a wasm32 `size_t`
 * holds, which no session will reach.
 */
const UNLIMITED_SCROLLBACK_BYTES = 0xffffffff

/**
 * main's `GhosttyRenderStateCursorVisualStyle` onto our `CURSOR_STYLE_*`.
 *
 * A function rather than a lookup table built at module scope, and that is
 * load-bearing: `wasmBindings` imports this module to select the ABI, so the
 * two form an import cycle, and a table built while `wasmBindings` is still
 * initialising reads its constants in their temporal dead zone. Everything here
 * touches the other module only when called.
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
 * The same renumbering the other way, for `OPT_DEFAULT_CURSOR_STYLE`.
 *
 * `GhosttyTerminalCursorStyle` and `GhosttyRenderStateCursorVisualStyle` number
 * identically, so this is one mapping used in both directions rather than two
 * that could disagree.
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
  /** Lazily made: nothing in the app asks a row whether it is dirty. */
  dirtyIter: number
  /**
   * Whether this frame's `RS_DATA_CURSOR` / `RS_DATA_COLORS` reads have been
   * taken yet. Cleared by `render_state_update`, which is the only thing that
   * can change either — see `snapshotCursor`.
   */
  cursorRead: boolean
  colorsRead: boolean
}

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
    // Both are far larger than the 16-byte scratch — the colours struct carries
    // the whole palette inline — so they get buffers of their own rather than
    // growing the one every other read borrows.
    this.cursorBuf = ex.ghostty_wasm_alloc(abi.RS_CURSOR_SIZE)
    this.colorsBuf = ex.ghostty_wasm_alloc(abi.RS_COLORS_SIZE)
  }

  /** Re-made only when linear memory growth has detached the previous one. */
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
   * Reads `RS_DATA_CURSOR` once per frame into `cursorBuf`.
   *
   * Our ABI asks for the cursor a field at a time — `get_cursor_x`,
   * `_visible`, `_blinking`, `_style` — and the renderer calls all of them
   * every frame. Answering each with its own `render_state_get` was six
   * boundary crossings for one struct upstream now hands over in one, which is
   * what `16c833c5f` added it for. So the struct is read on the first ask of a
   * frame and the rest are served from the buffer.
   *
   * Caching is only safe because `render_state_update` is the sole thing that
   * moves the cursor from a reader's point of view: it is the one call that
   * rebuilds the snapshot, and it clears these flags. `readRows` deliberately
   * reads mid-frame *without* updating, and has to see the same cursor the
   * cells beside it came from — which this preserves and a re-read would break.
   */
  private snapshotCursor(term: number): boolean {
    const st = this.state(term)
    if (!st) return false
    if (!st.cursorRead) {
      // Sized struct: the callee has to be told how much of it we know about.
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
   * Whether the snapshot's `viewport_x`/`_y` may be read at all.
   *
   * Upstream documents them as undefined when this is false, so this is a
   * precondition rather than a nicety — it is what keeps a cursor scrolled out
   * of the viewport from being drawn at whatever the struct happens to hold.
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
      // Installed at creation, before a single byte is written: `vt_write`
      // ignores anything needing a reply until it is, and a query missed during
      // startup is one a program is already waiting on.
      effects: new MainEffects({ ex, term }),
      pending: [],
      dirtyIter: 0,
      cursorRead: false,
      colorsRead: false,
    })
    return term
  }

  /**
   * Applies the packed `GhosttyTerminalConfig` our ABI takes at construction.
   * `main` has no constructor options at all, so each field becomes a `set`.
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
   * The cursor a reset returns to.
   *
   * This is what replaces `last_reset_seq` / `last_cursor_style_seq`: those
   * exist only because RIS discarded the configured cursor and the host had to
   * decide whether to put it back. Here the core holds it — verified, not
   * assumed: with a default of bar+blink, `ESC c` comes back bar+blink, and so
   * does `CSI 0 q`.
   *
   * Both fields are stored +1 so that "not specified" is distinguishable from
   * block, which is 0 on our side and a perfectly ordinary request.
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
   * Foreground, background and cursor — **always both of the first two**.
   *
   * Zero means "let the core pick" in our config, so the obvious shape is to
   * skip the ones that are zero. That silently loses the other one: setting a
   * foreground and no background leaves the *render state* reporting plain
   * white, forever, while `terminal_get(COLOR_FOREGROUND)` cheerfully reports
   * the colour that was set. Setting both — in either order, and black counts —
   * makes both stick. Measured against the pin, not read: the terminal and the
   * render state disagree, so nothing about it looks like an error, and it only
   * shows on a theme whose background is `#000000`, which packs as 0 and so
   * reads as "unset".
   *
   * So a zero field becomes the core's *current* value rather than a skipped
   * call, which keeps "0 means let the core pick" true while still setting
   * both.
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

  /** What the terminal already holds for a colour, or `fallback`. */
  private currentColor(term: number, key: number, fallback: number): number {
    if (!this.tGet(term, key)) return fallback
    const d = this.dv()
    return (d.getUint8(this.scratch) << 16) | (d.getUint8(this.scratch + 1) << 8) | d.getUint8(this.scratch + 2)
  }

  /**
   * The 16 ANSI colours our config carries, over the 256 `main` takes.
   *
   * Ours configures 16 and lets the core derive the colour cube and greys from
   * its own defaults; main's option is all 256 at once. So the current table is
   * read back, the first 16 entries overwritten, and the whole thing set again —
   * which leaves the derived 240 exactly as the core would have had them.
   *
   * An all-zero block means no palette was passed (`palette: []` packs as
   * zeros), not sixteen shades of black: nobody configures that, and the
   * alternative is overwriting the core's palette with it.
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
    // The array pointer itself, not a pointer to it: the other form returns
    // SUCCESS and leaves every colour black.
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
   * Per-row dirty. `main` still has no "is row N dirty" call, but since
   * `ad6e72ddc` it has one that jumps straight to the next dirty row, so this
   * no longer walks every row up to `y`.
   *
   * It advances over dirty rows until it reaches or passes `y`: the rows come
   * back in ascending viewport order, so the first one that is not less than
   * `y` settles the question. That is O(dirty rows before y) rather than O(y),
   * and on the case this exists for — a clean screen with one edited row — it
   * is two calls instead of twenty-five.
   *
   * The `at > y` exit is an optimisation only: without it the loop scans the
   * remaining dirty rows and returns the same answer, just slower. No test
   * pins it, because there is no behaviour to pin.
   *
   * Nothing in the app calls this: the renderer redraws the whole viewport and
   * uses `mark_clean` alone. It is implemented rather than stubbed because a
   * stub answering "clean" is exactly the shape of bug that hides itself.
   */
  private rowDirty(term: number, y: number): boolean {
    const { ex } = this
    const st = this.state(term)
    if (!st) return false
    if (st.dirtyIter === 0) {
      if (ex.ghostty_render_state_row_iterator_new(0, this.slot) !== abi.GHOSTTY_SUCCESS) return false
      st.dirtyIter = this.dv().getUint32(this.slot, true)
    }
    // `get` wants the slot holding the handle, not the handle.
    this.dv().setUint32(this.slot, st.dirtyIter, true)
    if (ex.ghostty_render_state_get(st.reader.state, abi.RS_DATA_ROW_ITERATOR, this.slot) !== abi.GHOSTTY_SUCCESS) {
      return false
    }
    const iter = this.dv().getUint32(this.slot, true)
    // A bool, not a result: truthy means it advanced. `outY` is only written
    // when it does, so the previous value must never be read on a false.
    while (ex.ghostty_render_state_row_iterator_next_dirty(iter, this.scratch)) {
      const at = this.dv().getUint16(this.scratch, true)
      if (at === y) return true
      if (at > y) return false
    }
    return false
  }

  /* ------------------------------------------------------------- facade */

  /** The object the app talks to, shaped exactly like the vendored exports. */
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
      // Returns void on both sides, but for different reasons: ours never
      // reported failure, and main's reports it out-of-band through
      // T_DATA_VT_PROCESSING_ERROR. Wrapping this in a result check compares
      // `undefined` against 0 and throws on a write that worked.
      ghostty_terminal_write: (term, data, len) => ex.ghostty_terminal_vt_write(term, data, len),

      ghostty_render_state_update: (term) => {
        const st = this.state(term)
        if (!st) return 0
        st.reader.update()
        // The frame boundary, and so the only place the cursor and colour
        // snapshots may be invalidated. Anything that re-read them elsewhere
        // would hand the renderer a cursor from a newer grid than its cells.
        st.cursorRead = false
        st.colorsRead = false
        return 0
      },
      ghostty_render_state_get_cols: (term) => this.rsU16(term, abi.RS_DATA_COLS),
      ghostty_render_state_get_rows: (term) => this.rsU16(term, abi.RS_DATA_ROWS),
      // The five cursor getters below share one `RS_DATA_CURSOR` read per frame.
      // `viewport_x`/`_y` are undefined unless `viewport_has_value`, so they are
      // gated on it rather than read blind.
      ghostty_render_state_get_cursor_x: (term) =>
        this.snapshotCursor(term) && this.cursorHasPosition()
          ? this.dv().getUint16(this.cursorBuf + abi.RS_CURSOR_OFF_VIEWPORT_X, true)
          : 0,
      ghostty_render_state_get_cursor_y: (term) =>
        this.snapshotCursor(term) && this.cursorHasPosition()
          ? this.dv().getUint16(this.cursorBuf + abi.RS_CURSOR_OFF_VIEWPORT_Y, true)
          : 0,
      // Two conditions on main, one on ours: a cursor scrolled out of the
      // viewport is reported as *having no position*, and its x/y are then
      // explicitly undefined. Drawing it anyway would put it at (0,0).
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
      // Likewise one `RS_DATA_COLORS` read serves both, and would serve the
      // cursor colour and the palette too if anything asked for them.
      ghostty_render_state_get_fg_color: (term) =>
        this.snapshotColors(term) ? this.rgbAt(this.colorsBuf, abi.RS_COLORS_OFF_FOREGROUND) : 0,
      ghostty_render_state_get_bg_color: (term) =>
        this.snapshotColors(term) ? this.rgbAt(this.colorsBuf, abi.RS_COLORS_OFF_BACKGROUND) : 0,
      ghostty_render_state_is_row_dirty: (term, y) => (this.rowDirty(term, y) ? 1 : 0),
      ghostty_render_state_mark_clean: (term) => {
        const st = this.state(term)
        if (!st) return
        // One call, and — more to the point — the *whole* thing. This used to
        // set `RS_OPTION_DIRTY` to FALSE, which is only the global layer: the
        // per-row flags are independent and survived it, so an 80x24 viewport
        // stayed 24-rows-dirty forever after being marked clean. Nothing read
        // them, so nothing broke; it would have broken the moment anything did,
        // which is exactly what the dirty-row iterator is for.
        ex.ghostty_render_state_clean(st.reader.state)
      },

      ghostty_render_state_get_viewport: (term, out, cells) => {
        const st = this.state(term)
        if (!st) return -1
        const cols = this.rsU16(term, abi.RS_DATA_COLS)
        if (cols <= 0) return 0
        // Never write past what the caller sized: `cells` is their buffer, and
        // a viewport taller than it must be truncated rather than trusted.
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
      // Two shape differences from our API, not one:
      //
      // The `is_ansi` flag is not an argument on main — it is bit 15 of the
      // mode. Passing it as one drops the out pointer off the end of the call.
      //
      // And there is no longer a dedicated mode getter: upstream `cfc19e805`
      // removed `ghostty_terminal_mode_get`/`_mode_set` and folded them into
      // the ordinary `ghostty_terminal_get`/`_set` under `T_DATA_MODE`. That
      // key is *in/out* — the mode goes into the scratch before the call, and
      // the core writes the answer back into the same struct.
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
      // Both wrap questions are one `grid_ref` lookup apart: ours splits the
      // active screen from scrollback, main addresses them in one space.
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
        // A reply longer than the caller's buffer is truncated rather than
        // split: every reply this ABI carries (CPR, DA, DSR, XTVERSION) is
        // tens of bytes against the 256 `readResponse` asks for, and half a
        // reply followed by the other half is worse than a short one.
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
 * Whether an instance is a `main` build rather than the vendored v1.3.1 one.
 *
 * Keyed on `vt_write` because it is the rename at the heart of the move and
 * exists in exactly one of the two builds. Cheap enough to call at
 * instantiation, which is what makes selecting the ABI a property of the binary
 * rather than a build flag someone has to keep in step with it.
 */
export function isMainBuild(instance: WebAssembly.Instance): boolean {
  return typeof (instance.exports as Record<string, unknown>).ghostty_terminal_vt_write === 'function'
}

/** Wraps a `main` instance as the `GhosttyWasm` the app consumes. */
export function shimMainWasm(instance: WebAssembly.Instance): GhosttyWasm {
  const shim = new MainShim(instance.exports as unknown as MainExports)
  return { exports: shim.exports(), instance }
}

/** Compile-and-wrap, for callers holding bytes — the node-side test harnesses. */
export async function instantiateMainGhosttyWasm(bytes: ArrayBuffer): Promise<GhosttyWasm> {
  const module = await WebAssembly.compile(bytes)
  const instance = await WebAssembly.instantiate(module, {
    env: { log: () => {} },
  })
  return shimMainWasm(instance)
}
