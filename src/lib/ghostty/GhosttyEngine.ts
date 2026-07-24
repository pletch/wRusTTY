import type { TerminalEngine, SearchOptions, SearchResult } from '../terminalEngine'
import type { SearchHighlight } from './WebGLRenderer'
import type { IDisposable } from '@xterm/xterm'
import { WebGLRenderer, measureCell } from './WebGLRenderer'
import { findTheme, hexToRgb, type TerminalTheme } from '../theme'
import {
  instantiateGhosttyWasm,
  createTerminal,
  writeBytes,
  writeString,
  readResponse,
  parseCell,
  MODE_APP_CURSOR_KEYS,
  MODE_BRACKETED_PASTE,
  MODE_MOUSE_BUTTON_EVENT,
  MODE_MOUSE_ANY_EVENT,
  MODE_MOUSE_SGR,
  type GhosttyWasm,
  CELL_BYTES,
} from './wasmBindings'
import { GhosttyInputHandler } from './GhosttyInputHandler'
// Resolved from the pinned `ghostty-web` dependency rather than a binary
// copied into public/ — the version that runs is the one in the lockfile.
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url'

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

/**
 * `scrollbackLimit` in the core's config is a **byte budget**, not a row count
 * — the name reads like xterm's `scrollback` and it is not. Passing the app's
 * row setting straight through is why 10000 behaved like a few hundred lines:
 * the core took it as 10 KB, which is under its minimum page and so retained a
 * single page's worth of rows no matter what the setting said.
 *
 * Measured against this WASM build (rows retained at a fixed budget, swept
 * across widths) the cost is ~14.5 bytes per cell; 16 is that with headroom.
 * Rows are therefore only as promised at the width the pane was opened at —
 * widening it later trades rows for columns out of the same budget, which is
 * how Ghostty itself behaves.
 *
 * The floor is the core's own minimum, below which the setting does nothing.
 * The ceiling is this side's: the budget is committed for the life of the pane
 * and every pane is its own WASM instance, so an unguarded setting is a
 * per-pane memory multiplier across a window full of sessions.
 */
const SCROLLBACK_BYTES_PER_CELL = 16
const SCROLLBACK_MIN_BYTES = 1024 * 1024
const SCROLLBACK_MAX_BYTES = 64 * 1024 * 1024

function scrollbackBytesFor(rows: number, cols: number): number {
  const bytes = Math.max(1, rows) * Math.max(1, cols) * SCROLLBACK_BYTES_PER_CELL
  return Math.min(Math.max(bytes, SCROLLBACK_MIN_BYTES), SCROLLBACK_MAX_BYTES)
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
  
  private writeBuffer: (string | Uint8Array)[] = []
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
  private _themeName: string | null = null
  private _opacity = 1
  private _viewportOffset = 0
  private onScrollHandlers = new Set<(newPos: number) => void>()
  private onWriteParsedHandlers = new Set<() => void>()
  
  private isSelecting = false
  private selectionStart: {x: number, y: number} | null = null
  private onSelectionChangeHandlers = new Set<() => void>()
  private oscScannerBuffer = ''
  private scanDecoder = new TextDecoder()
  private responseDecoder = new TextDecoder()
  private oscHandlers = new Map<number, ((data: string) => void)[]>()
  private onBellHandlers = new Set<() => void>()
  private onBufferChangeHandlers = new Set<(isAlternate: boolean) => void>()
  private lastIsAlternate = false

  private onSearchResultHandlers = new Set<(result: SearchResult) => void>()
  private searchMatches: { row: number; from: number; to: number }[] = []
  private searchIndex = -1
  private searchSignature = ''
  private searchGen = -1
  /** Bumped whenever the buffer changes, so a cached search knows it is stale. */
  private bufferGen = 0

  private cursorBlinkOn = true
  private cursorBlinkTimer: ReturnType<typeof setInterval> | null = null
  private focused = false

  private mouseButtonDown: number | null = null
  private lastMouseCol = -1
  private lastMouseRow = -1
  /** Scrollback depth as of the last frame, for keeping a scrolled view still. */
  private lastScrollbackCount = 0

  constructor() {
    GhosttyEngine.liveEngines.add(this)
    this.initWasm()
  }

  private async initWasm() {
    try {
      const response = await fetch(ghosttyWasmUrl)
      const bytes = await response.arrayBuffer()
      this.wasm = await instantiateGhosttyWasm(bytes)

      // Colors go in at construction so the core resolves every cell against
      // this theme's palette and defaults, and hands back finished RGB. The
      // renderer therefore never has to know what "color 4" means.
      this.termPtr = createTerminal(this.wasm, this._cols, this._rows, {
        scrollbackLimit: scrollbackBytesFor(this._scrollback, this._cols),
        ...this.themeConfigColors(),
      })
      if (this.termPtr === 0) {
        console.error('Failed to create Ghostty terminal')
        return
      }

      // Flush buffered writes. Both branches have to stay synchronous: the
      // parser is a single state machine fed in byte order, so deferring one
      // kind of write by even a microtask replays this buffer out of order.
      for (const data of this.writeBuffer) {
        if (typeof data === 'string') {
          writeString(this.wasm, this.termPtr, data)
        } else {
          writeBytes(this.wasm, this.termPtr, data)
        }
      }
      this.writeBuffer = []
      
      if (this.canvas) {
        this.setupRenderer()
      }
    } catch (e) {
      console.error("Failed to initialize Ghostty WASM:", e)
    }
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

  private toggleCursorBlink = () => {
    if (!this.focused) return
    this.cursorBlinkOn = !this.cursorBlinkOn
    this.needsRedraw = true
  }

  private onFocus = () => {
    this.focused = true
    // Coming back mid-blink would otherwise show a gap where the cursor is.
    this.cursorBlinkOn = true
    this.needsRedraw = true
  }

  private onBlur = () => {
    this.focused = false
    this.needsRedraw = true
    // A button released outside the window never reaches us, and a stuck
    // "still held" would keep reporting drags on the next hover.
    this.mouseButtonDown = null
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
   * Per-column text for a range of absolute buffer rows — scrollback rows
   * first, then the active screen, the same numbering the renderer draws from.
   * A blank column comes back as a space and the trailing half of a wide
   * character as an empty string, so `row.length` is always the column count
   * and `row[c]` is what column `c` actually shows.
   *
   * Copy, word selection and search all need exactly this, and each had (or
   * would have had) its own partial version of the cell walk — including the
   * spacer and grapheme handling that made copied text wrong.
   */
  private readRows(fromAbs: number, toAbs: number): string[][] {
    const out: string[][] = []
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

    const viewPtr = wasm.exports.ghostty_wasm_alloc_u8_array(viewSize)
    if (viewPtr === 0) return out
    wasm.exports.ghostty_render_state_get_viewport(this.termPtr, viewPtr, cellCount)
    const linePtr = wasm.exports.ghostty_wasm_alloc_u8_array(lineSize)
    const gPtr = wasm.exports.ghostty_wasm_alloc_u8_array(gCap * 4)

    // Every view is built after the last allocation: growing WASM memory
    // detaches the buffer any earlier one was made against.
    const viewV = new DataView(wasm.exports.memory.buffer, viewPtr, viewSize)
    const lineV = linePtr !== 0 ? new DataView(wasm.exports.memory.buffer, linePtr, lineSize) : null
    const gV = gPtr !== 0 ? new DataView(wasm.exports.memory.buffer, gPtr, gCap * 4) : null

    for (let abs = fromAbs; abs <= toAbs; abs++) {
      const row: string[] = new Array(this._cols).fill(' ')
      out.push(row)
      if (abs < 0) continue

      let isScrollback = false
      let activeRow = 0
      if (abs < scrollbackCount) {
        if (!lineV) continue
        wasm.exports.ghostty_terminal_get_scrollback_line(this.termPtr, abs, linePtr, wasmCols)
        isScrollback = true
      } else {
        activeRow = abs - scrollbackCount
        if (activeRow >= wasmRows) continue
      }

      const view = isScrollback ? lineV! : viewV
      for (let c = 0; c < this._cols && c < wasmCols; c++) {
        const offset = isScrollback ? c * CELL_BYTES : (activeRow * wasmCols + c) * CELL_BYTES
        const cell = parseCell(view, offset)
        if (cell.width === 0) {
          // Trailing half of a wide character: it has no text of its own.
          row[c] = ''
        } else if (cell.graphemeLen > 0 && gV) {
          const n = isScrollback
            ? wasm.exports.ghostty_terminal_get_scrollback_grapheme(this.termPtr, abs, c, gPtr, gCap)
            : wasm.exports.ghostty_render_state_get_grapheme(this.termPtr, activeRow, c, gPtr, gCap)
          if (n > 0) {
            let s = ''
            for (let i = 0; i < n && i < gCap; i++) s += String.fromCodePoint(gV.getUint32(i * 4, true))
            row[c] = s
          } else {
            row[c] = cell.codepoint > 0 ? String.fromCodePoint(cell.codepoint) : ' '
          }
        } else {
          row[c] = cell.codepoint > 0 ? String.fromCodePoint(cell.codepoint) : ' '
        }
      }
    }

    if (gPtr !== 0) wasm.exports.ghostty_wasm_free_u8_array(gPtr, gCap * 4)
    if (linePtr !== 0) wasm.exports.ghostty_wasm_free_u8_array(linePtr, lineSize)
    wasm.exports.ghostty_wasm_free_u8_array(viewPtr, viewSize)
    return out
  }

  /**
   * What counts as one word for double-click. Deliberately wider than
   * alphanumerics: the things worth grabbing out of a terminal in one gesture
   * are paths, flags, hostnames and URLs, and stopping at every `/` or `.`
   * turns picking up a path into several drags.
   */
  private static isWordChar(s: string): boolean {
    if (s.length === 0) return false
    const c = s.codePointAt(0)!
    if (c > 127) return true // CJK, accented letters, and the like
    return /[A-Za-z0-9_\-./:@~+=%?&#]/.test(s[0])
  }

  private selectWordAt(pos: { x: number; y: number }) {
    if (!this.renderer) return
    const row = this.readRows(pos.y, pos.y)[0]
    if (!row) return
    // A wide character's spacer holds no text, so the head it belongs to is one
    // column back.
    let at = pos.x
    if (row[at] === '' && at > 0) at--
    if (!GhosttyEngine.isWordChar(row[at])) return
    let from = at
    while (from > 0 && GhosttyEngine.isWordChar(row[from - 1] || ' ')) from--
    let to = at
    while (to < row.length - 1 && GhosttyEngine.isWordChar(row[to + 1] || ' ')) to++
    this.applySelection({ x: from, y: pos.y }, { x: to, y: pos.y })
  }

  private selectLineAt(pos: { x: number; y: number }) {
    this.applySelection({ x: 0, y: pos.y }, { x: this._cols - 1, y: pos.y })
  }

  private applySelection(start: { x: number; y: number }, end: { x: number; y: number }) {
    if (!this.renderer) return
    this.renderer.selection = { start, end }
    // Left dangling, a later drag would extend from wherever the last one began.
    this.selectionStart = null
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
      for (const h of this.onSelectionChangeHandlers) h()
    }
  }

  private startRenderLoop = () => {
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
        this.fit()
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
      this.renderer.cursor = cursorVisible
        ? { col: cursorCol, row: cursorRow, on: this.cursorBlinkOn, focused: this.focused }
        : null
      // Keeps the IME's candidate window with the text being composed.
      if (this.inputHandler) {
        const cell = this.renderer.getCellSize()
        this.inputHandler.setCursorPosition(cursorCol * cell.width, cursorRow * cell.height)
      }
      this.renderer.updateStaticGrid(this.wasm, this.termPtr, this._viewportOffset, scrollbackCount)
      this.wasm.exports.ghostty_render_state_mark_clean(this.termPtr)
      this.needsRedraw = false
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
    this.cursorBlinkTimer = setInterval(this.toggleCursorBlink, CURSOR_BLINK_MS)

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
      if (e.button !== 0) return // Only handle left-click for selection
      // The canvas is no longer focusable — input lives on the handler's
      // element — so clicking the terminal has to hand focus over explicitly.
      this.inputHandler?.focus()
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
      this.isSelecting = true
      this.selectionStart = this.getCoords(e)
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
        this.renderer.selection = { start: this.selectionStart, end: this.getCoords(e) }
        this.needsRedraw = true
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
    this.onDataHandlers.clear()
    this.onResizeHandlers.clear()
    this.onScrollHandlers.clear()
    this.onWriteParsedHandlers.clear()
    this.onSelectionChangeHandlers.clear()
    this.onBellHandlers.clear()
    this.oscHandlers.clear()
    this.oscScannerBuffer = ''
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
  // handlers and pays nothing. Delete this whole path once libghostty-vt
  // exposes OSC 133 and bell callbacks.
  //
  // One expression matches either a complete OSC or a bare BEL, so they are
  // seen in stream order and an OSC's own BEL terminator can't be mistaken for
  // a bell. The payload deliberately can't span BEL or ESC: that's what bounds
  // the match, and it's what an unterminated sequence would otherwise run past.
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  private static readonly OSC_OR_BEL = /\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)|\x07/g

  private scanForOsc(chunk: string) {
    const buf = this.oscScannerBuffer + chunk
    const re = GhosttyEngine.OSC_OR_BEL
    re.lastIndex = 0

    let match: RegExpExecArray | null
    let consumed = 0
    while ((match = re.exec(buf)) !== null) {
      if (match[1] !== undefined) {
        const handlers = this.oscHandlers.get(parseInt(match[1], 10))
        if (handlers) {
          for (const h of handlers) h(match[2])
        }
      } else {
        for (const h of this.onBellHandlers) h()
      }
      consumed = match.index + match[0].length
    }

    // Only an unterminated OSC needs to survive into the next chunk. Slicing to
    // a fixed tail instead used to cut a sequence in half and corrupt whatever
    // matched next; anything before the last introducer is already resolved.
    const tail = consumed > 0 ? buf.slice(consumed) : buf
    const pending = tail.lastIndexOf('\x1b]')
    this.oscScannerBuffer = pending === -1 ? '' : tail.slice(pending)
    // A sequence this long is not going to terminate. Drop it rather than grow
    // without bound.
    if (this.oscScannerBuffer.length > 4096) this.oscScannerBuffer = ''
  }

  // Every write has to reach the parser synchronously and in call order. PTY
  // output arrives here as bytes and local messages (writeln, the line editor)
  // as strings; routing the string case through a dynamic `import()` put it a
  // microtask behind every byte write issued after it, so a status line could
  // land in the middle of a later chunk and leave that chunk's SGR state
  // applied to output it was never meant to color.
  write(data: Uint8Array | string): void {
    this.needsRedraw = true
    this.bufferGen++

    if (this.oscHandlers.size > 0 || this.onBellHandlers.size > 0) {
      // Streaming, so a multi-byte character split across two chunks decodes
      // once rather than as two replacement characters.
      this.scanForOsc(
        typeof data === 'string' ? data : this.scanDecoder.decode(data, { stream: true }),
      )
    }

    if (!this.wasm) {
      this.writeBuffer.push(data)
    } else if (typeof data === 'string') {
      writeString(this.wasm, this.termPtr, data)
    } else {
      writeBytes(this.wasm, this.termPtr, data)
    }
    // Drained here rather than on the frame: a reply is only correct for the
    // state that provoked it, and a cursor-position report that waits for the
    // next repaint can describe a cursor that has already moved on.
    this.drainResponses()
    // Checked on the write that could have caused it rather than per frame:
    // switching screens is a parse-time event, and an idle pane shouldn't be
    // asking the core about it sixty times a second.
    if (this.wasm) {
      const isAlt = this.wasm.exports.ghostty_terminal_is_alternate_screen(this.termPtr) !== 0
      if (isAlt !== this.lastIsAlternate) {
        this.lastIsAlternate = isAlt
        for (const h of this.onBufferChangeHandlers) h(isAlt)
      }
    }
    for (const h of this.onWriteParsedHandlers) h()
  }

  writeln(data: string): void {
    this.write(data + '\r\n')
  }

  paste(text: string): void {
    if (!this.wasm) return
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
  
  registerOscHandler(ident: number, cb: (data: string) => boolean | Promise<boolean>): IDisposable {
    let handlers = this.oscHandlers.get(ident)
    if (!handlers) {
      handlers = []
      this.oscHandlers.set(ident, handlers)
    }
    handlers.push(cb as any)
    return {
      dispose: () => {
        const idx = handlers!.indexOf(cb as any)
        if (idx !== -1) handlers!.splice(idx, 1)
      }
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

  private findMatches(re: RegExp): { row: number; from: number; to: number }[] {
    const total = this.scrollbackLength
    const rows = this.readRows(0, total - 1)
    const out: { row: number; from: number; to: number }[] = []

    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i]
      // A column can hold more than one character (a grapheme cluster), so the
      // offset a match reports is not a column. This maps back.
      let text = ''
      const columnAt: number[] = []
      for (let c = 0; c < cells.length; c++) {
        for (let k = 0; k < cells[c].length; k++) columnAt.push(c)
        text += cells[c]
      }

      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) {
          // A pattern that can match nothing would otherwise spin here.
          re.lastIndex++
          continue
        }
        const from = columnAt[m.index]
        const to = columnAt[Math.min(m.index + m[0].length - 1, columnAt.length - 1)]
        if (from !== undefined && to !== undefined) out.push({ row: i, from, to })
      }
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
        const m = this.searchMatches[i]
        let list = byRow.get(m.row)
        if (!list) byRow.set(m.row, (list = []))
        list.push({ from: m.from, to: m.to, active: i === this.searchIndex })
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
    this.inputHandler?.focus()
  }

  clearSelection(): void {
    if (!this.renderer || !this.renderer.selection) return
    this.renderer.selection = null
    this.selectionStart = null
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

    const rows = this.readRows(selStart.y, selEnd.y)
    const parts: string[] = []
    for (let i = 0; i < rows.length; i++) {
      const abs = selStart.y + i
      const from = abs === selStart.y ? selStart.x : 0
      const to = abs === selEnd.y ? selEnd.x : this._cols - 1
      const text = rows[i].slice(from, to + 1).join('')
      // Trailing blanks are padding the grid, not content — but the last row
      // keeps them, since a selection that ends mid-run of spaces selected them
      // on purpose.
      parts.push(abs === selEnd.y ? text : text.replace(/\s+$/, ''))
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
