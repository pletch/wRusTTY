import {
  SCROLLBAR_GUTTER_PX,
  type IDisposable,
  type SearchOptions,
  type SearchResult,
  type TerminalEngine,
} from '../terminalEngine'
import { SearchController } from './SearchController'
import { MouseReporter, type MousePoint } from './MouseReporter'
import { MouseEncoder } from './MouseEncoder'
import { encodePaste, hasPasteEncoder, pasteIsSafe } from './pasteEncode'
import { SelectionController } from './SelectionController'
import { MarkModeController } from './MarkModeController'
import { LinkController, type Link } from './LinkController'
import { HintModeController } from './HintModeController'
import { isOpenableUrl } from '../urlDetect'
import { ContextManager } from './ContextManager'
import type { RowText } from './rowText'
import { WebGLRenderer, measureCell } from './WebGLRenderer'
import { scanOsc } from './oscScanner'
import * as phases from '../writePhases'
import { findTheme, hexToRgb, type TerminalTheme } from '../theme'
import { cursorStyleSequence, type CursorStyleSetting } from '../settings'
import {
  compileGhosttyWasm,
  instantiateGhosttyModule,
  createTerminal,
  writeBytes,
  readResponse,
  parseCellInto,
  emptyCell,
  MODE_BRACKETED_PASTE,
  MODE_FOCUS_REPORTING,
  MODE_MOUSE_SGR_PIXELS,
  allocBufferOrThrow,
  GhosttyOutOfMemoryError,
  type GhosttyWasm,
  CELL_BYTES,
  CURSOR_STYLE_BLOCK,
  CURSOR_STYLE_BAR,
  CURSOR_STYLE_UNDERLINE,
} from './wasmBindings'
import { GhosttyInputHandler } from './GhosttyInputHandler'
import { KeyEncoder } from './KeyEncoder'
// A locally-built binary: ghostty `main` at the port's pin, plus the one fix we
// still carry (#176, `ESC k`). It speaks main's API rather than the one
// `wasmBindings.ts` declares — `instantiateGhosttyModule` recognises that from
// the binary's exports and wraps it in `main/shim.ts`, so nothing in this file
// knows which build it is talking to. See vendor/README.md and
// docs/PORT_GHOSTTY_MAIN.md.
import ghosttyWasmUrl from './vendor/ghostty-vt.wasm?url'

/** The cursor preference as the core's own numbering, for the config struct. */
const CONFIG_CURSOR_STYLE: Record<CursorStyleSetting, number> = {
  block: CURSOR_STYLE_BLOCK,
  bar: CURSOR_STYLE_BAR,
  underline: CURSOR_STYLE_UNDERLINE,
}

/** xterm's blink period, so the two engines don't visibly differ. */
const CURSOR_BLINK_MS = 530

/**
 * `scrollbackLimit` in the core's config is a **byte budget**, not a row count
 * — the name reads like xterm's `scrollback` and it is not. It reaches upstream
 * Ghostty's `PageList` as `max_size`, which is in bytes, so a row-shaped value
 * lands far below the core's ~530 KB minimum page and every setting collapses
 * to the same two-page floor. That is exactly how a row count behaved when it
 * was tried: measured against this build, 1000 / 5000 / 10000 / 50000 / 100000
 * all retained ~1100 rows at 80 columns, ~250 at 200, with the WASM heap pinned
 * at its initial 6.6 MB because the core never had a reason to grow.
 *
 * The unit is settled by sweeping the raw field against this binary: retention
 * tracks `value / (cols * 9.2)`. That constant is a property of the *core*, not
 * arithmetic, and it moved with the port — the v1.3.1 build delivered 12.65
 * bytes per cell, ghostty `main` delivers 8.5-9.7 from 80 to 400 columns and
 * across every budget from 6 MB up, so the same budget now buys ~37% more
 * depth. Below ~3 MB the figure degrades to 10.5-12.6 because whole-page
 * eviction dominates when a budget is only a few pages wide; that is why the
 * band around the smallest tier in `scrollbackLimit.test.ts` is wider than the
 * others. Note `vendor/README.md` used to assert the opposite and dismiss
 * `ghostty-web`'s "it's bytes" docs (their PR #151); they were right.
 *
 * Rows are therefore not a quantity this side can promise — they fall out of
 * the budget and the width, and widening a pane trades depth for columns out
 * of the same budget, which is how Ghostty itself behaves. That is why the
 * *setting* is the budget rather than a row count: a row count is a promise
 * whose truth depends on how wide the user later drags the pane, and it was
 * offered and broken twice before this. `estimateScrollbackRows` derives the
 * rows for display, which is the honest direction to convert in.
 */
const SCROLLBACK_BYTES_PER_CELL = 9.2

/**
 * Per-pane memory tiers, keyed by the figure shown in Settings.
 *
 * **The key is the pane's total WASM footprint, not the scrollback budget** —
 * those differ by more than a factor of two and the user is choosing what the
 * pane costs, so the label has to be the cost. The values are the budgets that
 * buy the most scrollback without pushing the heap past the label.
 *
 * They look arbitrary because they are measured, not derived. WASM memory grows
 * in doubling steps, so the heap is a staircase against the budget rather than
 * a line: every budget from 13 MB to 26 MB lands on the same 33 MB heap, and
 * one more megabyte doubles it. **Re-measured for the move to ghostty `main`**,
 * which shifted every step: its binary is 1.3 MB against 742 kB and carries
 * more static data, so each budget now lands one doubling higher than it did.
 * Flooded to saturation, sweeping 80/200/400 columns and three flood shapes —
 * the steps are width-independent and shape-independent:
 *
 *   budget <= 2.5 MB  ->  5.0 MB heap     2.5 MB chosen, labelled 8 MB
 *   budget 2.75-6 MB  ->  9.0 MB heap       6 MB chosen, labelled 16 MB
 *   budget 6.5-12 MB  -> 17.0 MB heap      12 MB chosen, labelled 32 MB
 *   budget 13-26 MB   -> 33.0 MB heap      26 MB chosen, labelled 64 MB
 *
 * Each budget sits inside its step, so the label is an honest ceiling rather
 * than a target the pane creeps past — the renderer's scratch buffers come out
 * of the same linear memory and are not in the measurement above. Picking the
 * *top* of each step is the point: 6.5 MB and 12 MB cost the same 17 MB heap
 * but differ by ~2x in depth, so rounding the budget down would give away rows
 * for nothing. The tiers still buy more depth than they did before the port
 * despite the smaller budgets, because a row costs less.
 *
 * Re-measure before changing any of this, and after any rebuild of the
 * vendored binary; it is a property of that binary, not arithmetic.
 */
const SCROLLBACK_BUDGET_BY_FOOTPRINT_MB: Record<number, number> = {
  8: 2.5 * 1024 * 1024,
  16: 6 * 1024 * 1024,
  32: 12 * 1024 * 1024,
  64: 26 * 1024 * 1024,
}

/** Tier used when a setting is missing, corrupt, or not one of the tiers. The
 *  smallest, so an unreadable value can never cost more memory than the user
 *  last agreed to. */
const DEFAULT_FOOTPRINT_MB = 8

/** How much output may pile up waiting for the core to load before the engine
 *  gives up and says so. See parseSegment — the unbounded version of this hid a
 *  never-loading core behind a blank pane and a lying throughput figure. */
const MAX_PREREADY_BYTES = 1024 * 1024

/**
 * Bytes of scrollback to ask the core for, given the footprint tier the user
 * chose.
 *
 * Unlike the row-count version this replaces, the width is not an input: the
 * budget *is* the setting, and width only decides how many rows it buys.
 *
 * Every return path has to be a positive integer inside u32. Zero is not a
 * small budget to this core — `newWithConfig` reads it as *unlimited* — and the
 * value is written with `setUint32`, which turns a fractional or out-of-range
 * number into something arbitrary rather than erroring. Anything that is not a
 * known tier (a corrupt or hand-edited `localStorage` entry, `NaN`, a tier
 * retired by a later version) therefore falls back to the smallest tier rather
 * than being arithmetically coerced into some neighbouring value.
 */
export function scrollbackBudgetBytesFor(footprintMB: number): number {
  return SCROLLBACK_BUDGET_BY_FOOTPRINT_MB[footprintMB] ?? SCROLLBACK_BUDGET_BY_FOOTPRINT_MB[DEFAULT_FOOTPRINT_MB]
}

/**
 * Roughly how many rows a budget buys at a given width — the number shown in
 * Settings and the status bar.
 *
 * Approximate on purpose, and labelled that way wherever it is rendered. The
 * core evicts whole pages, so the true figure lands a little under this;
 * measured against the vendored binary across 80-400 columns the error runs
 * -27% to +8%, and all of the -27% is the smallest tier, where a budget only a
 * few pages wide makes page granularity the dominant term. From the 16 MB tier
 * up it is within -5% to +8%. Good enough to size a
 * decision by, which is all it is for — the exact depth of a live pane is
 * `scrollbackLength`, which is measured rather than estimated.
 */
export function estimateScrollbackRows(budgetBytes: number, cols: number): number {
  const safeCols = Number.isFinite(cols) ? Math.max(1, cols) : 1
  const safeBytes = Number.isFinite(budgetBytes) ? Math.max(0, budgetBytes) : 0
  return Math.round(safeBytes / (safeCols * SCROLLBACK_BYTES_PER_CELL))
}

/**
 * Grid that fits a container box, in cells.
 *
 * The gutter is the whole subtlety. The custom scrollbar is an overlay
 * anchored to the container's right edge and painted over the canvas
 * (`.term-scrollbar`, z-index 20), not a sibling the layout makes room for —
 * so a grid derived from the *full* width runs underneath it. What was left
 * between the canvas's right edge and the container's was only
 * `width % cellWidth`, and whenever that remainder came out under the
 * scrollbar's width the overlay covered the last column and clipped its
 * glyph. Which widths that hit depended on the font size and the pane's exact
 * pixel width, so the last character on a row appeared to vanish only
 * sometimes. Reserving the gutter here is what xterm's FitAddon does for its
 * own scrollbar.
 *
 * Pure, so the arithmetic can be tested without a DOM, a renderer or a core.
 */
export function fitGrid(
  box: { width: number; height: number },
  cell: { width: number; height: number },
  gutterPx: number,
): { cols: number; rows: number } {
  if (!(cell.width > 0) || !(cell.height > 0)) return { cols: 0, rows: 0 }
  return {
    cols: Math.max(0, Math.floor((box.width - gutterPx) / cell.width)),
    rows: Math.max(0, Math.floor(box.height / cell.height)),
  }
}

export class GhosttyEngine implements TerminalEngine {
  private container: HTMLElement | null = null
  private canvas: HTMLCanvasElement | null = null
  
  private wasm: GhosttyWasm | null = null
  private termPtr: number = 0
  private renderer: WebGLRenderer | null = null
  
  private fontFamily = 'Consolas, monospace'
  private fontSize = 14
  
  private onDataHandlers = new Set<(data: string) => void>()
  /** Fired from the two sites a human is behind — key input and paste — and
   *  nowhere else. Kept as a separate set rather than a flag threaded through
   *  `onData` so the distinction is made where the data originates, by the
   *  code that knows what it is, instead of being guessed at downstream. */
  private onInputHandlers = new Set<(data: string) => void>()
  private onResizeHandlers = new Set<(size: { cols: number; rows: number }) => void>()
  private inputHandler: GhosttyInputHandler | null = null
  /**
   * Ghostty's own key encoder, over this pane's terminal. Made with the
   * terminal and freed with it, because it holds a pointer to it — and it is
   * the terminal it reads the active keyboard protocol from on every
   * keystroke, so the two cannot outlive each other.
   */
  private keyEncoder: KeyEncoder | null = null

  /**
   * Ghostty's own mouse encoder, on the same terms as the key one: made with
   * the terminal, freed with it, and reading the tracking mode and wire format
   * from it on every event. Unlike the key encoder it also needs the rendered
   * geometry, which is not terminal state — see `syncMouseSurface`.
   */
  private mouseEncoder: MouseEncoder | null = null

  /** Writes that arrived before the core finished loading. Bytes only: every
   *  write is converted to bytes up front (see write). */
  private writeBuffer: Uint8Array[] = []
  private writeBufferBytes = 0
  /** Whether the render loop may re-fit this engine to its container. Off while
   *  a caller has pinned the grid on purpose — see the poll in the render loop
   *  and `setAutoFit`. */
  private autoFit = true
  private renderLoopId = 0
  private needsRedraw = true
  // The deferred re-fits below outlive a pane that's torn down while its WASM
  // is still loading, so they have to know not to touch a dead engine.
  private disposed = false
  
  get cols(): number { return this._cols }
  get rows(): number { return this._rows }
  get scrollbackLength(): number {
    return this.wasm ? this.wasm.exports.ghostty_terminal_get_scrollback_length(this.termPtr) + this._rows : this._rows
  }
  
  get viewportY(): number {
    return Math.max(0, this.scrollbackLength - this._rows - this._viewportOffset)
  }

  private _cols = 80
  private _rows = 24
  /** Per-pane memory tier, as chosen in Settings. Resolved to a byte budget
   *  when the terminal is built, and fixed from then on. */
  private _scrollbackFootprintMB = DEFAULT_FOOTPRINT_MB
  /** The configured default cursor, resent to the core whenever one is built. */
  private _cursorStyle: CursorStyleSetting = 'block'
  private _cursorBlink = true
  private _themeName: string | null = null
  private _opacity = 1
  private _viewportOffset = 0
  private onScrollHandlers = new Set<(newPos: number) => void>()
  private onWriteParsedHandlers = new Set<() => void>()
  /**
   * Fired after a frame is actually drawn (not on damage-free frames). Only the
   * benchmark harness (src/bench) subscribes; it needs a "a frame was painted"
   * signal to stop its clock at presentation. Kept off the `TerminalEngine`
   * contract for that reason.
   */
  private onRenderHandlers = new Set<() => void>()
  
  /** Mouse selection: drag state, word/line picking, autoscroll, and turning
   *  a selection into text. Assigned in the constructor. */
  private readonly selection: SelectionController
  private onSelectionChangeHandlers = new Set<() => void>()
  /** Keyboard selection. Off unless the user asks for it; while on it takes
   *  the arrow keys, which otherwise belong to the program. */
  private readonly markMode: MarkModeController
  private onMarkModeHandlers = new Set<(active: boolean) => void>()
  /** URLs in the buffer: what is under a cell, and what is on screen. */
  private readonly links: LinkController
  /** Opening a link from the keyboard. Off unless the user asks for it; the
   *  path that works when a program has grabbed the mouse. */
  private readonly hintMode: HintModeController
  private onHintModeHandlers = new Set<(active: boolean) => void>()
  private onLinkActivateHandlers = new Set<(url: string) => void>()
  /** Where the pointer last was, so the hit test can be redone when the
   *  modifier is pressed or released without the mouse having moved. */
  private hoverPointer: { clientX: number; clientY: number } | null = null
  /** The link currently underlined, or null. */
  private hoveredLink: Link | null = null
  /** What the current hover answer was computed against: cell, modifier,
   *  buffer generation and viewport. Recomputing only when this changes is
   *  what keeps detection off the per-mousemove path — the events arrive at
   *  pointer resolution and the answer only changes at cell resolution. */
  private hoverSig = ''
  /** What the painted set of link underlines was computed against — buffer
   *  generation, viewport and width, the same key the hit test caches on. */
  private linkRangesSig = ''
  /** A Ctrl+press that landed on a link, waiting for the release that decides
   *  whether it was a click or the start of a drag. */
  private pendingLink: { url: string; at: { x: number; y: number } } | null = null
  private onCopyRequestHandlers = new Set<(text: string) => void>()
  /** Bytes of an OSC that began in an earlier chunk and has not terminated.
   *  Already parsed; retained only to match the pattern across the boundary. */
  private oscPending: Uint8Array | null = null
  private oscDecoder = new TextDecoder()
  private oscEncoder = new TextEncoder()
  private responseDecoder = new TextDecoder()
  private oscHandlers = new Map<number, ((data: string) => boolean | Promise<boolean>)[]>()
  private onBellHandlers = new Set<() => void>()
  private onBufferChangeHandlers = new Set<(isAlternate: boolean) => void>()
  private lastIsAlternate = false

  /**
   * Why the engine is dead, or null while it is alive. Retained (not just
   * dispatched) so a handler registered after the failure still hears about it:
   * `initWasm` is kicked off by the constructor, so nothing can subscribe
   * before it begins, and a silent engine is exactly the failure mode this
   * exists to make visible.
   *
   * Covers both never-started and died-later. The second case used to have no
   * representation at all — an out-of-memory core kept returning null pointers,
   * every call site did nothing about it, and the pane simply stopped
   * responding with no error anywhere.
   */
  private fatalError: string | null = null
  private onInitErrorHandlers = new Set<(message: string) => void>()

  private onSearchResultHandlers = new Set<(result: SearchResult) => void>()
  /** Find-in-scrollback and its four fields of cache state, which only ever
   *  talked to each other. Assigned in the constructor because its host object
   *  closes over `this`. */
  private readonly searchController: SearchController
  /** Bumped whenever the buffer changes, so a cached search knows it is stale. */
  private bufferGen = 0

  private cursorBlinkOn = true
  private blinkTicks = 0
  private cursorBlinkTimer: ReturnType<typeof setInterval> | null = null
  private focused = false

  /** Mouse reporting: which button is held, the last reported cell, and the
   *  report encoding. Assigned in the constructor — its host closes over
   *  `this`. */
  private readonly mouse: MouseReporter
  /** Scrollback depth as of the last frame, for keeping a scrolled view still. */
  private lastScrollbackCount = 0

  constructor() {
    // Narrow by design: reads of buffer state, plus requests to move or
    // repaint the view. Searching is not allowed to do anything else.
    // All arrow functions, so `this` needs no aliasing and the three reads
    // below stay live rather than being snapshotted here.
    this.mouse = new MouseReporter({
      tracking: () => this.mouseTracking(),
      at: (e) => this.pointerAt(e),
      encoder: () => this.mouseEncoder,
      pixelReporting: () => this.mouseMode(MODE_MOUSE_SGR_PIXELS),
      send: (bytes) => {
        const str = new TextDecoder().decode(bytes)
        for (const h of this.onDataHandlers) h(str)
      },
    })
    this.selection = new SelectionController({
      readRows: (from, to) => this.readRows(from, to),
      coords: (e) => this.getCoords(e),
      canvas: () => this.canvas,
      hasRenderer: () => !!this.renderer,
      setSelection: (sel) => {
        if (this.renderer) this.renderer.selection = sel
        this.needsRedraw = true
      },
      getSelection: () => this.renderer?.selection ?? null,
      scrollLines: (amount) => this.scrollLines(amount),
      emitChange: () => {
        for (const h of this.onSelectionChangeHandlers) h()
      },
      cols: () => this._cols,
    })
    this.markMode = new MarkModeController({
      readRows: (from, to) => this.readRows(from, to),
      cols: () => this._cols,
      rows: () => this._rows,
      totalRows: () => this.scrollbackLength,
      terminalCursor: () => this.terminalCursorCell(),
      setSelection: (sel) => {
        if (this.renderer) this.renderer.selection = sel
        this.needsRedraw = true
      },
      scrollRowIntoView: (row) => this.scrollRowIntoView(row),
      emitChange: () => {
        for (const h of this.onSelectionChangeHandlers) h()
      },
      selectionText: () => this.getSelection(),
      requestCopy: (text) => {
        for (const h of this.onCopyRequestHandlers) h(text)
      },
      notifyMode: (active) => {
        for (const h of this.onMarkModeHandlers) h(active)
      },
    })
    this.links = new LinkController({
      readRows: (from, to) => this.readRows(from, to),
      readWrapFlags: (from, to) => this.readWrapFlags(from, to),
      viewportY: () => this.viewportY,
      rows: () => this._rows,
      totalRows: () => this.scrollbackLength,
      bufferGen: () => this.bufferGen,
      cols: () => this._cols,
    })
    this.hintMode = new HintModeController({
      linksInViewport: () => this.links.linksInViewport(),
      viewport: () => ({ top: this.viewportY, bottom: this.viewportY + this._rows - 1 }),
      cols: () => this._cols,
      setHints: (hints) => {
        if (this.renderer) {
          this.renderer.hintLabels = hints
            ? hints.map((h) => ({ row: h.row, col: h.col, text: h.label }))
            : null
        }
        this.needsRedraw = true
      },
      openLink: (url) => this.activateLink(url),
      notifyMode: (active) => {
        for (const h of this.onHintModeHandlers) h(active)
      },
    })
    this.searchController = new SearchController({
      readRows: (from, to) => this.readRows(from, to),
      readWrapFlags: (total) => this.readWrapFlags(0, total - 1),
      scrollbackLength: () => this.scrollbackLength,
      bufferGen: () => this.bufferGen,
      viewportY: () => this.viewportY,
      setHighlights: (byRow) => {
        if (this.renderer) this.renderer.searchHighlights = byRow
        this.needsRedraw = true
      },
      revealRow: (row) => this.revealRow(row),
      emit: (result) => {
        for (const h of this.onSearchResultHandlers) h(result)
      },
    })
    GhosttyEngine.contexts.add(this)
    // Registered here rather than at module scope so importing the engine has
    // no side effect: if something constructed one, there is state worth
    // reporting. Idempotent — every engine re-registers the same function.
    phases.setContext(GhosttyEngine.formatDiagnostics)
    this.initWasm()
  }

  /**
   * What this page is holding: engines alive, terminals allocated, and the WASM
   * linear memory they hold between them.
   *
   * Each engine gets its own `Instance` and therefore its own linear memory
   * (the module is shared, the instance never is — see moduleCache), so these
   * sum rather than coincide.
   *
   * Reported alongside every throughput figure because of a result neither the
   * workload nor the terminal state explains: the same WASM parses ~2.6x faster
   * in one page session than another, stable within each, while the pure-JS
   * pass over the same bytes barely moves. Two candidates remain — engines
   * accumulating across hot reloads (each with its own memory, spreading the
   * working set) and V8's WASM tier being fixed early — and these numbers tell
   * them apart: the first shows here, the second does not.
   */
  static diagnostics(): { engines: number; terminals: number; wasmBytes: number } {
    let wasmBytes = 0
    let terminals = 0
    for (const e of GhosttyEngine.contexts.all()) {
      if (e.wasm) wasmBytes += e.wasm.exports.memory.buffer.byteLength
      if (e.termPtr !== 0) terminals++
    }
    return { engines: GhosttyEngine.contexts.size, terminals, wasmBytes }
  }

  /**
   * The engine most recently on screen — the pane a devtools-driven flood
   * should target. Ranked by the same `lastVisibleAt` the context budget uses,
   * so "the one you are looking at" wins without the caller needing a handle.
   */
  static activeEngine(): GhosttyEngine | null {
    let best: GhosttyEngine | null = null
    for (const e of GhosttyEngine.contexts.all()) {
      if (!best || GhosttyEngine.contexts.lastVisibleAt(e) > GhosttyEngine.contexts.lastVisibleAt(best)) {
        best = e
      }
    }
    return best
  }

  static formatDiagnostics(): string {
    const d = GhosttyEngine.diagnostics()
    return `page: ${d.engines} live engine(s), ${d.terminals} terminal(s), ${(d.wasmBytes / 1048576).toFixed(1)} MB WASM linear memory`
  }

  private async initWasm() {
    try {
      // Compiled once for the whole app, instantiated per pane — see
      // compileGhosttyWasm. Fetching and compiling here instead put the cost of
      // the entire binary on every pane opened.
      this.wasm = await instantiateGhosttyModule(await compileGhosttyWasm(ghosttyWasmUrl))

      // Colors go in at construction so the core resolves every cell against
      // this theme's palette and defaults, and hands back finished RGB. The
      // renderer therefore never has to know what "color 4" means.
      this.termPtr = createTerminal(this.wasm, this._cols, this._rows, {
        scrollbackLimit: this.scrollbackBudgetBytes,
        ...this.themeConfigColors(),
        // The cursor a RIS returns to. Only the `main` ABI acts on it, where it
        // replaces the reset/DECSCUSR tick comparison in
        // `restoreCursorAfterReset` outright — the core simply keeps the
        // preference across the reset instead of the host putting it back.
        cursorStyle: CONFIG_CURSOR_STYLE[this._cursorStyle],
        cursorBlink: this._cursorBlink,
      })
      if (this.termPtr === 0) {
        this.failInit('Ghostty could not allocate a terminal.')
        return
      }

      // Before the buffered writes below: those writes can carry the very
      // sequence that turns the Kitty protocol on, and an encoder made
      // afterwards would be reading a terminal whose state had already moved.
      // (It reads that state per keystroke, so this is belt and braces — but
      // the ordering is free and the alternative is a rule to remember.)
      this.keyEncoder = KeyEncoder.create(this.wasm, this.termPtr)
      this.mouseEncoder = MouseEncoder.create(this.wasm, this.termPtr)
      // The renderer may already be up (mount runs before this when the module
      // is warm), in which case the geometry is knowable now; if it is not,
      // setupRenderer does this instead.
      this.syncMouseSurface()

      // Before the buffered writes below, so a shape the connection itself sets
      // in its first bytes wins over the preference rather than being undone by
      // it.
      //
      // Written unconditionally. An earlier version skipped this when the
      // preference matched what looked like the core's default, on the
      // assumption that a fresh terminal is a blinking block. It is not: the
      // core leaves DEC mode 12 off, so a fresh cursor is *steady*. Skipping
      // therefore left mode 12 false while the preference said blink, and since
      // the render loop now takes the blink from the core, the cursor stopped
      // blinking at all. The write is one short sequence per pane; there is
      // nothing here worth optimising.
      writeBytes(this.wasm, this.termPtr, this.oscEncoder.encode(
        cursorStyleSequence(this._cursorStyle, this._cursorBlink),
      ))

      // Flush buffered writes. Both branches have to stay synchronous: the
      // parser is a single state machine fed in byte order, so deferring one
      // kind of write by even a microtask replays this buffer out of order.
      for (const data of this.writeBuffer) {
        writeBytes(this.wasm, this.termPtr, data)
      }
      this.writeBuffer = []
      this.writeBufferBytes = 0
      
      if (this.canvas) {
        this.setupRenderer()
      }
    } catch (e) {
      this.failInit(`Ghostty's WASM core failed to load: ${e}`)
    }
  }

  /**
   * Record why the engine is dead and tell anyone listening. Without this the
   * pane just stays blank: every method below no-ops on a null `wasm`, so a
   * failed init is indistinguishable from a terminal with nothing on it yet.
   *
   * Idempotent, because the second report of a dead engine is noise — an OOM
   * core will refuse the very next allocation too.
   */
  private failInit(message: string) {
    if (this.fatalError !== null) return
    this.fatalError = message
    console.error(message)
    for (const cb of this.onInitErrorHandlers) cb(message)
  }

  /**
   * The core has failed part-way through a session rather than at startup.
   *
   * Reported down the same channel as a failed init because it means the same
   * thing to everyone above: this pane is finished, here is why. The render
   * loop stops after this — with the error on screen, which is the difference
   * between a terminal that says it died and one that merely appears hung.
   */
  private failFatal(e: unknown) {
    this.failInit(
      e instanceof GhosttyOutOfMemoryError
        ? `Ghostty's WASM core ran out of memory; this terminal has stopped. (${e.message})`
        : `Ghostty's WASM core failed: ${e}`,
    )
  }

  /**
   * Fires if the engine can't start. Fires immediately on registration when it
   * already has — see `initError`. Not part of `TerminalEngine` as a required
   * member: xterm has no comparable asynchronous startup to fail at.
   */
  onInitError(cb: (message: string) => void): IDisposable {
    this.onInitErrorHandlers.add(cb)
    if (this.fatalError !== null) cb(this.fatalError)
    return { dispose: () => this.onInitErrorHandlers.delete(cb) }
  }

  private setupRenderer() {
    // StrictMode mounts every pane twice in dev, so a pane can be disposed
    // while its WASM fetch is still in flight. Without this the dead engine
    // still builds a renderer, starts a render loop that nothing will ever
    // cancel (its unmount already ran), and re-registers the debug hook —
    // which then reports on a terminal that isn't the one on screen.
    if (this.disposed || !this.canvas || !this.wasm) return
    
    this.renderer = new WebGLRenderer(
      this.canvas,
      this._cols,
      this._rows,
      this.fontFamily,
      this.fontSize
    )
    this.renderer.onRestore = this.onRendererRestored

    if (this._themeName) {
      this.applyThemeToRenderer(this._themeName)
    }

    // Force a fit now that the renderer is available!
    // This fixes the issue where the terminal doesn't fill the screen on first load
    // because the ResizeObserver fired before WASM finished compiling.
    this.fit(true)

    // ...but this fit still races two things that settle *after* the WASM
    // fetch that got us here, and the canvas is only ever sized while a
    // renderer exists, so an early measurement sticks:
    //   - the pane's width. The container is `h-full w-full`, so it inherits
    //     whatever react-resizable-panels computes, and that lands after the
    //     first paint.
    //   - the cell metrics. measureText reports the fallback face until the
    //     configured font has actually loaded.
    // Neither necessarily changes the container's box again afterwards, so
    // Terminal.tsx's ResizeObserver may never fire to correct it — which is
    // why the grid stayed stale until the window was resized by hand. Re-fit
    // on the next frame and once fonts are ready to close both windows.
    requestAnimationFrame(() => {
      if (!this.disposed) this.fit(true)
    })
    document.fonts?.ready
      .then(() => {
        // Re-fitting isn't enough here: the renderer cached its cell metrics
        // (and rasterized its atlas) against whatever face was resolved when
        // it was built. If that was the fallback, those metrics are simply
        // wrong now, so rebuild against the real one.
        if (!this.disposed) this.setFont(this.fontFamily, this.fontSize)
      })
      .catch(() => {})

    this.startRenderLoop()
  }

  private lastSeenW = -1
  private lastSeenH = -1
  private pollCounter = 0
  private restoreRequested = false

  /** Every mounted pane, so the context budget can be shared across them.
   *  See `ContextManager` for why panes give contexts up at all. */
  private static readonly contexts = new ContextManager<GhosttyEngine>()

  private getCoords(e: MouseEvent): {x: number, y: number} {
    if (!this.canvas || !this.renderer) return {x: 0, y: 0}
    const rect = this.canvas.getBoundingClientRect()
    const size = this.renderer.getCellSize()
    const x = Math.floor((e.clientX - rect.left) / size.width)
    let y = Math.floor((e.clientY - rect.top) / size.height)
    const clampedX = Math.max(0, Math.min(x, this._cols - 1))
    const clampedY = Math.max(0, Math.min(y, this._rows - 1))
    const scrollbackCount = this.wasm ? this.wasm.exports.ghostty_terminal_get_scrollback_length(this.termPtr) : 0
    const absY = scrollbackCount - this._viewportOffset + clampedY
    return { x: clampedX, y: absY }
  }

  // A restored context comes back with an empty instance buffer and an empty
  // glyph atlas, so nothing is on screen until something asks for a repaint.
  // The pane may well be idle at that moment, which is exactly when it would
  // otherwise stay blank indefinitely.
  private onRendererRestored = () => {
    this.needsRedraw = true
    this.restoreRequested = false
  }



  /**
   * Reclaims a context. Also covers one the browser took by itself: whatever
   * the reason a pane that should have a context doesn't, asking for it back is
   * the answer.
   */
  ensureContext(): void {
    if (!this.renderer || !this.renderer.isContextLost || this.restoreRequested) return
    this.restoreRequested = true
    this.renderer.restoreContext()
  }

  dropContext(): void {
    if (!this.renderer || this.renderer.isContextLost) return
    this.restoreRequested = false
    this.renderer.releaseContext()
  }

  /**
   * One timer for both blinks. The cursor only blinks in a focused pane, and
   * blinking text runs at half that rate — roughly the cadence a terminal has
   * always used for the attribute, and slow enough not to be a strobe.
   *
   * A tick only forces a repaint when there is something whose appearance
   * depends on it. Otherwise every pane in the window would redraw twice a
   * second forever, which is the opposite of the damage-driven loop's point.
   */
  private onBlinkTick = () => {
    let changed = false
    if (this.focused) {
      this.cursorBlinkOn = !this.cursorBlinkOn
      if (this.renderer?.cursor) changed = true
    }
    if (++this.blinkTicks % 2 === 0 && this.renderer) {
      this.renderer.blinkOn = !this.renderer.blinkOn
      if (this.renderer.sawBlinkingCell) changed = true
    }
    if (changed) this.needsRedraw = true
  }

  /**
   * DEC mode 1004. A program that turned it on wants to know when it has the
   * keyboard — editors use it to re-read a file that changed underneath them,
   * and shells to redraw a prompt.
   */
  private reportFocus(focused: boolean) {
    if (!this.mouseMode(MODE_FOCUS_REPORTING)) return
    const seq = focused ? '\x1b[I' : '\x1b[O'
    for (const h of this.onDataHandlers) h(seq)
  }

  private onFocus = () => {
    this.focused = true
    // Coming back mid-blink would otherwise show a gap where the cursor is.
    this.cursorBlinkOn = true
    this.needsRedraw = true
    this.reportFocus(true)
  }

  private onBlur = () => {
    this.focused = false
    this.needsRedraw = true
    // A button or drag released outside the window never reaches us (the window
    // mouseup that would end it fires while another window has focus). Left set,
    // a stuck "still held" keeps reporting drags on the next hover, and a stuck
    // "still selecting" leaves the pane in a selection that swallows clicks and
    // typing until something else clears it — the wedge after a native prompt.
    this.mouse.forgetButton()
    this.selection.cancel()
    this.stopDragTracking()
    // The modifier's release will be delivered to whatever has focus now, not
    // here, so an armed hover would stay armed for as long as the pane is
    // untouched.
    this.clearLinkHover()
    this.pendingLink = null
    this.reportFocus(false)
  }

  /**
   * Keeps a scrolled-back view looking at the same text as output arrives.
   *
   * The offset is measured up from the bottom, so every row that lands pushes
   * what you were reading off the top of the pane — the view creeps forward on
   * its own while you are trying to read it. Growing the offset by however much
   * the scrollback grew holds the content still. Once the buffer is full it
   * stops growing and the oldest rows start falling off instead, at which point
   * nothing can hold a position that is itself being discarded.
   */
  private pinViewport(scrollbackCount: number) {
    const grew = scrollbackCount - this.lastScrollbackCount
    this.lastScrollbackCount = scrollbackCount
    if (grew <= 0 || this._viewportOffset === 0) return
    const pinned = Math.min(this._viewportOffset + grew, scrollbackCount)
    if (pinned === this._viewportOffset) return
    this._viewportOffset = pinned
    for (const h of this.onScrollHandlers) h(this.viewportY)
  }

  private scrollToBottom() {
    if (this._viewportOffset === 0) return
    this._viewportOffset = 0
    this.needsRedraw = true
    for (const h of this.onScrollHandlers) h(this.viewportY)
  }

  /**
   * Hands back whatever the terminal owes the host — cursor position reports,
   * device attributes, and the rest of the queries a shell or TUI makes on
   * startup. Nothing drained these before, so every such query went unanswered
   * and the program waited out its timeout instead.
   */
  private drainResponses() {
    if (!this.wasm || !this.termPtr) return
    // Bounded because a reply is itself sent as input: a far end that answers
    // one query with another could otherwise keep this loop fed forever.
    for (let i = 0; i < 64; i++) {
      const out = readResponse(this.wasm, this.termPtr)
      if (!out || out.length === 0) return
      const str = this.responseDecoder.decode(out)
      for (const h of this.onDataHandlers) h(str)
    }
  }

  /**
   * Text for a range of absolute buffer rows — scrollback rows first, then the
   * active screen, the same numbering the renderer draws from.
   *
   * Copy, word selection and search all need exactly this, and each had (or
   * would have had) its own partial version of the cell walk — including the
   * spacer and grapheme handling that made copied text wrong.
   *
   * This used to return `string[][]`, one JS string per cell. A full-scrollback
   * search at 10,000 rows x 200 columns allocated ~2M short strings plus 10k
   * arrays, and every caller then joined them straight back together — a GC
   * event on the first keystroke of a search, sitting oddly next to the
   * single-allocation buffer strategy in the rest of this function.
   *
   * A row is now its joined text plus an index of where each column starts in
   * it. That's strictly more useful than a bare string: a column can hold more
   * than one character (a grapheme cluster) or none at all (the trailing half
   * of a wide character), so search still needs to map an offset back to a
   * column, and `columnText` still answers "what does column `c` show".
   * Nothing materialises a per-cell string unless it actually needs one, and
   * the two bulk callers no longer need any.
   */
  private readRows(fromAbs: number, toAbs: number): RowText[] {
    const out: RowText[] = []
    if (!this.wasm || !this.termPtr) return out
    const wasm = this.wasm
    const wasmCols = wasm.exports.ghostty_render_state_get_cols(this.termPtr)
    const wasmRows = wasm.exports.ghostty_render_state_get_rows(this.termPtr)
    const scrollbackCount = wasm.exports.ghostty_terminal_get_scrollback_length(this.termPtr)
    if (wasmCols <= 0) return out

    const cellCount = wasmCols * wasmRows
    const viewSize = cellCount * CELL_BYTES
    const lineSize = wasmCols * CELL_BYTES
    // Grapheme clusters run to a handful of codepoints in practice; anything
    // longer is truncated rather than grown for, since the cost is one buffer
    // held for the whole walk.
    const gCap = 16
    // One scratch cell for the whole walk. Not per-frame like the renderer's,
    // but a scrollback-wide search still walks hundreds of thousands of cells
    // in one go, and the object never escapes the loop body.
    const cell = emptyCell()

    // Raising beats the old `return out` on a null pointer: that handed copy
    // and search a page of blanks and called it the buffer's contents.
    const viewPtr = allocBufferOrThrow(wasm, viewSize)
    wasm.exports.ghostty_render_state_get_viewport(this.termPtr, viewPtr, cellCount)
    const linePtr = allocBufferOrThrow(wasm, lineSize)
    const gPtr = allocBufferOrThrow(wasm, gCap * 4)

    // Every view is built after the last allocation: growing WASM memory
    // detaches the buffer any earlier one was made against.
    const viewV = new DataView(wasm.exports.memory.buffer, viewPtr, viewSize)
    const lineV = linePtr !== 0 ? new DataView(wasm.exports.memory.buffer, linePtr, lineSize) : null
    const gV = gPtr !== 0 ? new DataView(wasm.exports.memory.buffer, gPtr, gCap * 4) : null

    for (let abs = fromAbs; abs <= toAbs; abs++) {
      // `colStart` has one more entry than there are columns, so column `c`
      // always spans `[colStart[c], colStart[c + 1])` with no special case for
      // the last one.
      const colStart = new Int32Array(this._cols + 1)
      let text = ''
      // A row that can't be read stays blank rather than absent, so absolute
      // row numbering survives — callers index `out` by offset from `fromAbs`.
      const blank = (): RowText => {
        let s = ''
        for (let c = 0; c < this._cols; c++) {
          colStart[c] = c
          s += ' '
        }
        colStart[this._cols] = this._cols
        return { text: s, colStart }
      }
      if (abs < 0) {
        out.push(blank())
        continue
      }

      let isScrollback = false
      let activeRow = 0
      if (abs < scrollbackCount) {
        if (!lineV) {
          out.push(blank())
          continue
        }
        wasm.exports.ghostty_terminal_get_scrollback_line(this.termPtr, abs, linePtr, wasmCols)
        isScrollback = true
      } else {
        activeRow = abs - scrollbackCount
        if (activeRow >= wasmRows) {
          out.push(blank())
          continue
        }
      }

      const view = isScrollback ? lineV! : viewV
      let c = 0
      for (; c < this._cols && c < wasmCols; c++) {
        colStart[c] = text.length
        const offset = isScrollback ? c * CELL_BYTES : (activeRow * wasmCols + c) * CELL_BYTES
        parseCellInto(view, offset, cell)
        if (cell.width === 0) {
          // Trailing half of a wide character: it has no text of its own, so
          // its span is empty and the next column starts at the same offset.
          continue
        }
        if (cell.graphemeLen > 0 && gV) {
          const n = isScrollback
            ? wasm.exports.ghostty_terminal_get_scrollback_grapheme(this.termPtr, abs, c, gPtr, gCap)
            : wasm.exports.ghostty_render_state_get_grapheme(this.termPtr, activeRow, c, gPtr, gCap)
          if (n > 0) {
            for (let i = 0; i < n && i < gCap; i++) text += String.fromCodePoint(gV.getUint32(i * 4, true))
            continue
          }
        }
        text += cell.codepoint > 0 ? String.fromCodePoint(cell.codepoint) : ' '
      }
      // Columns past what the core reports still exist as far as every caller
      // is concerned — they're the blank right-hand edge — so they get a space
      // each, exactly as the `.fill(' ')` this replaces gave them.
      for (; c < this._cols; c++) {
        colStart[c] = text.length
        text += ' '
      }
      colStart[this._cols] = text.length
      out.push({ text, colStart })
    }

    if (gPtr !== 0) wasm.exports.ghostty_wasm_free_u8_array(gPtr, gCap * 4)
    if (linePtr !== 0) wasm.exports.ghostty_wasm_free_u8_array(linePtr, lineSize)
    wasm.exports.ghostty_wasm_free_u8_array(viewPtr, viewSize)
    return out
  }

  /** Is the program on the far end asking to be told about the mouse at all? */
  private mouseTracking(): boolean {
    return !!this.wasm && this.wasm.exports.ghostty_terminal_has_mouse_tracking(this.termPtr) !== 0
  }

  private mouseMode(mode: number): boolean {
    return !!this.wasm && this.wasm.exports.ghostty_terminal_get_mode(this.termPtr, mode, 0) !== 0
  }

  /**
   * Where the pointer is, for mouse reporting: surface pixels, plus the cell
   * they fall in.
   *
   * The pixels are clamped into the surface rather than passed through. A
   * drag that has left the pane still reports — against the edge cell, which
   * is what every terminal does and what the selection code alongside this
   * already assumes — and an unclamped position outside the surface encodes
   * to nothing at all, so the drag would simply go quiet.
   *
   * The canvas is the whole surface here: it is sized to the grid, so there
   * is no padding to describe and the two origins coincide.
   */
  /**
   * Hands the encoder the rendered geometry it converts pixel positions
   * against. Called wherever that geometry can change — the core coming up,
   * the renderer being set up, and every resize.
   *
   * No padding: the canvas is sized to the grid, so the surface and the grid
   * share an origin. If a pane ever grows a gutter, that is the number to fill
   * in here rather than to subtract at the call sites.
   */
  private syncMouseSurface(): void {
    if (!this.mouseEncoder || !this.renderer) return
    const cell = this.renderer.getCellSize()
    this.mouseEncoder.setSurface({
      screenWidth: this._cols * cell.width,
      screenHeight: this._rows * cell.height,
      cellWidth: cell.width,
      cellHeight: cell.height,
    })
  }

  private pointerAt(e: MouseEvent): MousePoint | null {
    if (!this.canvas || !this.renderer) return null
    const rect = this.canvas.getBoundingClientRect()
    const size = this.renderer.getCellSize()
    const x = Math.max(0, Math.min(e.clientX - rect.left, this._cols * size.width - 1))
    const y = Math.max(0, Math.min(e.clientY - rect.top, this._rows * size.height - 1))
    return {
      x,
      y,
      col: Math.floor(x / size.width) + 1,
      row: Math.floor(y / size.height) + 1,
    }
  }

  private onMouseUp = (e: MouseEvent) => {
    // Before anything else clears its state: a Ctrl+press that landed on a
    // link opens it *here*, not on the press. Opening on mousedown would mean
    // a Ctrl+drag that happens to begin on a link launches a browser, and
    // Ctrl+drag has to keep doing what it does today.
    const pending = this.pendingLink
    this.pendingLink = null
    if (pending && this.withinCanvas(e)) {
      const at = this.getCoords(e)
      if (at.x === pending.at.x && at.y === pending.at.y) this.activateLink(pending.url)
    }

    this.mouse.reportRelease(e)
    this.stopDragTracking()
    if (this.selection.isSelecting()) {
      this.selection.cancel()
      for (const h of this.onSelectionChangeHandlers) h()
    }
  }

  /** Whether the pointer is over the grid. `getCoords` clamps to it, so a
   *  release well outside would otherwise resolve to an edge cell and could
   *  match the cell a press began on. */
  private withinCanvas(e: MouseEvent): boolean {
    if (!this.canvas) return false
    const rect = this.canvas.getBoundingClientRect()
    return (
      e.clientX >= rect.left && e.clientX < rect.right && e.clientY >= rect.top && e.clientY < rect.bottom
    )
  }

  /**
   * The modifier that makes the pointer a link pointer.
   *
   * Ctrl, and Meta so the same gesture reads as Cmd+click on a Mac. Not
   * Shift: shift already means "this click is the terminal's, not the
   * program's" and, separately, "extend the selection", and a third meaning
   * cannot be resolved against those two without one of them feeling broken.
   * Every terminal that ships this — Windows Terminal, VTE, WezTerm, VS Code,
   * Ghostty itself — uses Ctrl or Cmd for exactly that reason.
   */
  private static linkModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
    return e.ctrlKey || e.metaKey
  }

  /**
   * Recomputes what the pointer is over, if anything about the answer could
   * have changed.
   *
   * The signature is the gate: mousemove arrives at pointer resolution and the
   * answer only changes at cell resolution, so an ordinary sweep across a link
   * costs one hit test per cell rather than one per event. An ordinary session
   * never holds the modifier over the grid and never pays anything at all.
   */
  private refreshLinkHover(armed: boolean): void {
    if (!armed || !this.hoverPointer || !this.renderer) {
      this.hoverSig = ''
      this.setHoveredLink(null)
      return
    }
    const cell = this.getCoords(this.hoverPointer as MouseEvent)
    const sig = `${cell.x},${cell.y},${this.bufferGen},${this.viewportY}`
    if (sig === this.hoverSig) return
    this.hoverSig = sig
    this.setHoveredLink(this.links.linkAt(cell))
  }

  /**
   * Keeps the dotted underline over every link on screen up to date.
   *
   * This is the one part of the feature that is *not* on demand, and it is
   * deliberate: a link nobody can see is a link nobody will ever hold Ctrl
   * over, so hover-only feedback makes the whole gesture undiscoverable. The
   * cost is bounded by the same cache the hit test uses — the signature below
   * is the controller's own key, so a still buffer costs one string
   * comparison per frame and a changing one costs a single viewport parse per
   * generation, not per frame and never per cell.
   *
   * Detection still does not run on the parse path: `write()` is untouched,
   * and its only coupling to this is the `bufferGen` counter that was already
   * there for search.
   */
  private refreshLinkRanges(): void {
    if (!this.renderer) return
    const sig = `${this.bufferGen}:${this.viewportY}:${this._cols}`
    if (sig === this.linkRangesSig) return
    this.linkRangesSig = sig
    const ranges = this.links.linksInViewport().flatMap((l) => l.segments)
    // An empty screen keeps `null` rather than an empty array, so the
    // renderer's per-row filter is skipped entirely on the common case of a
    // pane with no links in it.
    this.renderer.linkRanges = ranges.length > 0 ? ranges : null
    this.needsRedraw = true
  }

  private setHoveredLink(link: Link | null): void {
    const before = this.hoveredLink
    const same =
      (before === null && link === null) ||
      (before !== null &&
        link !== null &&
        before.url === link.url &&
        before.segments[0].row === link.segments[0].row &&
        before.segments[0].from === link.segments[0].from)
    this.hoveredLink = link
    if (same) return
    if (this.renderer) this.renderer.linkHighlight = link ? link.segments : null
    this.needsRedraw = true
    // Cleared to the empty string rather than a name, so the stylesheet's own
    // cursor for the canvas comes back.
    if (this.canvas) this.canvas.style.cursor = link ? 'pointer' : ''
  }

  /** Pointer gone, or focus gone: the underline and the pointer cursor must go
   *  with it, or a pane the mouse has left keeps claiming to have a link
   *  under it. */
  private clearLinkHover(): void {
    this.hoverPointer = null
    this.hoverSig = ''
    this.setHoveredLink(null)
  }

  /** A stable reference, so mount and unmount add and remove the same one. */
  private clearLinkHoverListener = () => this.clearLinkHover()

  /** Modifier pressed or released without the mouse moving. The keys are
   *  otherwise none of this handler's business — it reads the modifier state
   *  off whatever key event arrives and does nothing when nothing changed. */
  private onHoverModifierKey = (e: KeyboardEvent) => {
    if (!this.hoverPointer) return
    this.refreshLinkHover(GhosttyEngine.linkModifier(e))
  }

  /**
   * Hands a URL to whatever is hosting this engine.
   *
   * The scheme is checked again here even though detection only ever produced
   * `http`/`https`: this is the last point before the string reaches the
   * platform opener, the two are far apart in the code, and an OSC 8 URI
   * (later) never passes through detection at all. On Windows the cost of
   * being wrong is not a broken link — a `file://` or UNC-flavoured target can
   * provoke an outbound SMB authentication attempt and leak credentials to a
   * host of the attacker's choosing.
   *
   * The engine does not open it itself: every other platform interaction is
   * the frontend's, and the engine has no platform dependency today.
   */
  private activateLink(url: string): void {
    if (!isOpenableUrl(url)) return
    for (const h of this.onLinkActivateHandlers) h(url)
  }

  /**
   * Carries a drag on past the edges of the pane.
   *
   * The canvas stops delivering `mousemove` the moment the pointer leaves it,
   * and "the pointer is outside the canvas" is the exact condition the
   * selection's autoscroll waits for — so bound to the canvas alone the
   * autoscroll could never arm, and a drag could only ever cover what was
   * already on screen. Listening on the window for the length of the drag is
   * what lets the pointer get far enough out to be measured.
   *
   * Bound and unbound rather than left on permanently, so a pane that isn't
   * being dragged in does no work per mouse move. Both calls are idempotent —
   * the same function reference registers once and unregisters whether or not
   * it was there — which is why neither needs a flag guarding it.
   */
  private startDragTracking(): void {
    window.addEventListener('mousemove', this.onWindowMouseMove)
  }

  private stopDragTracking(): void {
    window.removeEventListener('mousemove', this.onWindowMouseMove)
  }

  /**
   * A key one of the modes claimed is a key nothing else may see: one that
   * both moved the mark cursor and reached the shell would be doing two
   * contradictory things at once.
   *
   * Hint mode is offered the key first, because it is the shorter-lived of the
   * two — it is a mode you are in for the length of one label. Only one can be
   * active at a time in practice (each cancels the other on entry), so the
   * order is about intent rather than arbitration.
   */
  private onMarkModeKey = (e: KeyboardEvent) => {
    if (!this.hintMode.handleKey(e) && !this.markMode.handleKey(e)) return
    e.preventDefault()
    e.stopPropagation()
  }

  private onWindowMouseMove = (e: MouseEvent) => {
    // A button released outside the window never delivers mouseup here, and a
    // selection left believing it is still being dragged keeps the autoscroll
    // timer running — the pane scrolls on its own and cannot be stopped.
    // `buttons` is the live state rather than an event history, so it catches
    // exactly that.
    if (e.buttons === 0) {
      this.onMouseUp(e)
      return
    }
    if (!this.selection.drag(e)) this.stopDragTracking()
  }

  /**
   * One frame's work, split out so the loop below can own the error handling.
   *
   * Everything in here can throw now that a refused allocation raises instead
   * of returning a null pointer, and this used to run inline in the loop with
   * the `requestAnimationFrame` reschedule as its last statement — so a single
   * throw skipped the reschedule and the pane never painted again, silently,
   * for the rest of its life.
   */
  private renderFrame() {
    if (!this.wasm || !this.renderer) return

    // Safety net for the initial sizing race. The ResizeObserver in
    // Terminal.tsx is supposed to catch the pane settling to its real width,
    // but it demonstrably doesn't for the first layout, and a grid that misses
    // that moment stays cropped until the window is resized by hand. Sampling
    // the container here can't miss a settle whenever it happens. Throttled to
    // roughly every 6th frame, and it only measures — the fit below runs solely
    // when the box actually changed, so a steady pane costs nothing.
    if (this.container && ++this.pollCounter % 6 === 0) {
      const w = this.container.clientWidth
      const h = this.container.clientHeight
      if ((w !== this.lastSeenW || h !== this.lastSeenH) && w > 0 && h > 0) {
        this.lastSeenW = w
        this.lastSeenH = h
        // Skipped when the grid was pinned deliberately. Pinning to a size
        // larger than the container makes the canvas overflow, which relays out
        // the page, which changes the container box — so this poll would
        // measure the consequence of the pin and undo it on the next frame. A
        // benchmark asking for 200x60 silently ran at 5x18 that way, and the
        // resulting "geometry does not matter" reading was measured entirely
        // below 2,000 cells while a real pane runs ~10,000.
        if (this.autoFit) this.fit()
      }
      GhosttyEngine.contexts.noteVisibility(this, w > 0 && h > 0)
    }

    // Which cells are links at all, for the dotted underline that makes them
    // discoverable without holding a modifier over them first.
    this.refreshLinkRanges()

    // An underlined link can be scrolled away or overwritten under a pointer
    // that never moved, and the underline would sit on whatever took its
    // place. Only checked while something is actually underlined, so a pane
    // nobody is hovering pays nothing — and the hit test behind it is cached
    // per buffer generation and viewport, so a still buffer costs one string
    // comparison.
    if (this.hoveredLink) this.refreshLinkHover(true)

    // A pane with no context has nowhere to draw, and the snapshot work below
    // is the bulk of a frame. Leaving needsRedraw set means the pane repaints
    // in full the moment it gets a context back.
    if (this.needsRedraw && !this.renderer.isContextLost) {
      // update() rebuilds the render snapshot and has to run before the
      // viewport is read; mark_clean() afterwards resets the damage state.
      this.wasm.exports.ghostty_render_state_update(this.termPtr)
      const scrollbackCount = this.wasm.exports.ghostty_terminal_get_scrollback_length(this.termPtr)
      this.pinViewport(scrollbackCount)
      // Read after update() and before the viewport, same as the cells: these
      // come off the same snapshot, and sampling them either side of it puts
      // the cursor a frame away from the text it's sitting in.
      const cursorVisible = this.wasm.exports.ghostty_render_state_get_cursor_visible(this.termPtr) !== 0
      const cursorCol = this.wasm.exports.ghostty_render_state_get_cursor_x(this.termPtr)
      const cursorRow = this.wasm.exports.ghostty_render_state_get_cursor_y(this.termPtr)
      // DECSCUSR carries blink as well as shape (1/3/5 blink, 2/4/6 are
      // steady), and honouring only the shape made every steady variant blink
      // anyway. The phase is still ours — the core says *whether* to blink, the
      // timer says when — so a steady cursor is simply always on.
      const cursorBlinks =
        this.wasm.exports.ghostty_render_state_get_cursor_blinking(this.termPtr) !== 0
      this.renderer.cursor = cursorVisible
        ? {
            col: cursorCol,
            row: cursorRow,
            on: cursorBlinks ? this.cursorBlinkOn : true,
            focused: this.focused,
            // DECSCUSR. Read off the same snapshot as the position above, for
            // the same reason: a shape sampled either side of update() belongs
            // to a different frame than the cell it is drawn on.
            shape: this.wasm.exports.ghostty_render_state_get_cursor_style(this.termPtr),
          }
        : null
      // Keeps the IME's candidate window with the text being composed.
      if (this.inputHandler) {
        const cell = this.renderer.getCellSize()
        this.inputHandler.setCursorPosition(cursorCol * cell.width, cursorRow * cell.height)
      }
      this.renderer.updateStaticGrid(this.wasm, this.termPtr, this._viewportOffset, scrollbackCount)
      this.wasm.exports.ghostty_render_state_mark_clean(this.termPtr)
      this.needsRedraw = false
      // After the draw this frame, so the harness's present clock sees exactly
      // the frames that changed the canvas. Skipped on idle frames above.
      if (this.onRenderHandlers.size > 0) {
        for (const h of this.onRenderHandlers) h()
      }
    }
  }

  private startRenderLoop = () => {
    // Nothing left to draw with, or into: end the loop rather than spin on it.
    // This guard was the first line of the frame body before the two were
    // split, and it has to stay a *loop* condition — an unmounted pane whose
    // rAF still reschedules is a leak that outlives the pane.
    if (!this.wasm || !this.renderer) return
    try {
      this.renderFrame()
    } catch (e) {
      // An exhausted core will refuse the next frame's allocation too, so
      // there is nothing to come back for: report it and let the loop end,
      // with the pane showing why. Anything else is treated as transient —
      // one bad frame shouldn't cost the pane its render loop — so it is
      // logged and the loop carries on below.
      if (e instanceof GhosttyOutOfMemoryError) {
        this.failFatal(e)
        return
      }
      console.error('Ghostty render frame failed:', e)
    }
    this.renderLoopId = requestAnimationFrame(this.startRenderLoop)
  }

  mount(element: HTMLElement): void {
    this.container = element
    
    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.top = '0'
    this.canvas.style.left = '0'
    this.canvas.style.outline = 'none'
    this.canvas.style.display = 'block'
    // A <canvas>, like an <img>, is draggable as an image by default: a click
    // that moves a pixel starts a native image-drag of the pane, which shows the
    // no-drop cursor and a grey drag-image and steals focus/input until it ends
    // (and WebView2 won't cancel it on Esc). We run our own selection off mouse
    // events, so the native drag is pure harm — turn it off at the source.
    this.canvas.draggable = false
    this.canvas.style.userSelect = 'none'
    this.canvas.style.setProperty('-webkit-user-select', 'none')
    this.canvas.style.setProperty('-webkit-user-drag', 'none')

    this.container.appendChild(this.canvas)

    this.canvas.addEventListener('wheel', (e) => {
      // A program that asked for mouse reporting gets the wheel as buttons 4/5,
      // which is how less and htop page without a scrollback of their own.
      if (this.mouse.tracking() && !e.shiftKey) {
        e.preventDefault()
        // Whichever axis the gesture is mostly on. A trackpad reports both at
        // once, and a program that asked for the mouse is entitled to the
        // horizontal one — the encoder has had buttons for it all along.
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          this.mouse.reportWheelHorizontal(e, e.deltaX < 0)
        } else {
          this.mouse.reportWheel(e, e.deltaY < 0)
        }
        return
      }
      // There is no scrollback to move through on the alternate screen, so the
      // event is left alone there rather than swallowed — preventDefault with
      // no scroll of our own is how the wheel ends up doing nothing at all.
      const isAlt = this.wasm && this.wasm.exports.ghostty_terminal_is_alternate_screen(this.termPtr) !== 0
      if (isAlt) return
      e.preventDefault()
      let lines = e.deltaY
      if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
        lines = e.deltaY / 20
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        lines = e.deltaY * this._rows
      }
      this.scrollLines(Math.sign(lines) * Math.max(1, Math.abs(Math.round(lines))))
    }, { passive: false })

    window.addEventListener('mouseup', this.onMouseUp)

    // Capture, on the container: the input element is a child of it, so this
    // sees a key before the handler that would turn it into a sequence on the
    // wire. Mark mode is the only thing here that can consume a key, and it
    // consumes none at all while it is off.
    this.container.addEventListener('keydown', this.onMarkModeKey, true)

    // Only a focused pane blinks. A wall of panes all blinking out of phase is
    // noise, and it also means an idle background pane never wakes the loop.
    this.cursorBlinkTimer = setInterval(this.onBlinkTick, CURSOR_BLINK_MS)

    this.canvas.addEventListener('mousedown', (e) => {
      // A Ctrl+press on a link is the one case that outranks mouse reporting:
      // it is what the modifier exists for, and the program does not see the
      // click. Everything else about this handler is untouched — in
      // particular shift keeps both of its current meanings, and a Ctrl+press
      // that is *not* on a link falls through to whatever it does today.
      //
      // Only the first click of a run arms it: a Ctrl+double-click already
      // opened the link on the first release, and the second would open it
      // again while also selecting a word.
      if (e.button === 0 && e.detail === 1 && GhosttyEngine.linkModifier(e)) {
        const at = this.getCoords(e)
        const link = this.links.linkAt(at)
        if (link) {
          this.pendingLink = { url: link.url, at }
          e.preventDefault()
          this.inputHandler?.focus()
          // Under mouse reporting there is no selection to begin, so the press
          // stops here rather than falling through to code that would report
          // it. With the mouse free it falls through, so a Ctrl+drag from a
          // link still selects exactly as it does today.
          if (this.mouse.tracking()) return
        }
      }
      // Holding shift is the long-standing way to reach the terminal's own
      // selection while a full-screen program is grabbing the mouse.
      if (this.mouse.tracking() && !e.shiftKey) {
        e.preventDefault()
        this.inputHandler?.focus()
        this.mouse.reportPress(e)
        return
      }
      // Keep the keyboard on the input element. A plain mousedown on the
      // (non-focusable) canvas otherwise lets the browser move focus off the
      // invisible textarea — which is why clicking a pane that already had focus
      // wedged it (no keystrokes, no blink) until a tab switch refocused it, and
      // how a right-click-to-paste used to lose typing. preventDefault stops that
      // focus shift (and any native selection/drag we handle ourselves); the
      // explicit focus() is what actually holds the keyboard. Both are needed.
      e.preventDefault()
      this.inputHandler?.focus()
      if (e.button !== 0) return // Only handle left-click for selection

      // The mouse is taking the selection over, so the keyboard has to let go
      // of it — otherwise the arrow keys stay captured while pointing at a
      // selection the drag has already replaced. Hint mode goes for the same
      // reason: a press means the pointer is the tool being used, and its
      // labels are painted over the text the drag is about to select.
      this.markMode.cancel()
      this.hintMode.cancel()
      // `detail` counts clicks in a run, which is how the platform already
      // decides what a double-click is — no timing to reimplement here.
      if (e.detail === 2) {
        this.selection.selectWordAt(this.getCoords(e))
        return
      }
      if (e.detail >= 3) {
        this.selection.selectLineAt(this.getCoords(e))
        return
      }
      // Shift extends the existing selection from its anchor rather than
      // starting a new one — the same gesture every text surface uses.
      //
      // Only while the program is leaving the mouse alone, though. Under mouse
      // reporting, shift is already spoken for: it is what takes this drag off
      // the program and gives it to the terminal (see the top of this handler),
      // so it cannot also carry "extend" — and reading it that way meant that
      // once any selection existed, every later shift-drag was anchored to that
      // first selection's start instead of to where the button went down. There
      // was no gesture left that could begin a new selection, which is what made
      // selecting under a full-screen program feel like it had stopped working.
      // Losing extend-by-shift-click there is the right trade: a fresh drag is
      // the gesture that has to work.
      if (e.shiftKey && !this.mouse.tracking() && this.renderer?.selection && this.selection.hasAnchor()) {
        this.selection.extendFromAnchor(e)
        this.startDragTracking()
        return
      }
      this.selection.begin(e)
      this.startDragTracking()
    })

    this.canvas.addEventListener('mousemove', (e) => {
      this.hoverPointer = { clientX: e.clientX, clientY: e.clientY }
      this.refreshLinkHover(GhosttyEngine.linkModifier(e))
      // A shift-drag is the user talking to the terminal, not to the program,
      // so a selection in progress suppresses reporting entirely.
      if (this.mouse.tracking() && !this.selection.isSelecting()) {
        this.mouse.reportMotion(e)
      }
      // Extending a drag is not handled here: it runs off the window listener
      // for as long as the button is down, so that it keeps going once the
      // pointer leaves the canvas. This handler would only ever see the part of
      // the gesture that is already on screen.
    })

    this.canvas.addEventListener('mouseleave', this.clearLinkHoverListener)
    // On the window rather than the container: the modifier can be released
    // while the pointer rests over this pane but the keyboard is elsewhere,
    // and a pointer cursor left behind by a release nobody heard is exactly
    // the state that makes the feature feel stuck.
    window.addEventListener('keydown', this.onHoverModifierKey)
    window.addEventListener('keyup', this.onHoverModifierKey)

    this.inputHandler = new GhosttyInputHandler(this.container, (data) => {
      // Typing while scrolled up otherwise sends keystrokes to a prompt that
      // isn't on screen.
      this.scrollToBottom()
      // Input handler gives Uint8Array, convert to string since onData expects string in TerminalEngine
      const str = new TextDecoder().decode(data)
      for (const handler of this.onDataHandlers) {
        handler(str)
      }
      for (const handler of this.onInputHandlers) {
        handler(str)
      }
    }, () => this.keyEncoder)
    // Focus now lives on the input handler's element, so that is what the pane
    // has to watch to know whether it is the one being typed into.
    this.inputHandler.element.addEventListener('focus', this.onFocus)
    this.inputHandler.element.addEventListener('blur', this.onBlur)

    if (this.wasm) {
      this.setupRenderer()
    }
  }

  unmount(): void {
    cancelAnimationFrame(this.renderLoopId)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('keydown', this.onHoverModifierKey)
    window.removeEventListener('keyup', this.onHoverModifierKey)
    this.canvas?.removeEventListener('mouseleave', this.clearLinkHoverListener)
    this.container?.removeEventListener('keydown', this.onMarkModeKey, true)
    this.clearLinkHover()
    this.links.invalidate()
    this.linkRangesSig = ''
    this.stopDragTracking()
    this.markMode.cancel()
    this.hintMode.cancel()
    this.selection.dispose()
    if (this.cursorBlinkTimer !== null) {
      clearInterval(this.cursorBlinkTimer)
      this.cursorBlinkTimer = null
    }
    this.inputHandler?.dispose()
    if (this.canvas && this.container) {
      this.container.removeChild(this.canvas)
    }
    this.renderer?.dispose()
    this.renderer = null
  }

  dispose(): void {
    this.disposed = true
    GhosttyEngine.contexts.remove(this)
    this.unmount()
    // Every pane is its own WASM instance; leaving this unfreed leaked the
    // core's page memory for the terminal's whole scrollback budget on every
    // closed pane.
    if (this.wasm && this.termPtr) {
      // The encoder first: it holds this terminal's pointer, and freeing the
      // terminal out from under it would leave a live object pointing at
      // released memory.
      this.mouseEncoder?.dispose()
      this.mouseEncoder = null
      this.keyEncoder?.dispose()
      this.keyEncoder = null
      this.wasm.exports.ghostty_terminal_free(this.termPtr)
      this.termPtr = 0
    }
    this.onDataHandlers.clear()
    this.onInputHandlers.clear()
    this.onResizeHandlers.clear()
    this.onScrollHandlers.clear()
    this.onWriteParsedHandlers.clear()
    this.onRenderHandlers.clear()
    this.onSelectionChangeHandlers.clear()
    this.onBellHandlers.clear()
    this.oscHandlers.clear()
    this.oscPending = null
  }

  /**
   * Whether the render loop is allowed to re-fit this engine to its container.
   *
   * A pane wants this on: the container is the truth and the grid should follow
   * it. A benchmark pinning a grid wants it off, because a pinned size larger
   * than the container is deliberate — the canvas is expected to overflow and
   * the host to clip, and re-fitting would silently replace the size under
   * measurement with whatever the resulting layout happened to produce.
   *
   * Explicit `fit()` calls are unaffected; this governs only the automatic poll.
   */
  setAutoFit(on: boolean): void {
    this.autoFit = on
  }

  resize(cols: number, rows: number, force = false): void {
    if (cols === this._cols && rows === this._rows && !force) return
    this._cols = cols
    this._rows = rows
    this.needsRedraw = true
    
    if (this.wasm && this.termPtr) {
      this.wasm.exports.ghostty_terminal_resize(this.termPtr, cols, rows)
      // A resize can itself provoke a reply from modes the program set up.
      this.drainResponses()
    }
    if (this.renderer) {
      this.renderer.resize(cols, rows, force)
    }
    // After the renderer, whose cell size is what this reads. A stale surface
    // reports the wrong cell for every event, which is the kind of wrong that
    // looks like the program misbehaving rather than the terminal.
    this.syncMouseSurface()

    for (const handler of this.onResizeHandlers) {
      handler({ cols, rows })
    }
  }

  // A second pass over every byte, in JavaScript, to recover the two events the
  // core doesn't surface yet (OSC dispatch and the bell). That cost is the
  // opposite of what this engine exists for, so it is skipped outright unless
  // something is actually listening — an un-integrated shell registers no OSC
  // handlers and pays nothing. Not deletable by exporting the events the core
  // already parses: OSC 633 has no ident in Ghostty's parser at all, so it would
  // have to be taught one first — see the header of `oscScanner.ts`.
  /** Hands one run of bytes to the parser, or queues it if the core is still
   *  loading. Buffered slices are copied: they outlive the caller's chunk. */
  private parseSegment(seg: Uint8Array): void {
    if (seg.length === 0) return
    if (!this.wasm) {
      // The core is still loading, so hold the bytes for initWasm to replay.
      //
      // Bounded, and fatal past the bound, because the unbounded version failed
      // silently and expensively. A core that never resolves leaves `wasm` null
      // and `fatalError` null forever, so every write lands here: the pane stays
      // blank, each write returns promptly having parsed nothing, and a copy of
      // every byte is retained. A benchmark run in that state fed 300 MB into
      // this array and reported the fastest parse ever recorded, because the
      // instrument counted bytes handed to `write` and no phase timer was ever
      // entered. Nothing logged, and it survived for weeks.
      //
      // A pane legitimately buffers only what arrives before the core is up —
      // a shell banner, at most a burst — so a megabyte here already means the
      // core is not coming, and saying so beats accumulating quietly.
      phases.recordUnparsed(seg.length)
      this.writeBufferBytes += seg.length
      if (this.writeBufferBytes > MAX_PREREADY_BYTES) {
        this.writeBuffer = []
        this.writeBufferBytes = 0
        this.failInit(
          `Ghostty's WASM core never finished loading: ${(MAX_PREREADY_BYTES / 1048576).toFixed(0)} MB ` +
            'of output arrived with no parser to take it. Nothing written to this terminal has been parsed.',
        )
        return
      }
      this.writeBuffer.push(seg.slice())
      return
    }
    const wasm = this.wasm
    phases.time('parse', () => writeBytes(wasm, this.termPtr, seg))
  }

  /** Fires onBufferChange if the screen buffer flipped since it was last read.
   *  Called between parse segments so a handler never sees a stale buffer. */
  private notifyBufferChange(): void {
    if (!this.wasm) return
    const isAlt = this.wasm.exports.ghostty_terminal_is_alternate_screen(this.termPtr) !== 0
    if (isAlt === this.lastIsAlternate) return
    this.lastIsAlternate = isAlt
    for (const h of this.onBufferChangeHandlers) h(isAlt)
  }

  /**
   * Parses `bytes`, dispatching OSC and bell events at the point each one
   * actually occurs in the stream.
   *
   * The parser is fed in segments split at each recognised sequence, so a
   * handler runs only once everything preceding it — including that sequence —
   * has been parsed, which is what a real parser callback would give. The
   * previous shape scanned the whole chunk up front and dispatched before
   * parsing any of it, handing every handler a terminal state from *before* the
   * chunk: anything correlating a sequence with screen state was silently wrong
   * (see the note on registerOscHandler).
   *
   * The scan itself is a pure function (see oscScanner) so its grammar and
   * cross-chunk bookkeeping can be tested without a core or a DOM. Scanning
   * bytes rather than a decoded string is what makes the split safe — the
   * offsets it returns are byte offsets into this exact buffer, so segments can
   * be sliced without a bytes→string→bytes round trip (which would mangle
   * invalid UTF-8) and without mapping char indices back onto bytes. It also
   * drops the full-chunk decode the old scanner did on every write; only
   * payloads, which are short, are decoded now.
   */
  private parseAndDispatch(bytes: Uint8Array): void {
    // Timed apart from the parse it feeds: this is a full JS pass over every
    // byte, taken only because a handler is registered, and the harness — which
    // registers none — never pays it. That asymmetry is the first suspect for
    // the harness/production throughput gap.
    const { events, pending } = phases.time('scan', () =>
      scanOsc(bytes, this.oscPending, this.oscDecoder),
    )
    this.oscPending = pending

    let cursor = 0 // how much of `bytes` has reached the parser
    for (const ev of events) {
      if (ev.segEnd > cursor) {
        this.parseSegment(bytes.subarray(cursor, ev.segEnd))
        cursor = ev.segEnd
      }
      // Screen state has to be current before a handler runs — the whole point
      // of splitting the parse here.
      phases.time('bufferChange', () => this.notifyBufferChange())
      if (ev.kind === 'bell') {
        phases.time('handlers', () => {
          for (const h of this.onBellHandlers) h()
        })
        continue
      }
      const handlers = this.oscHandlers.get(ev.ident)
      if (!handlers) continue
      phases.time('handlers', () => {
        for (const h of handlers) {
          // A handler claiming the sequence stops the others for this ident. It
          // cannot stop the core, which parses the bytes regardless — see
          // registerOscHandler.
          if (h(ev.payload) === true) break
        }
      })
    }

    if (cursor < bytes.length) this.parseSegment(bytes.subarray(cursor))
  }

  // Every write has to reach the parser synchronously and in call order. PTY
  // output arrives here as bytes and local messages (writeln, the line editor)
  // as strings; routing the string case through a dynamic `import()` put it a
  // microtask behind every byte write issued after it, so a status line could
  // land in the middle of a later chunk and leave that chunk's SGR state
  // applied to output it was never meant to color.
  write(data: Uint8Array | string): void {
    // A dead core cannot be written to, and the parser's state machine is
    // already desynchronised from the stream by whatever it refused. Dropping
    // the rest quietly is fine here *because* the failure was reported once,
    // loudly, at the point it happened.
    if (this.fatalError !== null) return
    this.needsRedraw = true
    this.bufferGen++

    // Strings (writeln, the line editor) and PTY bytes take one path:
    // writeString is itself writeBytes(encode(str)), so unifying costs nothing
    // and lets a single byte-level scanner serve both without a second pending
    // buffer for the string case.
    const bytes = typeof data === 'string' ? this.oscEncoder.encode(data) : data
    // Whole-write span, so the phases below can be stated as shares of it and
    // anything they fail to account for shows up as unattributed rather than
    // silently vanishing.
    const startedAt = phases.now()

    // The core can refuse to allocate anywhere in here. Caught rather than
    // propagated because the caller is a PTY data callback with nowhere to put
    // an exception; the failure is recorded and reported instead, and the guard
    // at the top of this method makes every later write a no-op.
    try {
      if (this.oscHandlers.size > 0 || this.onBellHandlers.size > 0) {
        this.parseAndDispatch(bytes)
      } else {
        this.parseSegment(bytes)
      }

      // Drained here rather than on the frame: a reply is only correct for the
      // state that provoked it, and a cursor-position report that waits for the
      // next repaint can describe a cursor that has already moved on.
      phases.time('drain', () => this.drainResponses())
    } catch (e) {
      this.failFatal(e)
      phases.recordWrite(bytes.length, phases.now() - startedAt)
      return
    }
    // Checked on the write that could have caused it rather than per frame:
    // switching screens is a parse-time event, and an idle pane shouldn't be
    // asking the core about it sixty times a second. parseAndDispatch already
    // checks between segments; this catches a change in the trailing one.
    phases.time('bufferChange', () => this.notifyBufferChange())
    phases.time('handlers', () => {
      for (const h of this.onWriteParsedHandlers) h()
    })
    phases.recordWrite(bytes.length, phases.now() - startedAt)
  }

  writeln(data: string): void {
    this.write(data + '\r\n')
  }

  /**
   * Benchmark-only counterpart to xterm's async `parse`. Ghostty parses
   * synchronously inside `write`, so the work is already done by the time this
   * returns; it is chunked purely to avoid a single multi-megabyte WASM
   * allocation (which fragments the heap and slows successive rounds), and it
   * deliberately does not yield — the point is to time an uninterrupted parse.
   */
  parse(data: Uint8Array | string): Promise<void> {
    const CHUNK = 131072
    if (typeof data !== 'string' && data.length > CHUNK) {
      for (let i = 0; i < data.length; i += CHUNK) {
        this.write(data.subarray(i, Math.min(i + CHUNK, data.length)))
      }
    } else {
      this.write(data)
    }
    return Promise.resolve()
  }

  /**
   * Whether the text can go straight to the wire, or whether the user should
   * be asked first. See `pasteIsSafe` — it catches an embedded
   * bracketed-paste terminator, which counting lines cannot.
   *
   * Null when there is no core to ask, which leaves the decision to the
   * caller rather than guessing "safe" on its behalf.
   */
  isPasteSafe(text: string): boolean | null {
    if (!this.wasm || !hasPasteEncoder(this.wasm)) return null
    return pasteIsSafe(this.wasm, text)
  }

  paste(text: string): void {
    if (!this.wasm) return
    // Paste can arrive from a menu or a shortcut handled above this engine, and
    // whatever served it may have taken the keyboard on the way. Text landing
    // in a pane that then ignores every keystroke reads as the terminal having
    // hung.
    this.inputHandler?.focus()
    this.scrollToBottom()
    // The one piece of terminal state the encoder does not read for itself.
    const bracketed =
      this.wasm.exports.ghostty_terminal_get_mode(this.termPtr, MODE_BRACKETED_PASTE, 0) !== 0
    // Concatenating the brackets by hand is what this replaced: it pasted an
    // embedded terminator straight through, which ends the bracket early and
    // delivers the rest as typing.
    const payload = new TextDecoder().decode(encodePaste(this.wasm, text, bracketed))
    // Fire it as input data to be sent to the backend PTY
    for (const handler of this.onDataHandlers) {
      handler(payload)
    }
    for (const handler of this.onInputHandlers) {
      handler(payload)
    }
  }

  onData(handler: (data: string) => void): IDisposable {
    this.onDataHandlers.add(handler)
    return { dispose: () => this.onDataHandlers.delete(handler) }
  }

  onInput(handler: (data: string) => void): IDisposable {
    this.onInputHandlers.add(handler)
    return { dispose: () => this.onInputHandlers.delete(handler) }
  }

  onWriteParsed(cb: () => void): IDisposable {
    this.onWriteParsedHandlers.add(cb)
    return { dispose: () => this.onWriteParsedHandlers.delete(cb) }
  }
  /** See `onRenderHandlers` — benchmark-only paint signal. */
  onRender(cb: () => void): IDisposable {
    this.onRenderHandlers.add(cb)
    return { dispose: () => this.onRenderHandlers.delete(cb) }
  }
  onScroll(cb: (newPos: number) => void): IDisposable {
    this.onScrollHandlers.add(cb)
    return { dispose: () => this.onScrollHandlers.delete(cb) }
  }
  onBufferChange(cb: (isAlternate: boolean) => void): IDisposable {
    this.onBufferChangeHandlers.add(cb)
    return { dispose: () => this.onBufferChangeHandlers.delete(cb) }
  }
  onBell(cb: () => void): IDisposable {
    this.onBellHandlers.add(cb)
    return { dispose: () => this.onBellHandlers.delete(cb) }
  }

  onSelectionChange(cb: () => void): IDisposable {
    this.onSelectionChangeHandlers.add(cb)
    return { dispose: () => this.onSelectionChangeHandlers.delete(cb) }
  }
  
  /**
   * Subscribe to an OSC ident.
   *
   * Two differences from the xterm engine's version, both because this engine
   * recovers OSC by scanning the byte stream rather than from parser callbacks
   * the core does not expose yet:
   *
   * - Returning `true` stops the remaining handlers for this ident, but does
   *   *not* consume the sequence: the bytes still reach the core, which may act
   *   on them as well. There is no way to suppress that from here. (A promise is
   *   never treated as a claim — async consumption isn't supported.)
   * - The handler runs at the point the sequence occurs in the stream, with
   *   everything before it already parsed, so reading engine state is sound.
   *   That was *not* true before: handlers used to be dispatched for a whole
   *   chunk before any of it was parsed, so state read here lagged by a chunk.
   *   Prefer correlating with a dedicated event (onBufferChange) over reading
   *   state in a handler anyway — it survives the eventual move to core
   *   callbacks, whose dispatch point may differ again.
   */
  registerOscHandler(ident: number, cb: (data: string) => boolean | Promise<boolean>): IDisposable {
    let handlers = this.oscHandlers.get(ident)
    if (!handlers) {
      handlers = []
      this.oscHandlers.set(ident, handlers)
    }
    handlers.push(cb)
    return {
      dispose: () => {
        const idx = handlers!.indexOf(cb)
        if (idx !== -1) handlers!.splice(idx, 1)
      },
    }
  }
  onSearchResult(cb: (result: SearchResult) => void): IDisposable {
    this.onSearchResultHandlers.add(cb)
    return { dispose: () => this.onSearchResultHandlers.delete(cb) }
  }

  fit(force = false): void {
    if (!this.container || this.disposed) return

    // The renderer sizes the canvas as `cols * its own cellWidth`, so cols has
    // to be derived from that same width. Measuring independently here let the
    // two drift apart — the renderer caches its metrics at construction, which
    // for a font that hasn't resolved yet means the fallback face — and once
    // they disagree no amount of re-fitting or window-resizing can make the
    // canvas fill the container. Measure directly only as a fallback, so a
    // pane can still fit itself before WASM has produced a renderer.
    let cellWidth: number
    let cellHeight: number
    if (this.renderer) {
      const size = this.renderer.getCellSize()
      cellWidth = size.width
      cellHeight = size.height
    } else {
      const size = measureCell(this.fontFamily, this.fontSize)
      cellWidth = size.width
      cellHeight = size.height
    }

    const rect = this.container.getBoundingClientRect()
    const { cols: c, rows: r } = fitGrid(
      rect,
      { width: cellWidth, height: cellHeight },
      SCROLLBAR_GUTTER_PX,
    )
    if (c > 0 && r > 0) {
      this.resize(c, r, force)
    }
  }
  
  refresh(_start: number, _end: number): void {}
  scrollLines(amount: number): void {
    const maxOffset = Math.max(0, this.scrollbackLength - this._rows)
    let offset = this._viewportOffset - amount
    offset = Math.max(0, Math.min(offset, maxOffset))
    if (this._viewportOffset !== offset) {
      this._viewportOffset = offset
      this.needsRedraw = true
      for (const h of this.onScrollHandlers) h(this.viewportY)
    }
  }

  scrollToLine(line: number): void {
    const maxScroll = Math.max(0, this.scrollbackLength - this._rows)
    line = Math.max(0, Math.min(line, maxScroll))
    const offset = maxScroll - line
    if (this._viewportOffset !== offset) {
      this._viewportOffset = offset
      this.needsRedraw = true
      for (const h of this.onScrollHandlers) h(this.viewportY)
    }
  }

  /** The 16 ANSI slots, in the order both OSC 4 and the config struct expect. */
  private themePalette(theme: TerminalTheme): string[] {
    return [
      theme.black, theme.red, theme.green, theme.yellow,
      theme.blue, theme.magenta, theme.cyan, theme.white,
      theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
      theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
    ]
  }

  /** Current theme as the 0xRRGGBB ints the terminal config takes. */
  private themeConfigColors() {
    const theme = findTheme(this._themeName ?? '')
    const toInt = (hex: string) => {
      const [r, g, b] = hexToRgb(hex)
      return (r << 16) | (g << 8) | b
    }
    return {
      fgColor: toInt(theme.foreground),
      bgColor: toInt(theme.background),
      cursorColor: toInt(theme.cursor),
      palette: this.themePalette(theme).map(toInt),
    }
  }

  // A live theme change can only reach part of the way down. The core resolves
  // each cell's color from the palette it was built with, exposes no setter for
  // it, and rejects the OSC sequences that would otherwise do the job ("OSC 10
  // requires an allocator, but none was provided"), so recolouring already-
  // parsed cells is out without recreating the terminal and losing scrollback.
  //
  // What does carry over is the default foreground/background, which is most of
  // a typical screen: the renderer maps cells still sitting on the core's
  // default onto the current theme (see updateStaticGrid). Text explicitly
  // painted from the ANSI palette keeps the palette this pane was opened with
  // until it scrolls away; new panes pick the theme up in full.
  setTheme(themeName: string, opacity: number): void {
    this._themeName = themeName
    this._opacity = opacity

    if (this.renderer) {
      this.applyThemeToRenderer(themeName)
      // The grid is only rebuilt on damage, so without this an idle pane keeps
      // its old palette until the next byte arrives.
      this.needsRedraw = true
    }
  }

  // Opacity rides along with the colors rather than having its own setter: the
  // two are re-applied together every time a renderer is built, and splitting
  // them meant a font change (which builds a fresh renderer) silently reset the
  // pane to fully opaque.
  private applyThemeToRenderer(themeName: string) {
    if (!this.renderer) return
    const theme = findTheme(themeName)
    const [fr, fg, fb] = hexToRgb(theme.foreground)
    const [br, bg, bb] = hexToRgb(theme.background)
    this.renderer.setTheme(fr, fg, fb, br, bg, bb, this._opacity)
    const [cr, cg, cb] = hexToRgb(theme.cursor)
    this.renderer.setCursorColor(cr, cg, cb)
  }
  /**
   * The cursor a pane shows until the remote application says otherwise.
   *
   * Written into the terminal as DECSCUSR rather than held beside it, so the
   * core stays the single source of truth for what the cursor is and an
   * application that sets its own shape simply overwrites this — which is the
   * precedence a preference should have.
   *
   * Reapplied by the caller on a settings change. A reset does not need it:
   * the core is told this preference at construction
   * (`TerminalConfig.cursorStyle`) and returns to it after a RIS by itself,
   * which is what replaced the reset/DECSCUSR tick comparison the host used to
   * do here. A preference changed *after* a pane opens therefore reaches the
   * live cursor immediately but not that pane's reset default, which is the one
   * seam left in this.
   */
  setCursorStyle(style: CursorStyleSetting, blink: boolean): void {
    this._cursorStyle = style
    this._cursorBlink = blink
    if (this.termPtr) this.write(cursorStyleSequence(style, blink))
  }

  setFont(fontFamily: string, fontSize: number): void {
    this.fontFamily = fontFamily
    this.fontSize = fontSize
    if (this.renderer && this.canvas) {
      this.renderer.dispose()
      this.renderer = new WebGLRenderer(this.canvas, this._cols, this._rows, fontFamily, fontSize)
      this.renderer.onRestore = this.onRendererRestored
      // A fresh renderer starts on its own grey-on-black defaults, and those
      // are what every cell *without* an explicit SGR color renders as. Losing
      // the theme here therefore recolors exactly the default-colored text
      // while explicitly-colored text keeps its palette — which reads as the
      // terminal's colors shifting on their own.
      if (this._themeName) this.applyThemeToRenderer(this._themeName)
      // The replacement renderer starts with an empty instance buffer, so an
      // idle pane would sit blank until its next write without this.
      this.needsRedraw = true
      // A new face means new cell metrics, so the grid that fit the old ones
      // no longer fills the container.
      this.fit(true)
    }
  }
  // The core takes its scrollback limit at construction and exposes no setter,
  // so a change here only takes effect for panes opened afterwards. Recreating
  // the terminal to apply it live would throw away the scrollback it governs.
  //
  // Landing before the terminal exists is the normal case rather than a race:
  // Terminal.tsx calls this synchronously on the new engine, and the terminal
  // isn't built until the WASM fetch resolves.
  setScrollbackBudget(footprintMB: number): void {
    this._scrollbackFootprintMB = footprintMB
  }

  /** The byte budget this pane was built with — the *engine's* figure, not the
   *  current setting. The status bar derives its row estimate from this
   *  precisely because they diverge: changing the setting leaves open panes on
   *  the budget they were constructed with, and deriving from the setting would
   *  show a depth those panes will never reach. */
  get scrollbackBudgetBytes(): number {
    return scrollbackBudgetBytesFor(this._scrollbackFootprintMB)
  }
  rebuildWebglRenderer(): void {}

  /**
   * xterm's SearchAddon came free; this is the replacement. It scans the whole
   * buffer — scrollback and active screen — one row at a time.
   *
   * Matches are found per visual row rather than per logical line, so a hit
   * straddling a wrap point is missed. Reassembling wrapped rows needs
   * `is_row_wrapped`, which is only answerable for the active screen and not
   * for scrollback, so the honest choice was to search what is on screen the
   * way it is on screen.
   */
  search(query: string, options?: SearchOptions): void {
    this.searchController.search(query, options)
  }

  /**
   * Which of the absolute rows `fromAbs..toAbs` continue the row above them.
   *
   * One call per row, which sounds worse than it is: search already reads
   * every row it asks about, and caches the answer behind the same
   * query/buffer signature its matches are cached behind. Link detection asks
   * about a viewport's worth, which is where the range form earns its keep —
   * the whole-buffer form would be reading ten thousand rows to underline one.
   */
  private readWrapFlags(fromAbs: number, toAbs: number): boolean[] {
    const out = new Array<boolean>(Math.max(0, toAbs - fromAbs + 1)).fill(false)
    if (!this.wasm || !this.termPtr) return out
    const wasm = this.wasm
    const scrollbackCount = wasm.exports.ghostty_terminal_get_scrollback_length(this.termPtr)
    for (let abs = Math.max(0, fromAbs); abs <= toAbs; abs++) {
      out[abs - fromAbs] =
        abs < scrollbackCount
          ? wasm.exports.ghostty_terminal_is_scrollback_row_wrapped(this.termPtr, abs) !== 0
          : wasm.exports.ghostty_terminal_is_row_wrapped(this.termPtr, abs - scrollbackCount) !== 0
    }
    return out
  }

  /**
   * Matches over *logical* lines, not visual rows.
   *
   * A wrapped line is several rows on screen but one line of text, and
   * searching row by row missed anything straddling the wrap. That used to be
   * unavoidable: the core answered `is_row_wrapped` only for the active screen,
   * so a hit that had scrolled into history could not be reassembled. Our own
   * shim now exports the scrollback form too, so rows are joined into the line
   * they belong to before matching.
   *
   * A match still highlights per row — it has to, the rows are apart on screen
   * — so each carries the segments it covers, while navigation treats it as the
   * single hit it is.
   */
  /** Scrolls the viewport the least amount that brings `row` into view. */
  private revealRow(row: number) {
    const top = this.viewportY
    if (row >= top && row < top + this._rows) return
    const maxScroll = Math.max(0, this.scrollbackLength - this._rows)
    // Parked a third of the way down, so there is context above the hit as well
    // as below it.
    const target = Math.max(0, Math.min(row - Math.floor(this._rows / 3), maxScroll))
    this.scrollToLine(target)
  }

  /**
   * Scrolls the least amount that puts absolute `row` on screen.
   *
   * Deliberately not `revealRow`: that parks its target a third of the way down
   * so a search hit has context around it, which is right for a jump and wrong
   * for a cursor being walked one line at a time — the pane would lurch on
   * every arrow key.
   */
  private scrollRowIntoView(row: number): void {
    const top = this.viewportY
    if (row < top) this.scrollToLine(row)
    else if (row >= top + this._rows) this.scrollToLine(row - this._rows + 1)
  }

  /** Where the terminal's own cursor is, in absolute buffer coordinates. The
   *  core reports it relative to the active screen, which always sits at the
   *  end of the buffer however far the view is scrolled back. */
  private terminalCursorCell(): { x: number; y: number } {
    if (!this.wasm) return { x: 0, y: 0 }
    const screenTop = Math.max(0, this.scrollbackLength - this._rows)
    return {
      x: this.wasm.exports.ghostty_render_state_get_cursor_x(this.termPtr),
      y: screenTop + this.wasm.exports.ghostty_render_state_get_cursor_y(this.termPtr),
    }
  }

  /**
   * Turns keyboard selection on or off. See `MarkModeController` for why it is
   * a mode at all rather than a shift-arrow binding.
   */
  toggleMarkMode(): void {
    if (!this.renderer) return
    this.markMode.toggle()
  }

  isMarkMode(): boolean {
    return this.markMode.isActive()
  }

  onMarkModeChange(cb: (active: boolean) => void): IDisposable {
    this.onMarkModeHandlers.add(cb)
    return { dispose: () => this.onMarkModeHandlers.delete(cb) }
  }

  /**
   * Turns hint mode on or off.
   *
   * Worth having beside Ctrl+click rather than instead of it: this is the only
   * path that works while a full-screen program owns the mouse, and the only
   * one that works with no pointing device at all.
   */
  toggleHintMode(): void {
    if (!this.renderer) return
    // The two modes both take the keyboard, and a mark cursor left behind a
    // screen of labels is a captured keyboard with nothing on screen to
    // explain it.
    if (!this.hintMode.isActive()) this.markMode.cancel()
    this.hintMode.toggle()
  }

  isHintMode(): boolean {
    return this.hintMode.isActive()
  }

  onHintModeChange(cb: (active: boolean) => void): IDisposable {
    this.onHintModeHandlers.add(cb)
    return { dispose: () => this.onHintModeHandlers.delete(cb) }
  }

  onCopyRequest(cb: (text: string) => void): IDisposable {
    this.onCopyRequestHandlers.add(cb)
    return { dispose: () => this.onCopyRequestHandlers.delete(cb) }
  }

  /** A link was activated and wants opening. See `activateLink` for why the
   *  engine asks rather than opens. */
  onLinkActivate(cb: (url: string) => void): IDisposable {
    this.onLinkActivateHandlers.add(cb)
    return { dispose: () => this.onLinkActivateHandlers.delete(cb) }
  }

  /**
   * The URL under a pointer event, or null.
   *
   * For the frontend's context menu, which is the discoverable path for
   * anyone who never learns the modifier — the same reason VTE has it. It
   * costs one menu item over machinery the hover path already built.
   */
  linkAtPointer(e: MouseEvent): string | null {
    if (!this.renderer || !this.withinCanvas(e)) return null
    return this.links.linkAt(this.getCoords(e))?.url ?? null
  }

  /** Opens a URL that came back from `linkAtPointer`, subject to the same
   *  scheme check every other route takes. */
  openLink(url: string): void {
    this.activateLink(url)
  }

  clearSearchDecorations(): void {
    this.searchController.clear()
  }

  onResize(handler: (size: { cols: number; rows: number }) => void): IDisposable {
    this.onResizeHandlers.add(handler)
    return { dispose: () => this.onResizeHandlers.delete(handler) }
  }

  focus(): void {
    // A programmatic refocus (tab switch, window/app return) is where a stranded
    // IME composition gets cleared — an app switch can leave `composing` stuck
    // true with no blur/compositionend, dropping all printable input afterwards.
    // Plain clicks focus via the input handler directly and skip this, so an
    // in-window click mid-composition is left untouched.
    this.inputHandler?.cancelComposition()
    this.inputHandler?.focus()
  }

  /** See TerminalEngine.resetInputContext. */
  resetInputContext(): void {
    this.inputHandler?.resetForRefocus()
  }

  clearSelection(): void {
    // Whatever is dropping the selection is also ending keyboard selection —
    // the mark cursor is drawn *as* the selection, so leaving the mode on would
    // leave a captured keyboard with nothing on screen to show for it.
    this.markMode.cancel()
    // Guarded here rather than in the controller: "there was nothing to
    // clear" must not fire a change notification.
    if (!this.renderer || !this.renderer.selection) return
    this.selection.reset()
  }
  getSelection(): string {
    if (!this.renderer || !this.renderer.selection || !this.wasm) return ''
    return this.selection.text()
  }

  selectAll(): void {
    if (!this.renderer || !this.wasm) return
    const scrollbackCount = this.wasm.exports.ghostty_terminal_get_scrollback_length(this.termPtr)
    this.selection.selectAll(scrollbackCount + this._rows)
  }
}
