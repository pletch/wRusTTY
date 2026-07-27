import type { TerminalEngine, SearchOptions, SearchResult } from '../terminalEngine'
import type { SearchHighlight } from './WebGLRenderer'
import type { IDisposable } from '@xterm/xterm'
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
  MODE_APP_CURSOR_KEYS,
  MODE_BRACKETED_PASTE,
  MODE_MOUSE_BUTTON_EVENT,
  MODE_MOUSE_ANY_EVENT,
  MODE_MOUSE_SGR,
  MODE_FOCUS_REPORTING,
  allocBufferOrThrow,
  GhosttyOutOfMemoryError,
  type GhosttyWasm,
  CELL_BYTES,
} from './wasmBindings'
import { GhosttyInputHandler } from './GhosttyInputHandler'
// A locally-built binary, not the one `ghostty-web` publishes: it layers three
// unmerged upstream PRs (coder/ghostty-web#142, #176, #177) onto the commit
// package.json pins, none of which had shipped in any release at build time.
// See vendor/README.md for what each fixes and how to rebuild or revert.
import ghosttyWasmUrl from './vendor/ghostty-vt.wasm?url'

/** xterm's blink period, so the two engines don't visibly differ. */
const CURSOR_BLINK_MS = 530

/**
 * How many panes may hold a GL context at once.
 *
 * Browsers cap live WebGL contexts at around sixteen, so the ceiling is real,
 * but it is only worth doing anything about once it is close. Below this, every
 * pane keeps its context and switching tabs never rebuilds anything — which is
 * the common case and should cost nothing. Above it, the least recently seen
 * panes give theirs up.
 */
const CONTEXT_BUDGET = 8

/** Rate-limits the shared pass below; it runs once per interval, not per pane. */
const RECONCILE_INTERVAL_MS = 100

/** Autoscroll cadence while a selection is dragged past the edge of a pane. */
const DRAG_SCROLL_INTERVAL_MS = 50
const DRAG_SCROLL_MAX_LINES = 8

/**
 * `scrollbackLimit` in the core's config is a **line count**, and the value has
 * to stay small enough that the core's own lines→bytes conversion doesn't
 * overflow.
 *
 * This was previously computed as a *byte* budget, which is what an older
 * revision of the WASM API took. The current core multiplies the value by its
 * per-line page cost with `std.math.mul(usize, lines, bytes_per_line)` — and
 * `usize` is 32-bit on `wasm32`, so a byte-shaped value like 8,000,000 overflows
 * and lands on the `catch std.math.maxInt(usize)` fallback, which means
 * *unlimited*. The limit silently stopped existing: a 100 MB flood retained all
 * 1.15 M rows and grew the WASM heap to ~2 GB, until an allocation failed and
 * the pane wedged. Passing a line count keeps the multiply in range and the
 * budget enforced (verified: 100 MB drains with the heap flat at ~9 MB).
 *
 * The ceiling is derived rather than picked, for the same reason the old byte
 * budget had one: the limit is committed for the life of the pane and every
 * pane is its own WASM instance, so an unguarded setting is a per-pane memory
 * multiplier across a window full of sessions. Measured against this build the
 * core spends ~12.4–12.65 bytes per cell per retained line, near-flat from 40 to
 * 400 columns; 13 is that rounded up, which biases the cap conservative (a
 * higher per-cell estimate yields *fewer* permitted lines). Lines are therefore
 * only as promised at the width the pane was opened at — widening it later
 * trades lines for columns out of the same ceiling, which is how Ghostty itself
 * behaves.
 *
 * The number asked for is an upper bound, not a promise. The core evicts whole
 * pages rather than single lines, so the retained count settles at or somewhat
 * below the request — measured here, 1000 lines at 80 columns holds ~680 and
 * 5000 holds ~4200. Its own `PageList.maxSize` calls the figure a heuristic and
 * declines to be asserted on, so this side does not try to correct for it: the
 * ceiling is what matters, and padding the request to hit a round number would
 * be guesswork against page geometry that varies with width.
 */
const SCROLLBACK_BYTES_PER_CELL = 13
const SCROLLBACK_MAX_BYTES = 64 * 1024 * 1024
const SCROLLBACK_MIN_LINES = 100

/** How much output may pile up waiting for the core to load before the engine
 *  gives up and says so. See parseSegment — the unbounded version of this hid a
 *  never-loading core behind a blank pane and a lying throughput figure. */
const MAX_PREREADY_BYTES = 1024 * 1024

export function scrollbackLinesFor(lines: number, cols: number): number {
  const maxLines = Math.floor(SCROLLBACK_MAX_BYTES / (Math.max(1, cols) * SCROLLBACK_BYTES_PER_CELL))
  return Math.min(Math.max(Math.floor(lines), SCROLLBACK_MIN_LINES), maxLines)
}

/**
 * One search hit. `row`/`from`/`to` are its head, which is all a match that
 * does not wrap ever needs; `segments` is every row it covers, so a hit across
 * a wrapped line highlights on each of them while still counting once.
 */
interface SearchMatch {
  row: number
  from: number
  to: number
  segments: { row: number; from: number; to: number }[]
}

/**
 * One buffer row, as `readRows` hands it over: the text of every column
 * concatenated, plus where each column begins in it.
 *
 * `colStart` has `cols + 1` entries, so column `c` is always
 * `text.slice(colStart[c], colStart[c + 1])` with no special case for the
 * last column. A span can be longer than one character (a grapheme cluster)
 * or empty (the trailing half of a wide character), which is exactly the
 * information a plain `string` would have thrown away and a `string[]` per
 * cell paid ~2M allocations to keep.
 */
interface RowText {
  text: string
  colStart: Int32Array
}

/** What column `c` shows. Empty for a wide character's trailing spacer. */
function columnText(row: RowText, c: number): string {
  if (c < 0 || c + 1 >= row.colStart.length) return ''
  return row.text.slice(row.colStart[c], row.colStart[c + 1])
}

/**
 * What counts as one word for double-click. Deliberately wider than
 * alphanumerics: the things worth grabbing out of a terminal in one gesture
 * are paths, flags, hostnames and URLs, and stopping at every `/` or `.`
 * turns picking up a path into several drags.
 *
 * Hoisted to module scope so the literal isn't recompiled per call — V8
 * handles the inline form well, but the word scan calls this once per column
 * and a module-level constant is free.
 */
const WORD_RE = /[A-Za-z0-9_\-./:@~+=%?&#]/

/**
 * Whether a full reset has discarded the configured cursor and nothing has
 * claimed it since.
 *
 * Split out from the engine because it is the whole of the decision and the
 * rest is plumbing — and because the cases are combinations of two ticks,
 * which is miserable to reach through a live core and a DOM.
 *
 * Deliberately holds no "already handled" state. Restoring writes DECSCUSR,
 * which moves `styleAt` past `resetAt`, so the second condition below is what
 * stops this firing again on every subsequent write. A separate handled-marker
 * would be a second mechanism for the same thing, and dead the moment the first
 * one works.
 *
 * @param resetAt core tick of the last RIS; 0 if there has never been one
 * @param styleAt core tick of the last DECSCUSR; 0 if there has never been one
 */
export function shouldRestoreCursor(resetAt: number, styleAt: number): boolean {
  // Never reset: nothing to put back.
  if (resetAt === 0) return false
  // Something set the cursor at or after the reset — an application choosing
  // its own, which outranks a preference. Common: a TUI resets and then asks
  // for the cursor it wants, both inside one write.
  return styleAt <= resetAt
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
  private onResizeHandlers = new Set<(size: { cols: number; rows: number }) => void>()
  private inputHandler: GhosttyInputHandler | null = null
  
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
  private _scrollback = 1000
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
  
  private isSelecting = false
  private selectionStart: {x: number, y: number} | null = null
  /** Where the current selection was begun, so shift-click can extend from it. */
  private selectionAnchor: {x: number, y: number} | null = null
  private selectionRectangular = false
  private dragScrollTimer: ReturnType<typeof setInterval> | null = null
  private dragScrollLines = 0
  private dragScrollAt: { clientX: number; clientY: number } | null = null
  private onSelectionChangeHandlers = new Set<() => void>()
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
  private searchMatches: SearchMatch[] = []
  private searchIndex = -1
  private searchSignature = ''
  private searchGen = -1
  /** Bumped whenever the buffer changes, so a cached search knows it is stale. */
  private bufferGen = 0

  private cursorBlinkOn = true
  private blinkTicks = 0
  private cursorBlinkTimer: ReturnType<typeof setInterval> | null = null
  private focused = false

  private mouseButtonDown: number | null = null
  private lastMouseCol = -1
  private lastMouseRow = -1
  /** Scrollback depth as of the last frame, for keeping a scrolled view still. */
  private lastScrollbackCount = 0

  constructor() {
    GhosttyEngine.liveEngines.add(this)
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
    for (const e of GhosttyEngine.liveEngines) {
      if (e.wasm) wasmBytes += e.wasm.exports.memory.buffer.byteLength
      if (e.termPtr !== 0) terminals++
    }
    return { engines: GhosttyEngine.liveEngines.size, terminals, wasmBytes }
  }

  /**
   * The engine most recently on screen — the pane a devtools-driven flood
   * should target. Ranked by the same `lastVisibleAt` the context budget uses,
   * so "the one you are looking at" wins without the caller needing a handle.
   */
  static activeEngine(): GhosttyEngine | null {
    let best: GhosttyEngine | null = null
    for (const e of GhosttyEngine.liveEngines) {
      if (!best || e.lastVisibleAt > best.lastVisibleAt) best = e
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
        scrollbackLimit: scrollbackLinesFor(this._scrollback, this._cols),
        ...this.themeConfigColors(),
      })
      if (this.termPtr === 0) {
        this.failInit('Ghostty could not allocate a terminal.')
        return
      }

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

  /** Every mounted pane, so the context budget can be shared across them. */
  private static readonly liveEngines = new Set<GhosttyEngine>()
  private static lastReconcileAt = 0
  private visible = false
  /** Ranks panes for the budget; a pane on screen now keeps bumping this. */
  private lastVisibleAt = 0

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

  /** Records what this pane can see, then lets the shared pass decide. */
  private noteVisibility(visible: boolean) {
    this.visible = visible
    if (visible) this.lastVisibleAt = performance.now()
    GhosttyEngine.reconcileContexts()
  }

  /**
   * Decides which panes hold a GL context.
   *
   * Browsers cap live WebGL contexts — around sixteen in Chromium — and past
   * that they take them from whoever they like, quite possibly the pane being
   * looked at. Every tab here stays mounted and merely hidden, so panes
   * accumulate whether or not they are on screen.
   *
   * Below the budget nothing is given up at all: a handful of tabs is the
   * normal case, and making it rebuild a context on every tab switch buys
   * nothing but a flash. Only once there are more panes than the budget do the
   * least recently seen ones hand theirs back, and a pane that is on screen
   * never does — a visible pane going dark is the thing this exists to prevent.
   *
   * Ordering by when a pane was last visible rather than by whether it is
   * visible right now is also what makes this stable: a pane measures zero for
   * the first frames after mount and while a split is dragged, and a recency
   * ranking rides straight over that where a strict hidden/visible rule would
   * tear the context down and build it back.
   */
  private static reconcileContexts() {
    const now = performance.now()
    if (now - GhosttyEngine.lastReconcileAt < RECONCILE_INTERVAL_MS) return
    GhosttyEngine.lastReconcileAt = now

    const engines = [...GhosttyEngine.liveEngines]
    if (engines.length > CONTEXT_BUDGET) {
      engines.sort((a, b) => b.lastVisibleAt - a.lastVisibleAt)
    }
    for (let i = 0; i < engines.length; i++) {
      const e = engines[i]
      if (engines.length <= CONTEXT_BUDGET || i < CONTEXT_BUDGET || e.visible) {
        e.ensureContext()
      } else {
        e.dropContext()
      }
    }
  }

  /**
   * Reclaims a context. Also covers one the browser took by itself: whatever
   * the reason a pane that should have a context doesn't, asking for it back is
   * the answer.
   */
  private ensureContext() {
    if (!this.renderer || !this.renderer.isContextLost || this.restoreRequested) return
    this.restoreRequested = true
    this.renderer.restoreContext()
  }

  private dropContext() {
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
    this.mouseButtonDown = null
    this.isSelecting = false
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

  /** See `WORD_RE` for what a word is and why it's that wide. */
  private static isWordChar(s: string): boolean {
    if (s.length === 0) return false
    const c = s.codePointAt(0)!
    if (c > 127) return true // CJK, accented letters, and the like
    return WORD_RE.test(s[0])
  }

  private selectWordAt(pos: { x: number; y: number }) {
    if (!this.renderer) return
    const row = this.readRows(pos.y, pos.y)[0]
    if (!row) return
    // Only the columns a word actually spans get materialised as strings —
    // the scan stops at the first non-word character either side.
    const at2 = (c: number) => columnText(row, c)
    // A wide character's spacer holds no text, so the head it belongs to is one
    // column back.
    let at = pos.x
    if (at2(at) === '' && at > 0) at--
    if (!GhosttyEngine.isWordChar(at2(at))) return
    let from = at
    while (from > 0 && GhosttyEngine.isWordChar(at2(from - 1) || ' ')) from--
    let to = at
    while (to < this._cols - 1 && GhosttyEngine.isWordChar(at2(to + 1) || ' ')) to++
    this.applySelection({ x: from, y: pos.y }, { x: to, y: pos.y })
  }

  private selectLineAt(pos: { x: number; y: number }) {
    this.applySelection({ x: 0, y: pos.y }, { x: this._cols - 1, y: pos.y })
  }

  /**
   * Drives scrolling while a selection is dragged past the top or bottom of the
   * pane. Without it a selection can only ever cover what was already on
   * screen, since there is no way to reach the rest — the drag has nowhere left
   * to go once the pointer leaves the canvas.
   *
   * The pointer stops moving once it is outside, so the scrolling cannot be
   * driven by mousemove; it runs on a timer for as long as the pointer stays
   * out, and the selection end is recomputed from the last known position each
   * tick so the highlight follows the rows coming into view.
   */
  private updateDragScroll(e: MouseEvent) {
    if (!this.canvas) return
    const rect = this.canvas.getBoundingClientRect()
    const above = rect.top - e.clientY
    const below = e.clientY - rect.bottom
    const out = above > 0 ? -above : below > 0 ? below : 0
    if (out === 0) {
      this.stopDragScroll()
      return
    }
    // Further out scrolls faster, which is what makes reaching for something a
    // long way back feel like one gesture rather than a wait.
    this.dragScrollLines = Math.sign(out) * Math.min(DRAG_SCROLL_MAX_LINES, 1 + Math.floor(Math.abs(out) / 24))
    this.dragScrollAt = { clientX: e.clientX, clientY: e.clientY }
    if (this.dragScrollTimer === null) {
      this.dragScrollTimer = setInterval(this.stepDragScroll, DRAG_SCROLL_INTERVAL_MS)
    }
  }

  private stepDragScroll = () => {
    if (!this.isSelecting || !this.selectionStart || !this.renderer || !this.dragScrollAt) {
      this.stopDragScroll()
      return
    }
    // Negative is upward: scrollLines takes the direction the *content* moves.
    this.scrollLines(-this.dragScrollLines)
    this.renderer.selection = {
      start: this.selectionStart,
      end: this.getCoords(this.dragScrollAt as MouseEvent),
      rectangular: this.selectionRectangular,
    }
    this.needsRedraw = true
  }

  private stopDragScroll() {
    if (this.dragScrollTimer === null) return
    clearInterval(this.dragScrollTimer)
    this.dragScrollTimer = null
    this.dragScrollAt = null
  }

  private applySelection(start: { x: number; y: number }, end: { x: number; y: number }) {
    if (!this.renderer) return
    this.renderer.selection = { start, end }
    // Left dangling, a later drag would extend from wherever the last one began.
    this.selectionStart = null
    // A shift-click after picking a word extends from that word's start.
    this.selectionAnchor = start
    this.selectionRectangular = false
    this.isSelecting = false
    this.needsRedraw = true
    for (const h of this.onSelectionChangeHandlers) h()
  }

  /** Is the program on the far end asking to be told about the mouse at all? */
  private mouseTracking(): boolean {
    return !!this.wasm && this.wasm.exports.ghostty_terminal_has_mouse_tracking(this.termPtr) !== 0
  }

  private mouseMode(mode: number): boolean {
    return !!this.wasm && this.wasm.exports.ghostty_terminal_get_mode(this.termPtr, mode, 0) !== 0
  }

  /** Cell under the pointer, 1-based, as mouse reports are numbered. */
  private viewportCoords(e: MouseEvent): { col: number; row: number } {
    if (!this.canvas || !this.renderer) return { col: 1, row: 1 }
    const rect = this.canvas.getBoundingClientRect()
    const size = this.renderer.getCellSize()
    const col = Math.floor((e.clientX - rect.left) / size.width)
    const row = Math.floor((e.clientY - rect.top) / size.height)
    return {
      col: Math.max(0, Math.min(col, this._cols - 1)) + 1,
      row: Math.max(0, Math.min(row, this._rows - 1)) + 1,
    }
  }

  /**
   * Encodes one mouse report and sends it as input. SGR (1006) is preferred
   * whenever the program enabled it, because the original encoding packs each
   * coordinate into a single byte biased by 32 and so cannot describe a column
   * past 223 — which any full-width pane on a modern display now exceeds.
   */
  private sendMouse(button: number, col: number, row: number, e: MouseEvent, release: boolean) {
    let b = button
    if (e.shiftKey) b += 4
    if (e.altKey) b += 8
    if (e.ctrlKey) b += 16

    let seq: string
    if (this.mouseMode(MODE_MOUSE_SGR)) {
      seq = `\x1b[<${b};${col};${row}${release ? 'm' : 'M'}`
    } else {
      if (col > 223 || row > 223) return
      // The legacy form has no way to say *which* button came up, so a release
      // is always reported as button 3.
      const legacy = release ? 3 + (b & ~3) : b
      seq = `\x1b[M${String.fromCharCode(32 + legacy)}${String.fromCharCode(32 + col)}${String.fromCharCode(32 + row)}`
    }
    for (const h of this.onDataHandlers) h(seq)
  }

  private onMouseUp = (e: MouseEvent) => {
    if (this.mouseButtonDown !== null) {
      const button = this.mouseButtonDown
      this.mouseButtonDown = null
      if (this.mouseTracking()) {
        const p = this.viewportCoords(e)
        this.sendMouse(button, p.col, p.row, e, true)
      }
    }
    if (this.isSelecting) {
      this.isSelecting = false
      this.stopDragScroll()
      for (const h of this.onSelectionChangeHandlers) h()
    }
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
      this.noteVisibility(w > 0 && h > 0)
    }

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
      if (this.mouseTracking() && !e.shiftKey) {
        e.preventDefault()
        const p = this.viewportCoords(e)
        this.sendMouse(e.deltaY < 0 ? 64 : 65, p.col, p.row, e, false)
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

    // Only a focused pane blinks. A wall of panes all blinking out of phase is
    // noise, and it also means an idle background pane never wakes the loop.
    this.cursorBlinkTimer = setInterval(this.onBlinkTick, CURSOR_BLINK_MS)

    this.canvas.addEventListener('mousedown', (e) => {
      // Holding shift is the long-standing way to reach the terminal's own
      // selection while a full-screen program is grabbing the mouse.
      if (this.mouseTracking() && !e.shiftKey) {
        e.preventDefault()
        this.inputHandler?.focus()
        const p = this.viewportCoords(e)
        this.mouseButtonDown = e.button
        this.sendMouse(e.button, p.col, p.row, e, false)
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
      // `detail` counts clicks in a run, which is how the platform already
      // decides what a double-click is — no timing to reimplement here.
      if (e.detail === 2) {
        this.selectWordAt(this.getCoords(e))
        return
      }
      if (e.detail >= 3) {
        this.selectLineAt(this.getCoords(e))
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
      if (e.shiftKey && !this.mouseTracking() && this.renderer?.selection && this.selectionAnchor) {
        this.isSelecting = true
        // The drag handler tracks from `selectionStart`, so extending has to set
        // it too — to the anchor, since that is the end this gesture holds fixed.
        // Left null (which is what a double-click leaves behind) the extend was a
        // click and nothing more: the pointer could be dragged anywhere and the
        // selection would not follow, and drag-autoscroll never armed.
        this.selectionStart = this.selectionAnchor
        // Same reason: the drag handler rebuilds the selection from the field,
        // not from what was set here, so a shift-alt extend would drop back to a
        // linewise selection the moment the pointer moved.
        this.selectionRectangular = e.altKey
        this.renderer.selection = {
          start: this.selectionAnchor,
          end: this.getCoords(e),
          rectangular: e.altKey,
        }
        this.needsRedraw = true
        for (const h of this.onSelectionChangeHandlers) h()
        return
      }
      this.isSelecting = true
      this.selectionStart = this.getCoords(e)
      this.selectionAnchor = this.selectionStart
      // Alt is the usual modifier for a column selection — pulling one field
      // out of tabular output without the rest of each line.
      this.selectionRectangular = e.altKey
      if (this.renderer) {
        this.renderer.selection = null
        this.needsRedraw = true
        for (const h of this.onSelectionChangeHandlers) h()
      }
    })

    this.canvas.addEventListener('mousemove', (e) => {
      // A shift-drag is the user talking to the terminal, not to the program,
      // so a selection in progress suppresses reporting entirely.
      if (this.mouseTracking() && !this.isSelecting) {
        // 1002 reports motion only while a button is held; 1003 reports all of
        // it. Reporting unconditionally would flood the PTY from idle mousing.
        const dragging = this.mouseButtonDown !== null
        const wanted = dragging
          ? this.mouseMode(MODE_MOUSE_BUTTON_EVENT) || this.mouseMode(MODE_MOUSE_ANY_EVENT)
          : this.mouseMode(MODE_MOUSE_ANY_EVENT)
        if (!wanted) return
        const p = this.viewportCoords(e)
        // Only cell-to-cell moves are worth a report; pixel-level motion inside
        // one cell would send a burst of identical sequences.
        if (p.col === this.lastMouseCol && p.row === this.lastMouseRow) return
        this.lastMouseCol = p.col
        this.lastMouseRow = p.row
        // +32 marks the report as motion rather than a fresh press.
        this.sendMouse((this.mouseButtonDown ?? 3) + 32, p.col, p.row, e, false)
        return
      }
      if (this.isSelecting && this.renderer && this.selectionStart) {
        // A button released outside the window never delivers mouseup here, and
        // a selection left believing it is still being dragged keeps the
        // autoscroll timer running — the pane scrolls on its own and cannot be
        // stopped. `buttons` is the live state rather than an event history, so
        // it catches exactly that.
        if (e.buttons === 0) {
          this.onMouseUp(e)
          return
        }
        // A pointer that has not left the starting cell is a click, not a drag.
        // Rendering start==end as a selection is what left a one-cell grey block
        // behind after clicking — most visibly on the click that reactivates the
        // window, where the pointer is still moving into the app as it lands.
        const end = this.getCoords(e)
        const moved = end.x !== this.selectionStart.x || end.y !== this.selectionStart.y
        if (!moved) {
          if (this.renderer.selection) {
            this.renderer.selection = null
            this.needsRedraw = true
          }
        } else {
          this.renderer.selection = {
            start: this.selectionStart,
            end,
            rectangular: this.selectionRectangular,
          }
          this.needsRedraw = true
        }
        this.updateDragScroll(e)
      }
    })

    this.inputHandler = new GhosttyInputHandler(this.container, (data) => {
      // Typing while scrolled up otherwise sends keystrokes to a prompt that
      // isn't on screen.
      this.scrollToBottom()
      // Input handler gives Uint8Array, convert to string since onData expects string in TerminalEngine
      const str = new TextDecoder().decode(data)
      for (const handler of this.onDataHandlers) {
        handler(str)
      }
    }, () => {
      return this.wasm
        ? this.wasm.exports.ghostty_terminal_get_mode(this.termPtr, MODE_APP_CURSOR_KEYS, 0) !== 0
        : false
    })
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
    this.stopDragScroll()
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
    GhosttyEngine.liveEngines.delete(this)
    // Closing a pane frees a context, which may put someone else back under
    // the budget — without this they would wait for their own next poll.
    GhosttyEngine.lastReconcileAt = 0
    GhosttyEngine.reconcileContexts()
    this.unmount()
    // Every pane is its own WASM instance; leaving this unfreed leaked the
    // core's page memory for the terminal's whole scrollback budget on every
    // closed pane.
    if (this.wasm && this.termPtr) {
      this.wasm.exports.ghostty_terminal_free(this.termPtr)
      this.termPtr = 0
    }
    this.onDataHandlers.clear()
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

      this.restoreCursorAfterReset()

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

  paste(text: string): void {
    if (!this.wasm) return
    // Paste can arrive from a menu or a shortcut handled above this engine, and
    // whatever served it may have taken the keyboard on the way. Text landing
    // in a pane that then ignores every keystroke reads as the terminal having
    // hung.
    this.inputHandler?.focus()
    this.scrollToBottom()
    const bracketed =
      this.wasm.exports.ghostty_terminal_get_mode(this.termPtr, MODE_BRACKETED_PASTE, 0) !== 0
    let payload = text
    if (bracketed) {
      payload = '\x1b[200~' + text + '\x1b[201~'
    }
    // Fire it as input data to be sent to the backend PTY
    for (const handler of this.onDataHandlers) {
      handler(payload)
    }
  }

  onData(handler: (data: string) => void): IDisposable {
    this.onDataHandlers.add(handler)
    return { dispose: () => this.onDataHandlers.delete(handler) }
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
    const c = Math.floor(rect.width / cellWidth)
    const r = Math.floor(rect.height / cellHeight)
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
   * Reapplied by the caller on a settings change, and by
   * `restoreCursorAfterReset` when RIS discards it.
   */
  setCursorStyle(style: CursorStyleSetting, blink: boolean): void {
    this._cursorStyle = style
    this._cursorBlink = blink
    if (this.termPtr) this.write(cursorStyleSequence(style, blink))
  }

  /**
   * Puts the configured cursor back after a full reset (RIS) discarded it.
   *
   * RIS returns the core to a steady block, which silently throws the
   * preference away — `clear`, a crashed curses program, or anything that
   * resets the terminal on exit. Detecting it by scanning the stream for
   * `ESC c` would be guesswork (the bytes can split across writes, and appear
   * inside payloads that are not sequences), so the core reports it instead.
   *
   * The ordering matters as much as the fact. A TUI commonly resets *and then*
   * sets the cursor it wants, both inside one write, and reapplying blindly
   * would overwrite the choice it just made. So this restores only when the
   * reset is the more recent of the two — when nothing has spoken for the
   * cursor since.
   *
   * Reapplying bumps the core's own DECSCUSR tick, which is what stops this
   * from running again on the next write.
   */
  private restoreCursorAfterReset(): void {
    if (!this.wasm || !this.termPtr) return
    const resetAt = this.wasm.exports.ghostty_terminal_last_reset_seq(this.termPtr)
    const styleAt = this.wasm.exports.ghostty_terminal_last_cursor_style_seq(this.termPtr)
    if (!shouldRestoreCursor(resetAt, styleAt)) return
    writeBytes(this.wasm, this.termPtr, this.oscEncoder.encode(
      cursorStyleSequence(this._cursorStyle, this._cursorBlink),
    ))
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
  // isn't built until the WASM fetch resolves. Mounting and the first fit are
  // synchronous too, so the column count this is budgeted against is the pane's
  // real width and not the 80-column default.
  setScrollback(scrollback: number): void {
    this._scrollback = scrollback
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
    if (!query) {
      this.clearSearchDecorations()
      return
    }

    const flags = `g${options?.caseSensitive ? '' : 'i'}`
    const pattern = options?.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const signature = `${pattern} ${flags}`

    // A throwing regex is the user halfway through typing one, not an error
    // worth clearing the view for.
    let re: RegExp
    try {
      re = new RegExp(pattern, flags)
    } catch {
      this.searchMatches = []
      this.searchIndex = -1
      this.applySearchHighlights()
      for (const h of this.onSearchResultHandlers) h({ index: -1, count: 0 })
      return
    }

    // Rebuilt only when the query or the buffer moved. Incremental search fires
    // on every keystroke, and re-reading ten thousand rows per keystroke is the
    // difference between usable and not.
    if (signature !== this.searchSignature || this.searchGen !== this.bufferGen) {
      this.searchSignature = signature
      this.searchGen = this.bufferGen
      this.searchMatches = this.findMatches(re)
      this.searchIndex = -1
    }

    const count = this.searchMatches.length
    if (count === 0) {
      this.searchIndex = -1
      this.applySearchHighlights()
      for (const h of this.onSearchResultHandlers) h({ index: -1, count: 0 })
      return
    }

    if (this.searchIndex < 0) {
      // Opening on a fresh query starts from what is on screen rather than from
      // the top of a scrollback the user may be nowhere near.
      const firstVisible = this.viewportY
      const at = this.searchMatches.findIndex((m) => m.row >= firstVisible)
      this.searchIndex = at === -1 ? count - 1 : at
    } else if (!options?.incremental) {
      this.searchIndex = options?.back
        ? (this.searchIndex - 1 + count) % count
        : (this.searchIndex + 1) % count
    } else if (this.searchIndex >= count) {
      this.searchIndex = 0
    }

    this.revealRow(this.searchMatches[this.searchIndex].row)
    this.applySearchHighlights()
    for (const h of this.onSearchResultHandlers) h({ index: this.searchIndex, count })
  }

  /**
   * Which absolute rows continue the row above them.
   *
   * One call per row, which sounds worse than it is: `findMatches` already
   * reads every row, and the result is cached behind the same query/buffer
   * signature the matches are.
   */
  private readWrapFlags(total: number): boolean[] {
    const out = new Array<boolean>(Math.max(0, total)).fill(false)
    if (!this.wasm || !this.termPtr) return out
    const wasm = this.wasm
    const scrollbackCount = wasm.exports.ghostty_terminal_get_scrollback_length(this.termPtr)
    for (let abs = 0; abs < total; abs++) {
      out[abs] =
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
  private findMatches(re: RegExp): SearchMatch[] {
    const total = this.scrollbackLength
    const rows = this.readRows(0, total - 1)
    const wrapped = this.readWrapFlags(rows.length)
    const out: SearchMatch[] = []

    let i = 0
    while (i < rows.length) {
      // This row plus every continuation of it.
      let end = i + 1
      while (end < rows.length && wrapped[end]) end++

      // A column can hold more than one character (a grapheme cluster), so the
      // offset a match reports is not a column. These map back, and now also
      // say which row the offset landed on.
      let text = ''
      const rowAt: number[] = []
      const colAt: number[] = []
      for (let r = i; r < end; r++) {
        const row = rows[r]
        // The row's text is already joined; the per-character maps come from
        // the column index rather than from re-measuring per-cell strings.
        text += row.text
        const cs = row.colStart
        for (let c = 0; c + 1 < cs.length; c++) {
          for (let k = cs[c]; k < cs[c + 1]; k++) {
            rowAt.push(r)
            colAt.push(c)
          }
        }
      }

      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) {
          // A pattern that can match nothing would otherwise spin here.
          re.lastIndex++
          continue
        }
        const from = m.index
        const to = Math.min(m.index + m[0].length - 1, rowAt.length - 1)
        if (rowAt[from] === undefined || rowAt[to] === undefined) continue

        const segments: { row: number; from: number; to: number }[] = []
        let k = from
        while (k <= to) {
          const row = rowAt[k]
          let j = k
          while (j + 1 <= to && rowAt[j + 1] === row) j++
          segments.push({ row, from: colAt[k], to: colAt[j] })
          k = j + 1
        }
        // The head doubles as the match's own position, so reveal and ordering
        // keep working on matches that never wrap.
        out.push({ ...segments[0], segments })
      }
      i = end
    }
    return out
  }

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

  private applySearchHighlights() {
    if (!this.renderer) return
    if (this.searchMatches.length === 0) {
      this.renderer.searchHighlights = null
    } else {
      const byRow = new Map<number, SearchHighlight[]>()
      for (let i = 0; i < this.searchMatches.length; i++) {
        // Every row the match covers, not just its head: a match across a wrap
        // is one hit but two or more highlights.
        for (const seg of this.searchMatches[i].segments) {
          let list = byRow.get(seg.row)
          if (!list) byRow.set(seg.row, (list = []))
          list.push({ from: seg.from, to: seg.to, active: i === this.searchIndex })
        }
      }
      this.renderer.searchHighlights = byRow
    }
    this.needsRedraw = true
  }

  clearSearchDecorations(): void {
    this.searchMatches = []
    this.searchIndex = -1
    this.searchSignature = ''
    if (this.renderer) this.renderer.searchHighlights = null
    this.needsRedraw = true
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
    if (!this.renderer || !this.renderer.selection) return
    this.renderer.selection = null
    this.selectionStart = null
    this.selectionAnchor = null
    this.needsRedraw = true
    for (const h of this.onSelectionChangeHandlers) h()
  }
  getSelection(): string {
    if (!this.renderer || !this.renderer.selection || !this.wasm) return ''

    let selStart = this.renderer.selection.start
    let selEnd = this.renderer.selection.end
    if (selStart.x === selEnd.x && selStart.y === selEnd.y) return ''
    if (selStart.y > selEnd.y || (selStart.y === selEnd.y && selStart.x > selEnd.x)) {
      const temp = selStart; selStart = selEnd; selEnd = temp
    }

    const rectangular = this.renderer.selection.rectangular === true
    const rectFrom = Math.min(selStart.x, selEnd.x)
    const rectTo = Math.max(selStart.x, selEnd.x)

    const rows = this.readRows(selStart.y, selEnd.y)
    const parts: string[] = []
    for (let i = 0; i < rows.length; i++) {
      const abs = selStart.y + i
      const from = rectangular ? rectFrom : abs === selStart.y ? selStart.x : 0
      const to = rectangular ? rectTo : abs === selEnd.y ? selEnd.x : this._cols - 1
      // One slice of the row's own text rather than a join of per-cell
      // strings. `to + 1` is always a valid index into `colStart`, which has
      // one entry more than there are columns.
      const row = rows[i]
      const lo = Math.max(0, Math.min(from, this._cols))
      const hi = Math.max(lo, Math.min(to + 1, this._cols))
      const text = row.text.slice(row.colStart[lo], row.colStart[hi])
      // Trailing blanks are the grid padding a row out, not content. The one
      // case worth keeping them is a line-wise selection whose last row ends
      // part-way along: there the run of spaces was dragged over deliberately.
      // A selection reaching the final column did not choose that padding —
      // triple-click is exactly that, and keeping it pasted a command followed
      // by a screenful of spaces. A column selection never keeps them either;
      // every one of its rows ends at the same arbitrary column.
      const endsMidRow = abs === selEnd.y && selEnd.x < this._cols - 1
      const keepTrailing = !rectangular && endsMidRow
      parts.push(keepTrailing ? text : text.replace(/\s+$/, ''))
    }
    return parts.join('\n')
  }

  selectAll(): void {
    if (!this.renderer || !this.wasm) return
    const scrollbackCount = this.wasm.exports.ghostty_terminal_get_scrollback_length(this.termPtr)
    this.renderer.selection = {
      start: { x: 0, y: 0 },
      end: { x: this._cols - 1, y: scrollbackCount + this._rows - 1 },
    }
    this.needsRedraw = true
    for (const h of this.onSelectionChangeHandlers) h()
  }
}
