import type { TerminalEngine } from '../terminalEngine'
import type { IDisposable } from '@xterm/xterm'
import { WebGLRenderer } from './WebGLRenderer'
import { findTheme, hexToRgb } from '../theme'
import { instantiateGhosttyWasm, writeBytes, type GhosttyWasm } from './wasmBindings'
import { GhosttyInputHandler } from './GhosttyInputHandler'

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
  
  get cols(): number { return this._cols }
  get rows(): number { return this._rows }
  get scrollbackLength(): number { return 1000 }
  get viewportY(): number { return 0 }

  private _cols = 80
  private _rows = 24

  constructor() {
    this.initWasm()
  }

  private async initWasm() {
    try {
      const response = await fetch('/ghostty-vt.wasm')
      const bytes = await response.arrayBuffer()
      this.wasm = await instantiateGhosttyWasm(bytes)
      
      this.termPtr = this.wasm.exports.init(this._cols, this._rows, 1000)
      
      // Flush buffered writes
      for (const data of this.writeBuffer) {
        if (typeof data === 'string') {
          import('./wasmBindings').then(({ writeString }) => writeString(this.wasm!, this.termPtr, data))
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
    if (!this.canvas || !this.wasm) return
    
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
    
    this.startRenderLoop()
  }

  private startRenderLoop = () => {
    if (!this.wasm || !this.renderer) return
    
    if (this.needsRedraw) {
      this.wasm.exports.update(this.termPtr)
      this.renderer.updateStaticGrid(this.wasm, this.termPtr)
      this.wasm.exports.clear_dirty(this.termPtr)
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
      return this.wasm ? this.wasm.exports.cursor_keys_app(this.termPtr) !== 0 : false
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
      this.wasm.exports.resize(this.termPtr, cols, rows)
    }
    if (this.renderer) {
      this.renderer.resize(cols, rows, force)
    }
    
    for (const handler of this.onResizeHandlers) {
      handler({ cols, rows })
    }
  }

  write(data: Uint8Array | string): void {
    this.needsRedraw = true
    if (!this.wasm) {
      this.writeBuffer.push(data)
    } else {
      if (typeof data === 'string') {
        import('./wasmBindings').then(({ writeString }) => writeString(this.wasm!, this.termPtr, data))
      } else {
        writeBytes(this.wasm, this.termPtr, data)
      }
    }
  }

  writeln(data: string): void {
    this.write(data + '\r\n')
  }

  paste(text: string): void {
    if (!this.wasm) return
    const bracketed = this.wasm.exports.bracketed_paste(this.termPtr) !== 0
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
    if (!this.container) return
    
    // Calculate cell size directly instead of relying on the renderer
    // so we can fit even while WASM is still loading.
    const measureCtx = document.createElement('canvas').getContext('2d')!
    measureCtx.font = `${this.fontSize}px ${this.fontFamily}`
    const metrics = measureCtx.measureText('W')
    const cellWidth = Math.ceil(metrics.width)
    const cellHeight = Math.ceil(this.fontSize * 1.2)
    
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
  
  private _themeName: string | null = null

  setTheme(themeName: string, _opacity: number): void {
    this._themeName = themeName
    if (this.renderer) {
      this.applyThemeToRenderer(themeName)
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
    }
  }
  setScrollback(_scrollback: number): void {}
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
