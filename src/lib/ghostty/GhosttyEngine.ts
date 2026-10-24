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
import { translateBackspace } from '../translateBackspace'
import { SelectionController } from './SelectionController'
import { MarkModeController } from './MarkModeController'
import type { PathFlavor } from '../pathDetect'
import { LinkController, type Link, type LinkKind } from './LinkController'
import { HintModeController } from './HintModeController'
import { isOpenableUrl } from '../urlDetect'
import { ContextManager } from './ContextManager'
import type { RowText } from './rowText'
import {
  WebGLRenderer,
  measureCell,
  BLEND_NATIVE,
  BLEND_LINEAR,
  BLEND_LINEAR_CORRECTED,
} from './WebGLRenderer'
import { OscStream, parseOsc } from './oscStream'
import type * as mainAbi from './main/abi'
import * as phases from '../writePhases'
import { findTheme, hexToRgb, type TerminalTheme } from '../theme'
import { cursorStyleSequence, type CursorStyleSetting, type TextBlending } from '../settings'
import { headFamily, plainSelection, type FontSelection } from '../fontStack'
import { bundledSettled } from '../bundledFonts'
import {
  compileGhosttyWasm,
  instantiateGhosttyModule,
  createTerminal,
  writeBytes,
  readResponse,
  parseCellInto,
  emptyCell,
  MODE_BRACKETED_PASTE,
  MODE_ALT_SCREEN,
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
import { NativeSearchController } from './NativeSearchController'
import {
  LEAVE_ALT_SCREEN,
  SNAPSHOT_MODES,
  leftoverModeReset,
  sessionModeReset,
  type ModeSnapshot,
} from './sessionModes'
// ghostty `main` plus the `ESC k` fix (#176). `instantiateGhosttyModule`
// detects its API from the exports and wraps it in `main/shim.ts`. See
// vendor/README.md and docs/PORT_GHOSTTY_MAIN.md.
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
 * The core's `scrollbackLimit` is a byte budget, not a row count. Retention
 * tracks `value / (cols * 9.2)` for this binary; rows fall out of the budget and
 * the width, which is why the setting is the budget. Re-measure after
 * rebuilding the vendored binary (see docs/DEV_HISTORY.md).
 */
const SCROLLBACK_BYTES_PER_CELL = 9.2

/**
 * Per-pane memory tiers: key is the pane's total WASM footprint in MB as shown
 * in Settings, value is the scrollback budget. WASM memory grows in doubling
 * steps, so each budget is the largest that stays inside its step:
 *
 *   budget <= 2.5 MB  ->  5.0 MB heap   (8 MB tier)
 *   budget 2.75-6 MB  ->  9.0 MB heap   (16 MB tier)
 *   budget 6.5-12 MB  -> 17.0 MB heap   (32 MB tier)
 *   budget 13-26 MB   -> 33.0 MB heap   (64 MB tier)
 *
 * Measured, not derived: re-measure after any rebuild of the vendored binary.
 */
const SCROLLBACK_BUDGET_BY_FOOTPRINT_MB: Record<number, number> = {
  8: 2.5 * 1024 * 1024,
  16: 6 * 1024 * 1024,
  32: 12 * 1024 * 1024,
  64: 26 * 1024 * 1024,
}

/** Tier used when a setting is missing or invalid; the smallest, so a bad
 *  value never costs more memory than the user chose. */
const DEFAULT_FOOTPRINT_MB = 8

/** Output buffered before the core loads, beyond which the engine reports a
 *  failure instead of waiting. */
const MAX_PREREADY_BYTES = 1024 * 1024

/**
 * Scrollback bytes for a footprint tier. Unknown tiers fall back to the
 * smallest: zero means *unlimited* to the core, and `setUint32` silently
 * mangles fractional or out-of-range values.
 */
export function scrollbackBudgetBytesFor(footprintMB: number): number {
  return SCROLLBACK_BUDGET_BY_FOOTPRINT_MB[footprintMB] ?? SCROLLBACK_BUDGET_BY_FOOTPRINT_MB[DEFAULT_FOOTPRINT_MB]
}

/**
 * Approximate rows a budget buys at a given width, for display. The core evicts
 * whole pages, so the real figure is a little lower; `scrollbackLength` is the
 * measured depth of a live pane.
 */
export function estimateScrollbackRows(budgetBytes: number, cols: number): number {
  const safeCols = Number.isFinite(cols) ? Math.max(1, cols) : 1
  const safeBytes = Number.isFinite(budgetBytes) ? Math.max(0, budgetBytes) : 0
  return Math.round(safeBytes / (safeCols * SCROLLBACK_BYTES_PER_CELL))
}

/**
 * Grid that fits a container box, in cells. Reserves `gutterPx` because the
 * scrollbar overlays the canvas rather than taking layout space.
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

/** Text-blending setting mapped to renderer uniforms. */
const BLEND_MODES: Record<TextBlending, number> = {
  native: BLEND_NATIVE,
  linear: BLEND_LINEAR,
  'linear-corrected': BLEND_LINEAR_CORRECTED,
}

export class GhosttyEngine implements TerminalEngine {
  private container: HTMLElement | null = null
  private canvas: HTMLCanvasElement | null = null
  
  private wasm: GhosttyWasm | null = null
  private termPtr: number = 0
  private renderer: WebGLRenderer | null = null
  
  private fonts: FontSelection = plainSelection('Consolas, monospace')
  private fontSize = 14
  
  /** Whether the host wants `^H` for Backspace; applied to keystrokes in `mount`. */
  private backspaceSendsCtrlH = false
  /**
   * Whether growing the pane may pull rows back out of scrollback (false for
   * ConPTY). Kept here too because the terminal may not exist yet.
   */
  private resizePullsScrollback = true

  private onDataHandlers = new Set<(data: Uint8Array) => void>()
  /** Fired only for key input and paste, i.e. data a human typed. */
  private onInputHandlers = new Set<(data: Uint8Array) => void>()
  private onResizeHandlers = new Set<(size: { cols: number; rows: number }) => void>()
  private inputHandler: GhosttyInputHandler | null = null
  /** Ghostty's key encoder; holds a pointer to the terminal, so it lives and dies
   *  with it. */
  private keyEncoder: KeyEncoder | null = null
  /**
   * The core's native find-in-scrollback, when the binary has it. Not used for
   * regex or case-sensitive queries; `search` ensures only one search path owns
   * the highlights at a time. See `docs/NATIVE_SEARCH_PLAN.md`.
   */
  private nativeSearch: NativeSearchController | null = null

  /** Ghostty's mouse encoder; lives with the terminal and also needs the
   *  rendered geometry (see `syncMouseSurface`). */
  private mouseEncoder: MouseEncoder | null = null

  /** Writes received before the core finished loading, as bytes. */
  private writeBuffer: Uint8Array[] = []
  private writeBufferBytes = 0
  /** Whether the render loop may re-fit to the container; see `setAutoFit`. */
  private autoFit = true
  private renderLoopId = 0
  private needsRedraw = true
  // Deferred re-fits can outlive a pane disposed while WASM is still loading.
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
  /** Per-pane memory tier; resolved to a byte budget when the terminal is built. */
  private _scrollbackFootprintMB = DEFAULT_FOOTPRINT_MB
  /** The configured default cursor, resent to the core whenever one is built. */
  private _cursorStyle: CursorStyleSetting = 'block'
  private _cursorBlink = true
  // Kept here because the renderer is rebuilt on a font change.
  private _textBlending: TextBlending = 'native'
  private _ligatures = false
  private _themeName: string | null = null
  private _opacity = 1
  private _background: string | null = null
  private _viewportOffset = 0
  private onScrollHandlers = new Set<(newPos: number) => void>()
  private onWriteParsedHandlers = new Set<() => void>()
  /** Fired after a frame is drawn. Only the benchmark harness subscribes. */
  private onRenderHandlers = new Set<() => void>()
  
  /** Mouse selection; assigned in the constructor. */
  private readonly selection: SelectionController
  private onSelectionChangeHandlers = new Set<() => void>()
  /** Keyboard selection; takes the arrow keys while active. */
  private readonly markMode: MarkModeController
  private onMarkModeHandlers = new Set<(active: boolean) => void>()
  /** URLs in the buffer: what is under a cell, and what is on screen. */
  private readonly links: LinkController
  /** Opening a link from the keyboard, for when a program has the mouse. */
  private readonly hintMode: HintModeController
  private onHintModeHandlers = new Set<(active: boolean) => void>()
  private onLinkActivateHandlers = new Set<(url: string) => void>()
  private onPathActivateHandlers = new Set<(path: string) => void>()
  /** Whether file paths are links, and in which syntax; see `setPathLinks`. */
  private pathLinks: PathFlavor | null = null
  /** Last pointer position, to redo the hit test when a modifier changes. */
  private hoverPointer: { clientX: number; clientY: number } | null = null
  /** The link currently underlined, or null. */
  private hoveredLink: Link | null = null
  /** Cell, modifier, buffer generation and viewport of the current hover result,
   *  so detection only reruns when one changes. */
  private hoverSig = ''
  /** Cache key for the painted link underlines. */
  private linkRangesSig = ''
  /** A Ctrl+press on a link, pending the release that decides click vs drag. */
  private pendingLink: { url: string; kind: LinkKind; at: { x: number; y: number } } | null = null
  private onCopyRequestHandlers = new Set<(text: string) => void>()
  /**
   * Splits the output at each OSC with the core's own parser, so a handler runs
   * after its sequence is parsed and before anything after it. Null until the
   * core loads; see `oscStream.ts`.
   */
  private oscStream: OscStream | null = null
  private oscDecoder = new TextDecoder()
  private oscEncoder = new TextEncoder()
  private oscHandlers = new Map<number, ((data: string) => boolean | Promise<boolean>)[]>()
  private onBellHandlers = new Set<() => void>()
  /** See `registerResetHandler`. */
  private onResetHandlers = new Set<() => void>()
  private onBufferChangeHandlers = new Set<(isAlternate: boolean) => void>()
  private lastIsAlternate = false

  /**
   * Why the engine is dead (failed to start or died later), or null. Retained so
   * handlers registered after the failure still hear about it.
   */
  private fatalError: string | null = null
  private onInitErrorHandlers = new Set<(message: string) => void>()

  private onSearchResultHandlers = new Set<(result: SearchResult) => void>()
  /** Find-in-scrollback; assigned in the constructor. */
  private readonly searchController: SearchController
  /** Bumped whenever the buffer changes, so a cached search knows it is stale. */
  private bufferGen = 0

  private cursorBlinkOn = true
  private blinkTicks = 0
  private cursorBlinkTimer: ReturnType<typeof setInterval> | null = null
  private focused = false

  /** Mouse reporting; assigned in the constructor. */
  private readonly mouse: MouseReporter
  /** Scrollback depth as of the last frame, for keeping a scrolled view still. */
  private lastScrollbackCount = 0
  /**
   * Scrollback depth when the render snapshot was last rebuilt, the only count
   * `readRows` may map absolute rows through: the live count has already grown by
   * output processed since. -1 before the first snapshot.
   */
  private snapshotScrollback = -1

  /**
   * Absolute rows `readRows` returned as blanks during its last call, and why
   * (e.g. a refused scrollback read). Reported by `dumpState`. Rows above the
   * buffer (`abs < 0`) are not failures and aren't recorded.
   */
  private rowReadFailures: { row: number; why: string }[] = []

  constructor() {
    // Narrow by design: reads of buffer state plus requests to move or repaint.
    this.mouse = new MouseReporter({
      tracking: () => this.mouseTracking(),
      at: (e) => this.pointerAt(e),
      encoder: () => this.mouseEncoder,
      pixelReporting: () => this.mouseMode(MODE_MOUSE_SGR_PIXELS),
      send: (bytes) => {
        for (const h of this.onDataHandlers) h(bytes)
      },
    })
    this.selection = new SelectionController({
      readRows: (from, to) => this.readRows(from, to),
      readWrapFlags: (from, to) => this.readWrapFlags(from, to),
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
      pathLinks: () => this.pathLinks,
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
      openLink: (url, kind) => this.activateLink(url, kind),
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
    // Registered here rather than at module scope so importing has no side effect.
    phases.setContext(GhosttyEngine.formatDiagnostics)
    this.initWasm()
  }

  /**
   * Engines alive, terminals allocated, and their combined WASM linear memory
   * (each engine has its own instance, so these sum). Reported alongside
   * throughput figures to diagnose session-to-session speed differences.
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

  /** The engine most recently on screen, by the context budget's `lastVisibleAt`. */
  static activeEngine(): GhosttyEngine | null {
    let best: GhosttyEngine | null = null
    for (const e of GhosttyEngine.contexts.all()) {
      if (!best || GhosttyEngine.contexts.lastVisibleAt(e) > GhosttyEngine.contexts.lastVisibleAt(best)) {
        best = e
      }
    }
    return best
  }

  /** Row-read failures as one line, shared by the console warning and the dump. */
  private static summariseRowFailures(failures: { row: number; why: string }[]): string {
    const byReason = new Map<string, number[]>()
    for (const f of failures) {
      const rows = byReason.get(f.why)
      if (rows) rows.push(f.row)
      else byReason.set(f.why, [f.row])
    }
    return [...byReason]
      .map(([why, rows]) => {
        const shown = rows.slice(0, 8).join(', ')
        return `${why}: ${rows.length} (rows ${shown}${rows.length > 8 ? ', …' : ''})`
      })
      .join('; ')
  }

  static formatDiagnostics(): string {
    const d = GhosttyEngine.diagnostics()
    return `page: ${d.engines} live engine(s), ${d.terminals} terminal(s), ${(d.wasmBytes / 1048576).toFixed(1)} MB WASM linear memory`
  }

  private async initWasm() {
    try {
      // Compiled once for the app, instantiated per pane; see compileGhosttyWasm.
      this.wasm = await instantiateGhosttyModule(await compileGhosttyWasm(ghosttyWasmUrl))

      // Colors go in at construction so the core resolves every cell to RGB.
      this.termPtr = createTerminal(this.wasm, this._cols, this._rows, {
        scrollbackLimit: this.scrollbackBudgetBytes,
        ...this.themeConfigColors(),
        // The cursor a RIS returns to. Only the `main` ABI acts on it.
        cursorStyle: CONFIG_CURSOR_STYLE[this._cursorStyle],
        cursorBlink: this._cursorBlink,
      })
      if (this.termPtr === 0) {
        this.failInit('Ghostty could not allocate a terminal.')
        return
      }
      // Before the first resize can happen, which is the only thing it governs.
      if (!this.resizePullsScrollback) this.applyResizePull()

      // Before the buffered writes, which may turn on the Kitty protocol.
      this.keyEncoder = KeyEncoder.create(this.wasm, this.termPtr)
      // Before the buffered writes too: their OSCs are dispatched as they replay.
      const raw = this.wasm.instance.exports as unknown as mainAbi.GhosttyMainExports
      if (typeof raw.ghostty_terminal_vt_write_until === 'function') {
        this.oscStream = new OscStream(raw, this.termPtr)
      }
      // Cheap and order-independent to free, so built eagerly.
      this.nativeSearch = NativeSearchController.create(this.wasm, this.termPtr, {
        setHighlights: (byRow) => {
          if (this.renderer) this.renderer.searchHighlights = byRow
          this.needsRedraw = true
        },
        revealRow: (row) => this.revealRow(row),
        emit: (result) => {
          for (const h of this.onSearchResultHandlers) h(result)
        },
        viewportY: () => this.viewportY,
        bufferGen: () => this.bufferGen,
        cols: () => this._cols,
        rows: () => this._rows,
      })
      this.mouseEncoder = MouseEncoder.create(this.wasm, this.termPtr)
      // Mount may already have run if the module was warm; otherwise
      // setupRenderer does this.
      this.syncMouseSurface()

      // Before the buffered writes, so a cursor shape set by the connection's first
      // bytes wins. Written unconditionally: a fresh core has DEC mode 12 off (steady
      // cursor), not a blinking block.
      writeBytes(this.wasm, this.termPtr, this.oscEncoder.encode(
        cursorStyleSequence(this._cursorStyle, this._cursorBlink),
      ))

      // Flush buffered writes synchronously: the parser must see bytes in order.
      // Through `feed`, so OSCs that arrived before the core loaded still reach
      // their handlers, now with a grid to read.
      const buffered = this.writeBuffer
      this.writeBuffer = []
      for (const data of buffered) this.feed(data)
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
   * Record why the engine is dead and notify listeners; otherwise a failed init
   * is just a blank pane. Idempotent.
   */
  private failInit(message: string) {
    if (this.fatalError !== null) return
    this.fatalError = message
    console.error(message)
    for (const cb of this.onInitErrorHandlers) cb(message)
  }

  /**
   * The core failed mid-session. Reported like a failed init; the render loop
   * stops with the error on screen.
   */
  private failFatal(e: unknown) {
    this.failInit(
      e instanceof GhosttyOutOfMemoryError
        ? `Ghostty's WASM core ran out of memory; this terminal has stopped. (${e.message})`
        : `Ghostty's WASM core failed: ${e}`,
    )
  }

  /**
   * Fires if the engine can't start or dies, immediately if it already has.
   * Optional on `TerminalEngine`: xterm has no asynchronous startup.
   */
  onInitError(cb: (message: string) => void): IDisposable {
    this.onInitErrorHandlers.add(cb)
    if (this.fatalError !== null) cb(this.fatalError)
    return { dispose: () => this.onInitErrorHandlers.delete(cb) }
  }

  private setupRenderer() {
    // StrictMode double-mounts in dev, so the pane may already be disposed.
    if (this.disposed || !this.canvas || !this.wasm) return
    
    this.renderer = new WebGLRenderer(
      this.canvas,
      this._cols,
      this._rows,
      this.fonts,
      this.fontSize
    )
    this.renderer.onRestore = this.onRendererRestored

    if (this._themeName) {
      this.applyThemeToRenderer(this._themeName)
    }
    this.applyTextBlendingToRenderer()

    // Fit now that the renderer exists.
    this.fit(true)

    // Fit again next frame and once fonts load: the panel width and
    // the cell metrics can both settle after this point without resizing the
    // container, so the ResizeObserver wouldn't fire.
    requestAnimationFrame(() => {
      if (!this.disposed) this.fit(true)
    })
    document.fonts?.ready
      .then(() => {
        // The renderer's metrics and atlas may be from the fallback face; rebuild.
        if (!this.disposed) this.setFont(this.fonts, this.fontSize)
      })
      .catch(() => {})

    this.startRenderLoop()
  }

  private lastSeenW = -1
  private lastSeenH = -1
  private pollCounter = 0
  private restoreRequested = false

  /** Every mounted pane, sharing one context budget; see `ContextManager`. */
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

  // A restored context starts empty; repaint so an idle pane isn't left blank.
  private onRendererRestored = () => {
    this.needsRedraw = true
    this.restoreRequested = false
  }



  /** Reclaims a context, including one the browser dropped on its own. */
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
   * One timer for cursor blink (focused pane only) and text blink (half rate).
   * Only repaints when something on screen depends on it.
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

  /** DEC mode 1004 focus reporting. */
  private reportFocus(focused: boolean) {
    if (!this.mouseMode(MODE_FOCUS_REPORTING)) return
    const seq = this.oscEncoder.encode(focused ? '\x1b[I' : '\x1b[O')
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
    // A release outside the window never reaches us; clear held-button and
    // selection state so the pane doesn't wedge.
    this.mouse.forgetButton()
    this.selection.cancel()
    this.stopDragTracking()
    // The modifier release will go elsewhere, so disarm the hover now.
    this.clearLinkHover()
    this.pendingLink = null
    this.reportFocus(false)
  }

  /**
   * Keeps a scrolled-back view on the same text as output arrives by growing the
   * offset with the scrollback. Once the buffer is full the oldest rows are
   * discarded and the view can no longer hold still.
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

  /** Sends the host whatever the terminal owes it (CPR, DA, and other replies). */
  private drainResponses() {
    if (!this.wasm || !this.termPtr) return
    // Bounded: a far end answering each reply with a query could loop forever.
    for (let i = 0; i < 64; i++) {
      const out = readResponse(this.wasm, this.termPtr)
      if (!out || out.length === 0) return
      for (const h of this.onDataHandlers) h(out)
    }
  }

  /**
   * Text for a range of absolute buffer rows (scrollback first, then the active
   * screen), as joined text plus each column's start offset. A column may hold
   * a grapheme cluster or nothing (the trailing half of a wide character).
   */
  private readRows(fromAbs: number, toAbs: number): RowText[] {
    const out: RowText[] = []
    // Per call: callers want to know whether *these* rows came back whole.
    this.rowReadFailures = []
    if (!this.wasm || !this.termPtr) return out
    const wasm = this.wasm
    const wasmCols = wasm.exports.ghostty_render_state_get_cols(this.termPtr)
    const wasmRows = wasm.exports.ghostty_render_state_get_rows(this.termPtr)
    // The snapshot's depth, not the live one; see `snapshotScrollback`.
    const liveScrollback = wasm.exports.ghostty_terminal_get_scrollback_length(this.termPtr)
    const scrollbackCount = this.snapshotScrollback >= 0 ? this.snapshotScrollback : liveScrollback
    if (wasmCols <= 0) return out

    const cellCount = wasmCols * wasmRows
    const viewSize = cellCount * CELL_BYTES
    const lineSize = wasmCols * CELL_BYTES
    // Longer grapheme clusters are truncated.
    const gCap = 16
    // One scratch cell for the whole walk.
    const cell = emptyCell()

    // Throw rather than hand back a page of blanks as if it were the buffer.
    const viewPtr = allocBufferOrThrow(wasm, viewSize)
    wasm.exports.ghostty_render_state_get_viewport(this.termPtr, viewPtr, cellCount)
    const linePtr = allocBufferOrThrow(wasm, lineSize)
    const gPtr = allocBufferOrThrow(wasm, gCap * 4)

    // Views after the last allocation: growing memory detaches older buffers.
    const viewV = new DataView(wasm.exports.memory.buffer, viewPtr, viewSize)
    const lineV = linePtr !== 0 ? new DataView(wasm.exports.memory.buffer, linePtr, lineSize) : null
    const gV = gPtr !== 0 ? new DataView(wasm.exports.memory.buffer, gPtr, gCap * 4) : null

    for (let abs = fromAbs; abs <= toAbs; abs++) {
      // One extra entry so column `c` always spans `[colStart[c], colStart[c + 1])`.
      const colStart = new Int32Array(this._cols + 1)
      let text = ''
      // Unreadable rows stay as blanks so callers can index by offset.
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
          this.rowReadFailures.push({ row: abs, why: 'no line buffer' })
          out.push(blank())
          continue
        }
        // On a miss the buffer still holds the previous row.
        if (wasm.exports.ghostty_terminal_get_scrollback_line(this.termPtr, abs, linePtr, wasmCols) === 0) {
          this.rowReadFailures.push({ row: abs, why: 'refused by the core' })
          out.push(blank())
          continue
        }
        isScrollback = true
      } else {
        activeRow = abs - scrollbackCount
        if (activeRow >= wasmRows) {
          // Output landed after the snapshot; this row is beyond its screen.
          this.rowReadFailures.push({ row: abs, why: 'past the snapshot screen' })
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
          // Trailing half of a wide character: an empty span.
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
      // Columns past the core's width are blank.
      for (; c < this._cols; c++) {
        colStart[c] = text.length
        text += ' '
      }
      colStart[this._cols] = text.length
      out.push({ text, colStart })
    }

    if (this.rowReadFailures.length > 0) {
      // Loud: copy, search and links all silently go wrong when this happens.
      console.error(
        `Ghostty: ${this.rowReadFailures.length} row(s) could not be read and are blank — ` +
          GhosttyEngine.summariseRowFailures(this.rowReadFailures),
      )
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
   * Gives the encoder the rendered geometry for pixel-to-cell conversion; call
   * whenever it can change. No padding: the canvas is sized to the grid.
   */
  private syncMouseSurface(): void {
    // The reporter's last cell was measured against the old geometry.
    this.mouse.forgetLastCell()
    if (!this.mouseEncoder || !this.renderer) return
    const cell = this.renderer.getCellSize()
    this.mouseEncoder.setSurface({
      screenWidth: this._cols * cell.width,
      screenHeight: this._rows * cell.height,
      cellWidth: cell.width,
      cellHeight: cell.height,
    })
  }

  /** Pointer position for mouse reporting, clamped to the surface so a drag
   *  that leaves the pane keeps reporting against the edge cell. */
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
    // A Ctrl+press on a link opens on release, so a Ctrl+drag starting on a link
    // still selects.
    const pending = this.pendingLink
    this.pendingLink = null
    if (pending && this.withinCanvas(e)) {
      const at = this.getCoords(e)
      if (at.x === pending.at.x && at.y === pending.at.y) {
        this.activateLink(pending.url, pending.kind)
      }
    }

    this.mouse.reportRelease(e)
    this.stopDragTracking()
    if (this.selection.isSelecting()) {
      this.selection.cancel()
      for (const h of this.onSelectionChangeHandlers) h()
    }
  }

  /** Whether the pointer is over the grid (`getCoords` clamps). */
  private withinCanvas(e: MouseEvent): boolean {
    if (!this.canvas) return false
    const rect = this.canvas.getBoundingClientRect()
    return (
      e.clientX >= rect.left && e.clientX < rect.right && e.clientY >= rect.top && e.clientY < rect.bottom
    )
  }

  /**
   * The link modifier: Ctrl, or Cmd on a Mac. Not Shift, which already means
   * "bypass mouse reporting" and "extend selection".
   */
  private static linkModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
    return e.ctrlKey || e.metaKey
  }

  /**
   * Recomputes what the pointer is over when the cell, buffer or viewport has
   * changed since the last check.
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
   * Keeps the dotted underline over every visible URL current, so links are
   * discoverable. Cached on the same key as the hit test.
   */
  private refreshLinkRanges(): void {
    if (!this.renderer) return
    const sig = `${this.bufferGen}:${this.viewportY}:${this._cols}`
    if (sig === this.linkRangesSig) return
    this.linkRangesSig = sig
    // URLs only; paths are links on demand (Ctrl or hint mode), otherwise
    // compiler output and `ls` listings would be underlined wall to wall.
    const ranges = this.links
      .linksInViewport()
      .filter((l) => l.kind === 'url')
      .flatMap((l) => l.segments)
    // `null` lets the renderer skip its per-row filter.
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
        before.kind === link.kind &&
        before.segments[0].row === link.segments[0].row &&
        before.segments[0].from === link.segments[0].from)
    this.hoveredLink = link
    if (same) return
    if (this.renderer) this.renderer.linkHighlight = link ? link.segments : null
    this.needsRedraw = true
    // Empty string restores the stylesheet's cursor.
    if (this.canvas) this.canvas.style.cursor = link ? 'pointer' : ''
  }

  /**
   * Hide these spans' glyphs, or pass null to show them again. Used for the
   * history-recall flicker; see `WebGLRenderer.hiddenSpans`.
   */
  setHiddenSpans(spans: { row: number; from: number; to: number }[] | null): void {
    if (!this.renderer) return
    // Runs on a timer per pane; skip the common nothing-to-nothing case.
    if (this.renderer.hiddenSpans === null && spans === null) return
    this.renderer.hiddenSpans = spans
    this.needsRedraw = true
  }

  /** Clears the underline and pointer cursor when the pointer or focus leaves. */
  private clearLinkHover(): void {
    this.hoverPointer = null
    this.hoverSig = ''
    this.setHoveredLink(null)
  }

  /** A stable reference, so mount and unmount add and remove the same one. */
  private clearLinkHoverListener = () => this.clearLinkHover()

  /** Re-tests the hover when a modifier changes without the mouse moving. */
  private onHoverModifierKey = (e: KeyboardEvent) => {
    if (!this.hoverPointer) return
    this.refreshLinkHover(GhosttyEngine.linkModifier(e))
  }

  /**
   * Hands a URL to the host. The scheme is re-checked here, the last point
   * before the platform opener: on Windows a `file://` or UNC target can trigger
   * outbound SMB authentication and leak credentials.
   */
  private activateLink(url: string, kind: LinkKind = 'url'): void {
    // Paths are resolved by the frontend on the remote host and never reach the
    // platform opener.
    if (kind === 'path') {
      for (const h of this.onPathActivateHandlers) h(url)
      return
    }
    if (!isOpenableUrl(url)) return
    for (const h of this.onLinkActivateHandlers) h(url)
  }

  /**
   * Listens on the window for the length of a drag: the canvas stops getting
   * `mousemove` once the pointer leaves it, which is exactly when selection
   * autoscroll needs it.
   */
  private startDragTracking(): void {
    window.addEventListener('mousemove', this.onWindowMouseMove)
  }

  private stopDragTracking(): void {
    window.removeEventListener('mousemove', this.onWindowMouseMove)
  }

  /**
   * Keys claimed by hint mode or mark mode go nowhere else. Hint mode is offered
   * the key first; only one is active at a time.
   */
  private onMarkModeKey = (e: KeyboardEvent) => {
    if (!this.hintMode.handleKey(e) && !this.markMode.handleKey(e)) return
    e.preventDefault()
    e.stopPropagation()
  }

  private onWindowMouseMove = (e: MouseEvent) => {
    // A release outside the window never arrives, which would leave autoscroll
    // running; `buttons` is the live state.
    if (e.buttons === 0) {
      this.onMouseUp(e)
      return
    }
    if (!this.selection.drag(e)) this.stopDragTracking()
  }

  /**
   * One frame's work, split out so the loop can own error handling (a throw must
   * not skip the reschedule).
   */
  private renderFrame() {
    if (!this.wasm || !this.renderer) return

    // Safety net for initial sizing: the ResizeObserver misses the first layout
    // settle. Measures every 6th frame and only fits when the box changed.
    if (this.container && ++this.pollCounter % 6 === 0) {
      const w = this.container.clientWidth
      const h = this.container.clientHeight
      if ((w !== this.lastSeenW || h !== this.lastSeenH) && w > 0 && h > 0) {
        this.lastSeenW = w
        this.lastSeenH = h
        // Skipped when the grid is pinned: a pin larger than the container relays
        // out the page and this would undo it.
        if (this.autoFit) this.fit()
      }
      GhosttyEngine.contexts.noteVisibility(this, w > 0 && h > 0)
    }

    // Keeps the core's search current with new output and scrolling.
    this.nativeSearch?.onFrame()

    // Which cells are links, for the at-rest underline.
    this.refreshLinkRanges()

    // An underlined link can scroll away under a still pointer.
    if (this.hoveredLink) this.refreshLinkHover(true)

    // Skip with no context (repaints in full when it returns) or while
    // synchronized output holds the frame.
    if (
      this.needsRedraw &&
      !this.renderer.isContextLost &&
      this.wasm.exports.ghostty_render_state_is_held?.(this.termPtr) !== 1
    ) {
      // update() rebuilds the snapshot; mark_clean() resets damage afterward.
      this.wasm.exports.ghostty_render_state_update(this.termPtr)
      const scrollbackCount = this.snapshotScrollbackLength()
      // The depth the snapshot was taken at; see the field.
      this.snapshotScrollback = scrollbackCount
      this.pinViewport(scrollbackCount)
      // Cursor state comes off the same snapshot as the cells.
      const cursorVisible = this.wasm.exports.ghostty_render_state_get_cursor_visible(this.termPtr) !== 0
      const cursorCol = this.wasm.exports.ghostty_render_state_get_cursor_x(this.termPtr)
      const cursorRow = this.wasm.exports.ghostty_render_state_get_cursor_y(this.termPtr)
      // DECSCUSR blink: the core says whether to blink, our timer says when.
      const cursorBlinks =
        this.wasm.exports.ghostty_render_state_get_cursor_blinking(this.termPtr) !== 0
      this.renderer.cursor = cursorVisible
        ? {
            col: cursorCol,
            row: cursorRow,
            on: cursorBlinks ? this.cursorBlinkOn : true,
            focused: this.focused,
            // DECSCUSR shape.
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
      // Stay pending while held, so the next frame re-checks `is_held` (which is
      // where the hold timeout is enforced).
      this.needsRedraw = this.wasm.exports.ghostty_render_state_is_held?.(this.termPtr) === 1
      // Only frames that changed the canvas.
      if (this.onRenderHandlers.size > 0) {
        for (const h of this.onRenderHandlers) h()
      }
    }
  }

  private startRenderLoop = () => {
    // Must stay a loop condition: a rescheduling rAF would outlive the pane.
    if (!this.wasm || !this.renderer) return
    try {
      this.renderFrame()
    } catch (e) {
      // An exhausted core will fail every frame, so stop. Anything else is
      // treated as transient.
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
    // Canvas is draggable as an image by default, which steals input until
    // the drag ends (WebView2 won't cancel it on Esc). We do our own selection.
    this.canvas.draggable = false
    this.canvas.style.userSelect = 'none'
    this.canvas.style.setProperty('-webkit-user-select', 'none')
    this.canvas.style.setProperty('-webkit-user-drag', 'none')

    this.container.appendChild(this.canvas)

    this.canvas.addEventListener('wheel', (e) => {
      // Programs with mouse reporting get the wheel as buttons 4/5.
      if (this.mouse.tracking() && !e.shiftKey) {
        e.preventDefault()
        // Report whichever axis dominates.
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          this.mouse.reportWheelHorizontal(e, e.deltaX < 0)
        } else {
          this.mouse.reportWheel(e, e.deltaY < 0)
        }
        return
      }
      // The alternate screen has no scrollback; leave the event alone.
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

    // Capture phase, so mark mode sees keys before they're encoded.
    this.container.addEventListener('keydown', this.onMarkModeKey, true)

    // Only the focused pane blinks; idle background panes don't wake the loop.
    this.cursorBlinkTimer = setInterval(this.onBlinkTick, CURSOR_BLINK_MS)

    this.canvas.addEventListener('mousedown', (e) => {
      // Ctrl+press on a link outranks mouse reporting. Only the first click of a
      // run arms it, so Ctrl+double-click doesn't open the link twice.
      if (e.button === 0 && e.detail === 1 && GhosttyEngine.linkModifier(e)) {
        const at = this.getCoords(e)
        const link = this.links.linkAt(at)
        if (link) {
          this.pendingLink = { url: link.url, kind: link.kind, at }
          e.preventDefault()
          this.inputHandler?.focus()
          // Under mouse reporting there's nothing to select, so stop here.
          if (this.mouse.tracking()) return
        }
      }
      // Shift bypasses mouse reporting to reach our own selection.
      if (this.mouse.tracking() && !e.shiftKey) {
        e.preventDefault()
        this.inputHandler?.focus()
        this.mouse.reportPress(e)
        return
      }
      // Keep focus on the hidden textarea: a mousedown on the canvas would
      // otherwise move focus away and wedge the pane. preventDefault stops the
      // shift; focus() holds the keyboard.
      e.preventDefault()
      this.inputHandler?.focus()
      if (e.button !== 0) return // Only handle left-click for selection

      // The mouse takes over selection, so release the keyboard modes.
      this.markMode.cancel()
      this.hintMode.cancel()
      // `detail` counts clicks in a run.
      if (e.detail === 2) {
        this.selection.selectWordAt(this.getCoords(e))
        return
      }
      if (e.detail >= 3) {
        this.selection.selectLineAt(this.getCoords(e))
        return
      }
      // Shift extends the selection, but only without mouse reporting: there,
      // shift already means "give this drag to the terminal", and a fresh drag has
      // to keep working.
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
      // A selection in progress suppresses reporting.
      if (this.mouse.tracking() && !this.selection.isSelecting()) {
        this.mouse.reportMotion(e)
      }
      // Drag extension runs off the window listener so it continues off-canvas.
    })

    this.canvas.addEventListener('mouseleave', this.clearLinkHoverListener)
    // On the window: the modifier can be released while the keyboard is
    // elsewhere.
    window.addEventListener('keydown', this.onHoverModifierKey)
    window.addEventListener('keyup', this.onHoverModifierKey)

    this.inputHandler = new GhosttyInputHandler(this.container, (data) => {
      // Typing while scrolled up should show the prompt.
      this.scrollToBottom()
      // Keystrokes only, not the whole output channel: in the legacy mouse
      // format column 95 encodes as 0x7f.
      const out = translateBackspace(data, this.backspaceSendsCtrlH)
      for (const handler of this.onDataHandlers) {
        handler(out)
      }
      for (const handler of this.onInputHandlers) {
        handler(out)
      }
    }, () => this.keyEncoder)
    // Focus lives on the input handler's element.
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
    // Each pane is its own WASM instance; free the terminal's pages.
    if (this.wasm && this.termPtr) {
      // Encoders first: they hold the terminal's pointer.
      this.mouseEncoder?.dispose()
      this.mouseEncoder = null
      this.keyEncoder?.dispose()
      this.keyEncoder = null
      // Frees the search state held inside the terminal.
      this.nativeSearch?.dispose()
      this.nativeSearch = null
      this.oscStream?.dispose()
      this.oscStream = null
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
    this.onResetHandlers.clear()
    this.oscHandlers.clear()
  }

  /**
   * Whether the render loop may re-fit to the container. Benchmarks turn it off
   * to pin a grid larger than the container. Explicit `fit()` is unaffected.
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
      // A resize can provoke replies.
      this.drainResponses()
    }
    if (this.renderer) {
      this.renderer.resize(cols, rows, force)
    }
    // After the renderer, whose cell size this reads.
    this.syncMouseSurface()

    for (const handler of this.onResizeHandlers) {
      handler({ cols, rows })
    }
  }

  /** Hands one run of bytes to the parser, or queues it if the core is still
   *  loading. Buffered slices are copied: they outlive the caller's chunk. */
  private parseSegment(seg: Uint8Array): void {
    if (seg.length === 0) return
    if (!this.wasm) {
      // Core still loading: hold the bytes for initWasm. Bounded, because a core
      // that never loads would otherwise buffer forever behind a blank pane.
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

  /** Whether anything wants OSCs, bells or resets, which decides the write path. */
  private hasStreamHandlers(): boolean {
    return this.oscHandlers.size > 0 || this.onBellHandlers.size > 0 || this.onResetHandlers.size > 0
  }

  /**
   * Parses `bytes`, running each OSC handler after its sequence is parsed and
   * before anything after it, and bell and reset handlers in order with them.
   * Before the core loads the bytes are only buffered; `initWasm` replays them
   * through here.
   */
  private feed(bytes: Uint8Array): void {
    const stream = this.oscStream
    if (!this.wasm || !stream || !this.hasStreamHandlers()) {
      this.parseSegment(bytes)
      return
    }
    const wasm = this.wasm
    phases.time('parse', () =>
      stream.write(bytes, {
        stop: () => this.deliverCoreEvents(wasm),
        osc: (content) => this.dispatchOsc(content),
      }),
    )
  }

  /** Bells and resets the core counted during the write, handed on in order. */
  private deliverCoreEvents(wasm: GhosttyWasm): void {
    const bells = wasm.exports.ghostty_terminal_take_bells?.(this.termPtr) ?? 0
    const resets = wasm.exports.ghostty_terminal_take_resets?.(this.termPtr) ?? 0
    if (bells === 0 && resets === 0) return
    phases.time('bufferChange', () => this.notifyBufferChange())
    phases.time('handlers', () => {
      for (let i = 0; i < resets; i++) for (const h of this.onResetHandlers) h()
      for (let i = 0; i < bells; i++) for (const h of this.onBellHandlers) h()
    })
  }

  private dispatchOsc(content: Uint8Array): void {
    const osc = parseOsc(content, this.oscDecoder)
    if (!osc) return
    const handlers = this.oscHandlers.get(osc.ident)
    if (!handlers) return
    // Screen state must be current before a handler runs.
    phases.time('bufferChange', () => this.notifyBufferChange())
    phases.time('handlers', () => {
      for (const h of handlers) {
        // Claiming stops other handlers; the core still parses the bytes.
        if (h(osc.payload) === true) break
      }
    })
  }

  // Every write must reach the parser synchronously and in call order.
  write(data: Uint8Array | string): void {
    // A dead core: the failure was already reported.
    if (this.fatalError !== null) return
    this.needsRedraw = true
    this.bufferGen++

    // Strings and PTY bytes share one path.
    const bytes = typeof data === 'string' ? this.oscEncoder.encode(data) : data
    // Whole-write span, so unattributed time shows up.
    const startedAt = phases.now()

    // Caught: the caller is a PTY data callback with nowhere to put an exception.
    try {
      this.feed(bytes)

      // Drained per write: a reply must describe the state that provoked it.
      phases.time('drain', () => this.drainResponses())
    } catch (e) {
      this.failFatal(e)
      phases.recordWrite(bytes.length, phases.now() - startedAt)
      return
    }
    // Catches a screen switch in the trailing segment.
    phases.time('bufferChange', () => this.notifyBufferChange())
    phases.time('handlers', () => {
      for (const h of this.onWriteParsedHandlers) h()
    })
    phases.recordWrite(bytes.length, phases.now() - startedAt)
  }

  writeln(data: string): void {
    this.write(data + '\r\n')
  }

  /** Turns off modes a program left on when its session died; see
   *  `sessionModes.ts`. */
  resetSessionModes(): void {
    if (!this.wasm || !this.termPtr) return
    const onAlt = this.wasm.exports.ghostty_terminal_is_alternate_screen(this.termPtr) !== 0
    this.write(sessionModeReset(onAlt))
  }

  captureModes(): ModeSnapshot | null {
    if (!this.wasm || !this.termPtr || !this.keyEncoder) return null
    const ex = this.wasm.exports
    return {
      alt: ex.ghostty_terminal_is_alternate_screen(this.termPtr) !== 0,
      modes: new Map(SNAPSHOT_MODES.map((m) => [m, ex.ghostty_terminal_get_mode(this.termPtr, m, 0) !== 0])),
      keyboard: this.keyEncoder.probeProtocol(),
    }
  }

  /**
   * Called from inside an OSC handler mid-chunk, so this bypasses `write` to
   * avoid clobbering the chunk's carried-over bytes.
   */
  resetLeftoverModes(before: ModeSnapshot): void {
    let now = this.captureModes()
    if (!now) return
    if (now.alt && !before.alt) {
      this.parseSegment(this.oscEncoder.encode(LEAVE_ALT_SCREEN))
      now = this.captureModes()
      if (!now) return
    }
    const seq = leftoverModeReset(before, now)
    if (seq) this.parseSegment(this.oscEncoder.encode(seq))
    this.needsRedraw = true
    this.notifyBufferChange()
  }

  /**
   * Benchmark-only counterpart to xterm's async `parse`. Parsing is synchronous;
   * chunked only to avoid one huge WASM allocation, and never yields.
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

  /** Null and undefined both mean `^?`. */
  setBackspaceSendsCtrlH(enabled: boolean | null | undefined): void {
    this.backspaceSendsCtrlH = enabled === true
  }

  setResizePullsScrollback(pull: boolean): void {
    if (pull === this.resizePullsScrollback) return
    this.resizePullsScrollback = pull
    this.applyResizePull()
  }

  /** No-op until the terminal exists; `initWasm` applies it then. */
  private applyResizePull(): void {
    if (!this.wasm || !this.termPtr) return
    this.wasm.exports.ghostty_terminal_set_resize_pull_scrollback?.(
      this.termPtr,
      this.resizePullsScrollback ? 1 : 0,
    )
  }

  /** Whether the text can be pasted without asking (see `pasteIsSafe`), or null
   *  without a core. */
  isPasteSafe(text: string): boolean | null {
    if (!this.wasm || !hasPasteEncoder(this.wasm)) return null
    return pasteIsSafe(this.wasm, text)
  }

  paste(text: string): void {
    if (!this.wasm) return
    // A menu or shortcut above the engine may have taken the keyboard.
    this.inputHandler?.focus()
    this.scrollToBottom()
    // Bracketed paste is the one mode the encoder doesn't read itself.
    const bracketed =
      this.wasm.exports.ghostty_terminal_get_mode(this.termPtr, MODE_BRACKETED_PASTE, 0) !== 0
    // The encoder neutralizes an embedded bracket terminator.
    const payload = encodePaste(this.wasm, text, bracketed)
    for (const handler of this.onDataHandlers) {
      handler(payload)
    }
    for (const handler of this.onInputHandlers) {
      handler(payload)
    }
  }

  onData(handler: (data: Uint8Array) => void): IDisposable {
    this.onDataHandlers.add(handler)
    return { dispose: () => this.onDataHandlers.delete(handler) }
  }

  onInput(handler: (data: Uint8Array) => void): IDisposable {
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

  /**
   * A full reset (RIS, `ESC c`) in the stream, for host-side state the core
   * doesn't know about. Reported by the core's reset callback and handed on in
   * order with the OSC handlers; see `oscStream.ts`.
   */
  registerResetHandler(cb: () => void): IDisposable {
    this.onResetHandlers.add(cb)
    return { dispose: () => this.onResetHandlers.delete(cb) }
  }

  onSelectionChange(cb: () => void): IDisposable {
    this.onSelectionChangeHandlers.add(cb)
    return { dispose: () => this.onSelectionChangeHandlers.delete(cb) }
  }
  
  /**
   * Subscribe to an OSC ident. The core's parser finds each OSC
   * (`oscStream.ts`):
   *
   * - Returning `true` stops the remaining handlers but does not consume the
   *   sequence; the core still parses it. Promises never count as a claim.
   * - The handler runs with everything before the sequence already parsed. Prefer
   *   a dedicated event (onBufferChange) over reading state here.
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

    // Derive cols from the renderer's own cell width, which sizes the canvas;
    // measure directly only before a renderer exists.
    let cellWidth: number
    let cellHeight: number
    if (this.renderer) {
      const size = this.renderer.getCellSize()
      cellWidth = size.width
      cellHeight = size.height
    } else {
      const size = measureCell(this.fonts, this.fontSize)
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

  // Live theme changes only reach the default foreground/background: the core
  // resolves palette colors at parse time and has no setter (and rejects OSC 10
  // without an allocator). Palette-colored text keeps the old colors until it
  // scrolls away; new panes get the theme in full.
  setTheme(themeName: string, opacity: number, background?: string | null): void {
    this._themeName = themeName
    this._opacity = opacity
    this._background = background ?? null

    if (this.renderer) {
      this.applyThemeToRenderer(themeName)
      // The grid only rebuilds on damage.
      this.needsRedraw = true
    }
  }

  // Opacity is applied with the colors so a renderer rebuild (e.g. a font
  // change) restores both.
  private applyThemeToRenderer(themeName: string) {
    if (!this.renderer) return
    const theme = findTheme(themeName)
    const [fr, fg, fb] = hexToRgb(theme.foreground)
    // Only the backdrop takes the override; OSC 11 should still report the
    // theme's real background.
    const [br, bg, bb] = hexToRgb(this._background ?? theme.background)
    this.renderer.setTheme(fr, fg, fb, br, bg, bb, this._opacity)
    const [cr, cg, cb] = hexToRgb(theme.cursor)
    this.renderer.setCursorColor(cr, cg, cb)
  }
  /**
   * The default cursor, written into the core as DECSCUSR so an application's
   * own shape simply overrides it. The core also gets it at construction
   * (`TerminalConfig.cursorStyle`) and restores it after RIS; a change made after
   * a pane opens doesn't update that pane's reset default.
   */
  setCursorStyle(style: CursorStyleSetting, blink: boolean): void {
    this._cursorStyle = style
    this._cursorBlink = blink
    if (this.termPtr) this.write(cursorStyleSequence(style, blink))
  }

  /** Color space to blend glyph coverage in; applies to everything on screen. */
  setTextBlending(mode: TextBlending): void {
    this._textBlending = mode
    this.applyTextBlendingToRenderer()
    this.needsRedraw = true
  }

  private applyTextBlendingToRenderer(): void {
    this.renderer?.setTextBlending(BLEND_MODES[this._textBlending])
    // Also renderer state that a rebuild resets.
    this.renderer?.setLigatures(this._ligatures)
  }

  /** Whether to shape runs of operators together; applies to everything on
   *  screen. */
  setLigatures(on: boolean): void {
    this._ligatures = on
    this.renderer?.setLigatures(on)
    this.needsRedraw = true
  }

  /**
   * The faces and size to rasterize with. Every font setting comes through here
   * and rebuilds the renderer, so the atlas caches never outlive their config.
   */
  setFont(fonts: FontSelection, fontSize: number): void {
    this.fonts = fonts
    this.fontSize = fontSize
    if (this.renderer && this.canvas) {
      this.renderer.dispose()
      this.renderer = new WebGLRenderer(this.canvas, this._cols, this._rows, fonts, fontSize)
      this.renderer.onRestore = this.onRendererRestored
      // A fresh renderer starts on its own defaults; reapply the theme and blend.
      if (this._themeName) this.applyThemeToRenderer(this._themeName)
      this.applyTextBlendingToRenderer()
      // The new renderer starts with an empty instance buffer.
      this.needsRedraw = true
      // New face, new cell metrics.
      this.fit(true)
    }

    // A bundled family loads over a fetch, so the first measurement may be of
    // the fallback face. Re-apply once it lands; resolves false (no-op) when
    // nothing was pending.
    void bundledSettled([
      headFamily(fonts.regular),
      headFamily(fonts.bold),
      headFamily(fonts.italic),
      headFamily(fonts.boldItalic),
    ])
      .then((wasPending) => {
        if (wasPending && !this.disposed && this.fonts === fonts) {
          this.setFont(fonts, this.fontSize)
        }
      })
      .catch(() => {})
  }
  /** Applies to panes opened afterward: the core takes the limit at
   *  construction and has no setter. */
  setScrollbackBudget(footprintMB: number): void {
    this._scrollbackFootprintMB = footprintMB
  }

  /** The budget this pane was built with, which may differ from the current
   *  setting. */
  get scrollbackBudgetBytes(): number {
    return scrollbackBudgetBytesFor(this._scrollbackFootprintMB)
  }
  rebuildWebglRenderer(): void {}

  /**
   * Find in the whole buffer. Plain case-insensitive queries go to the core's
   * native search; regex and case-sensitive ones use `SearchController`.
   */
  search(query: string, options?: SearchOptions): void {
    // The core's matcher is byte-exact except for ASCII case. Its results
    // survive resizes, screen switches and pruning.
    const native = this.nativeSearch
    if (native && !options?.regex && !options?.caseSensitive) {
      // Only one path may own the highlights.
      this.searchController.clear()
      native.search(query, options)
      return
    }
    native?.clear()
    this.searchController.search(query, options)
  }

  /** Which of the absolute rows `fromAbs..toAbs` continue the row above them. */
  private readWrapFlags(fromAbs: number, toAbs: number): boolean[] {
    const out = new Array<boolean>(Math.max(0, toAbs - fromAbs + 1)).fill(false)
    if (!this.wasm || !this.termPtr) return out
    const wasm = this.wasm
    const scrollbackCount = wasm.exports.ghostty_terminal_get_scrollback_length(this.termPtr)
    // Callers may ask one row past the end of the buffer; those stay false.
    const lastAbs = Math.min(toAbs, scrollbackCount + this._rows - 1)
    for (let abs = Math.max(0, fromAbs); abs <= lastAbs; abs++) {
      out[abs - fromAbs] =
        abs < scrollbackCount
          ? wasm.exports.ghostty_terminal_is_scrollback_row_wrapped(this.termPtr, abs) !== 0
          : wasm.exports.ghostty_terminal_is_row_wrapped(this.termPtr, abs - scrollbackCount) !== 0
    }
    return out
  }

  /** Scrolls the viewport the least amount that brings `row` into view. */
  private revealRow(row: number) {
    const top = this.viewportY
    if (row >= top && row < top + this._rows) return
    const maxScroll = Math.max(0, this.scrollbackLength - this._rows)
    // Parked a third of the way down, for context above the hit.
    const target = Math.max(0, Math.min(row - Math.floor(this._rows / 3), maxScroll))
    this.scrollToLine(target)
  }

  /**
   * Scrolls the least amount that puts absolute `row` on screen. Unlike
   * `revealRow`, doesn't recenter, so walking a cursor doesn't lurch.
   */
  private scrollRowIntoView(row: number): void {
    const top = this.viewportY
    if (row < top) this.scrollToLine(row)
    else if (row >= top + this._rows) this.scrollToLine(row - this._rows + 1)
  }

  /** Cell size in CSS pixels, for placing DOM overlays; null before the
   *  renderer exists. */
  cellSize(): { width: number; height: number } | null {
    return this.renderer ? this.renderer.getCellSize() : null
  }

  /**
   * Rebuild the render snapshot for a read that isn't riding on a drawn frame,
   * such as prompt-input tracking on a keystroke. Doesn't `mark_clean`, which
   * would cost the pane its pending repaint.
   */
  syncReadState(): void {
    if (!this.wasm || !this.termPtr) return
    this.wasm.exports.ghostty_render_state_update(this.termPtr)
    // Record the snapshot and its depth together; see `snapshotScrollback`.
    this.snapshotScrollback = this.snapshotScrollbackLength()
  }

  /**
   * The scrollback depth the current render snapshot was taken at. Differs from
   * the live count under synchronized output.
   */
  private snapshotScrollbackLength(): number {
    const ex = this.wasm!.exports
    return (
      ex.ghostty_render_state_get_scrollback_length?.(this.termPtr) ??
      ex.ghostty_terminal_get_scrollback_length(this.termPtr)
    )
  }

  cursorCell(): { x: number; y: number } {
    return this.terminalCursorCell()
  }

  /** `readRows` under the engine-interface name; used by prompt-input tracking
   *  (see lib/promptInput.ts). */
  readRowText(fromAbs: number, toAbs: number): RowText[] {
    return this.readRows(fromAbs, toAbs)
  }

  /** The terminal cursor in absolute buffer coordinates. */
  private terminalCursorCell(): { x: number; y: number } {
    if (!this.wasm) return { x: 0, y: 0 }
    const screenTop = Math.max(0, this.scrollbackLength - this._rows)
    return {
      x: this.wasm.exports.ghostty_render_state_get_cursor_x(this.termPtr),
      y: screenTop + this.wasm.exports.ghostty_render_state_get_cursor_y(this.termPtr),
    }
  }

  /** Toggles keyboard selection; see `MarkModeController`. */
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
   * Toggles hint mode: the link path that works while a program owns the mouse,
   * or without a pointing device.
   */
  toggleHintMode(): void {
    if (!this.renderer) return
    // Both modes take the keyboard.
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

  /** A link was activated; see `activateLink`. */
  onLinkActivate(cb: (url: string) => void): IDisposable {
    this.onLinkActivateHandlers.add(cb)
    return { dispose: () => this.onLinkActivateHandlers.delete(cb) }
  }

  /** The URL under a pointer event, or null; for the context menu. */
  linkAtPointer(e: MouseEvent): string | null {
    if (!this.renderer || !this.withinCanvas(e)) return null
    const link = this.links.linkAt(this.getCoords(e))
    return link?.kind === 'url' ? link.url : null
  }

  /** The file path under a pointer event, or null; for the context menu. */
  pathAtPointer(e: MouseEvent): string | null {
    if (!this.renderer || !this.withinCanvas(e)) return null
    const link = this.links.linkAt(this.getCoords(e))
    return link?.kind === 'path' ? link.url : null
  }

  /** A path link was activated; the pane resolves it. */
  onPathActivate(cb: (path: string) => void): IDisposable {
    this.onPathActivateHandlers.add(cb)
    return { dispose: () => this.onPathActivateHandlers.delete(cb) }
  }

  /**
   * Whether file paths are links too, and their syntax (POSIX for SSH, Windows
   * for a local shell). Only enabled by panes that can open them.
   */
  setPathLinks(flavor: PathFlavor | null): void {
    if (flavor === this.pathLinks) return
    this.pathLinks = flavor
    this.links.invalidate()
    this.linkRangesSig = ''
    this.hoverSig = ''
    this.needsRedraw = true
  }

  /** Opens a URL from `linkAtPointer`, with the usual scheme check. */
  openLink(url: string): void {
    this.activateLink(url)
  }

  clearSearchDecorations(): void {
    this.searchController.clear()
    this.nativeSearch?.clear()
  }

  onResize(handler: (size: { cols: number; rows: number }) => void): IDisposable {
    this.onResizeHandlers.add(handler)
    return { dispose: () => this.onResizeHandlers.delete(handler) }
  }

  focus(): void {
    // A programmatic refocus clears an IME composition an app switch may have
    // stranded (which would drop all printable input). Clicks skip this.
    this.inputHandler?.cancelComposition()
    this.inputHandler?.focus()
  }

  /** See TerminalEngine.resetInputContext. */
  resetInputContext(): void {
    this.inputHandler?.resetForRefocus()
  }

  clearSelection(): void {
    // The mark cursor is drawn as the selection, so end mark mode too.
    this.markMode.cancel()
    // Don't notify when there was nothing to clear.
    if (!this.renderer || !this.renderer.selection) return
    this.selection.reset()
  }
  getSelection(): string {
    if (!this.renderer || !this.renderer.selection || !this.wasm) return ''
    // Copy isn't tied to a frame: if output landed since, rebuild the snapshot
    // or the selection's tail reads back blank. Conditional because
    // copy-on-select calls this on every drag update.
    if (
      this.wasm.exports.ghostty_terminal_get_scrollback_length(this.termPtr) !==
      this.snapshotScrollback
    ) {
      this.syncReadState()
    }
    return this.selection.text()
  }

  selectAll(): void {
    if (!this.renderer || !this.wasm) return
    const scrollbackCount = this.wasm.exports.ghostty_terminal_get_scrollback_length(this.termPtr)
    this.selection.selectAll(scrollbackCount + this._rows)
  }

  /**
   * Everything copy reads, as text, for diagnosing copies that come back with
   * runs missing on a row boundary. Copy joins `readRows` on `readWrapFlags` via
   * `SelectionController.text`; dumping all three shows which one went wrong.
   * Rows are JSON-quoted because trailing spaces matter, and the snapshot depth
   * is shown beside the live count because the two readers split on different
   * ones.
   */
  dumpState(): string {
    const lines: string[] = []
    if (!this.wasm || !this.termPtr) return 'no core: the engine has no terminal to dump\n'
    // Sampled before the sync, to show the gap a copy right now would hit.
    const liveBefore = this.wasm.exports.ghostty_terminal_get_scrollback_length(this.termPtr)
    const snapshotBefore = this.snapshotScrollback
    // Rebuilt so the rows describe the grid as it is now.
    this.syncReadState()

    const total = this.scrollbackLength
    const sel = this.renderer?.selection ?? null
    lines.push(`wrustty pane dump ${new Date().toISOString()}`)
    lines.push(`cols=${this._cols} rows=${this._rows}`)
    lines.push(`scrollbackLength=${total} viewportY=${this.viewportY} viewportOffset=${this._viewportOffset}`)
    lines.push(
      // -1 means no frame has drawn yet.
      `scrollbackRows: live=${liveBefore} lastFrameSnapshot=` +
        (snapshotBefore < 0 ? 'none yet' : String(snapshotBefore)) +
        (snapshotBefore < 0 || liveBefore === snapshotBefore
          ? ''
          : '  <-- MISMATCH, output landed since the last frame'),
    )
    lines.push(`altScreen=${this.wasm.exports.ghostty_terminal_get_mode(this.termPtr, MODE_ALT_SCREEN, 0) !== 0}`)
    // With mouse tracking on, a non-shift copy came from the program via
    // OSC 52, not from `readRows`.
    lines.push(`mouseTracking=${this.mouseTracking()} (a plain drag goes to the program, not this pane)`)
    const cur = this.terminalCursorCell()
    lines.push(`cursor=${cur.x},${cur.y}`)
    lines.push(
      sel
        ? `selection=(${sel.start.x},${sel.start.y})..(${sel.end.x},${sel.end.y})` +
            ` rectangular=${sel.rectangular === true}`
        : 'selection=none',
    )
    if (!sel) {
      // The selection beside its rows is what makes a dump useful; users tend to
      // reach for the shortcut after the selection is gone.
      lines.push(
        '  !! No selection was active, so this dump cannot show what copy produced.',
      )
      lines.push(
        '  !! Take one with the bad selection still made, before resizing the pane:',
      )
      lines.push('  !! copy, see the damage, then Ctrl+Shift+D without clicking again.')
    }
    // A resize between copy and dump reflows wrapped lines.
    lines.push(`geometry note: rows below are as they are at ${this._cols} columns`)

    // The selection plus a margin, not the whole buffer, so the shortcut stays
    // cheap. The margin shows wrongly joined neighbors.
    const MARGIN = 20
    const from = Math.max(0, (sel ? Math.min(sel.start.y, sel.end.y) : this.viewportY) - MARGIN)
    const to = Math.min(
      total - 1,
      (sel ? Math.max(sel.start.y, sel.end.y) : this.viewportY + this._rows - 1) + MARGIN,
    )
    const rows = this.readRows(from, to)
    // One past the end, as `SelectionController.text` asks.
    const wrapped = this.readWrapFlags(from, to + 1)
    lines.push('')
    lines.push(
      `rows ${from}..${to} of ${total}; "cont" marks a row the previous one runs into`,
    )
    for (let i = 0; i < rows.length; i++) {
      const cont = wrapped[i] === true ? 'cont' : '    '
      lines.push(`${String(from + i).padStart(6)} ${cont} ${JSON.stringify(rows[i].text)}`)
    }
    lines.push(`${String(to + 1).padStart(6)} ${wrapped[rows.length] === true ? 'cont' : '    '} (row after the last, flag only)`)

    lines.push('')
    lines.push(
      this.rowReadFailures.length === 0
        ? 'row reads: all rows above came back from the core'
        : `row reads: ${this.rowReadFailures.length} FAILED and read as blank — ` +
          GhosttyEngine.summariseRowFailures(this.rowReadFailures),
    )

    lines.push('')
    lines.push('selection text, as copy would put it on the clipboard:')
    lines.push(JSON.stringify(this.getSelection()))
    lines.push('')
    return lines.join('\n')
  }
}
