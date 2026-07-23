import type { TerminalEngine } from '../terminalEngine'
import type { IDisposable } from '@xterm/xterm'
import { WebGLRenderer, measureCell } from './WebGLRenderer'
import { findTheme, hexToRgb, type TerminalTheme } from '../theme'
import {
  instantiateGhosttyWasm,
  createTerminal,
  writeBytes,
  writeString,
  MODE_APP_CURSOR_KEYS,
  MODE_BRACKETED_PASTE,
  type GhosttyWasm,
} from './wasmBindings'
import { GhosttyInputHandler } from './GhosttyInputHandler'
// Resolved from the pinned `ghostty-web` dependency rather than a binary
// copied into public/ — the version that runs is the one in the lockfile.
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url'

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
  get scrollbackLength(): number { return 1000 }
  get viewportY(): number { return 0 }

  private _cols = 80
  private _rows = 24
  private _scrollback = 1000
  private _themeName: string | null = null

  constructor() {
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
        scrollbackLimit: this._scrollback,
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
    }

    if (this.needsRedraw) {
      // update() rebuilds the render snapshot and has to run before the
      // viewport is read; mark_clean() afterwards resets the damage state.
      this.wasm.exports.ghostty_render_state_update(this.termPtr)
      this.renderer.updateStaticGrid(this.wasm, this.termPtr)
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
    this.canvas.tabIndex = 0
    
    this.container.appendChild(this.canvas)
    
    this.inputHandler = new GhosttyInputHandler(this.canvas, (data) => {
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
    
    if (this.wasm) {
      this.setupRenderer()
    }
  }

  unmount(): void {
    cancelAnimationFrame(this.renderLoopId)
    this.inputHandler?.dispose()
    if (this.canvas && this.container) {
      this.container.removeChild(this.canvas)
    }
    this.renderer?.dispose()
    this.renderer = null
  }

  dispose(): void {
    this.disposed = true
    this.unmount()
    this.onDataHandlers.clear()
    this.onResizeHandlers.clear()
  }

  resize(cols: number, rows: number, force = false): void {
    if (cols === this._cols && rows === this._rows && !force) return
    this._cols = cols
    this._rows = rows
    this.needsRedraw = true
    
    if (this.wasm && this.termPtr) {
      this.wasm.exports.ghostty_terminal_resize(this.termPtr, cols, rows)
    }
    if (this.renderer) {
      this.renderer.resize(cols, rows, force)
    }
    
    for (const handler of this.onResizeHandlers) {
      handler({ cols, rows })
    }
  }

  // Every write has to reach the parser synchronously and in call order. PTY
  // output arrives here as bytes and local messages (writeln, the line editor)
  // as strings; routing the string case through a dynamic `import()` put it a
  // microtask behind every byte write issued after it, so a status line could
  // land in the middle of a later chunk and leave that chunk's SGR state
  // applied to output it was never meant to color.
  write(data: Uint8Array | string): void {
    this.needsRedraw = true
    if (!this.wasm) {
      this.writeBuffer.push(data)
    } else if (typeof data === 'string') {
      writeString(this.wasm, this.termPtr, data)
    } else {
      writeBytes(this.wasm, this.termPtr, data)
    }
  }

  writeln(data: string): void {
    this.write(data + '\r\n')
  }

  paste(text: string): void {
    if (!this.wasm) return
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

  onWriteParsed(_cb: () => void): IDisposable { return { dispose: () => {} } }
  onScroll(_cb: (newPos: number) => void): IDisposable { return { dispose: () => {} } }
  onBufferChange(_cb: (isAlternate: boolean) => void): IDisposable { return { dispose: () => {} } }
  onBell(_cb: () => void): IDisposable { return { dispose: () => {} } }
  onSelectionChange(_cb: () => void): IDisposable { return { dispose: () => {} } }
  registerOscHandler(_ident: number, _cb: (data: string) => boolean | Promise<boolean>): IDisposable { return { dispose: () => {} } }
  onSearchResult(_cb: (result: { index: number; count: number }) => void): IDisposable { return { dispose: () => {} } }

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
  scrollLines(_amount: number): void {}
  scrollToLine(_line: number): void {}

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
  setTheme(themeName: string, _opacity: number): void {
    this._themeName = themeName

    if (this.renderer) {
      this.applyThemeToRenderer(themeName)
      // The grid is only rebuilt on damage, so without this an idle pane keeps
      // its old palette until the next byte arrives.
      this.needsRedraw = true
    }
  }
  
  private applyThemeToRenderer(themeName: string) {
    if (!this.renderer) return
    const theme = findTheme(themeName)
    const [fr, fg, fb] = hexToRgb(theme.foreground)
    const [br, bg, bb] = hexToRgb(theme.background)
    this.renderer.setTheme(fr, fg, fb, br, bg, bb)
  }
  setFont(fontFamily: string, fontSize: number): void {
    this.fontFamily = fontFamily
    this.fontSize = fontSize
    if (this.renderer && this.canvas) {
      this.renderer.dispose()
      this.renderer = new WebGLRenderer(this.canvas, this._cols, this._rows, fontFamily, fontSize)
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
  setScrollback(scrollback: number): void {
    this._scrollback = scrollback
  }
  rebuildWebglRenderer(): void {}
  search(_query: string, _options?: any): void {}
  clearSearchDecorations(): void {}


  onResize(handler: (size: { cols: number; rows: number }) => void): IDisposable {
    this.onResizeHandlers.add(handler)
    return { dispose: () => this.onResizeHandlers.delete(handler) }
  }

  focus(): void {
    this.canvas?.focus()
  }

  hasSelection(): boolean {
    return false
  }

  clearSelection(): void {}
  getSelection(): string { return "" }
  selectAll(): void {}
  findNext(_term: string): boolean { return false }
  findPrevious(_term: string): boolean { return false }
}
