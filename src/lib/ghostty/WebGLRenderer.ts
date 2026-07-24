import {
  GlyphAtlas,
  GLYPH_BOLD,
  GLYPH_ITALIC,
  GLYPH_UNDERLINE,
  GLYPH_STRIKETHROUGH,
  GLYPH_WIDE,
  type GlyphRect,
} from './GlyphAtlas'
import {
  parseCell,
  CELL_BYTES,
  CELL_INVERSE,
  CELL_BOLD,
  CELL_ITALIC,
  CELL_UNDERLINE,
  CELL_STRIKETHROUGH,
  CELL_FAINT,
  CELL_INVISIBLE,
  type GhosttyWasm,
} from './wasmBindings'

const VERTEX_SHADER_SRC = `#version 300 es
layout(location = 0) in vec2 a_position; // (0,0) to (1,1)
layout(location = 1) in vec2 a_cellPos;  // (col, row)
layout(location = 2) in vec4 a_fgColor;  // (r,g,b,a)
layout(location = 3) in vec4 a_bgColor;  // (r,g,b,a)
layout(location = 4) in vec4 a_uv;       // (u0,v0, u1,v1)

uniform vec2 u_resolution; // (cols, rows)

out vec4 v_fgColor;
out vec4 v_bgColor;
out vec2 v_uv;

void main() {
    v_fgColor = a_fgColor / 255.0;
    v_bgColor = a_bgColor / 255.0;

    v_uv = mix(a_uv.xy, a_uv.zw, a_position);

    vec2 pos = a_cellPos + a_position;
    vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
    clip.y = -clip.y; // top-left origin

    gl_Position = vec4(clip, 0.0, 1.0);
}
`

// Glyph coverage and cell background resolve in one pass. The alpha channel is
// mixed along with the colour, so a glyph stays opaque even where it sits on a
// translucent default background — that is what lets the pane's opacity reach
// the clear colour without also fading the text.
const FRAGMENT_SHADER_SRC = `#version 300 es
precision mediump float;

in vec4 v_fgColor;
in vec4 v_bgColor;
in vec2 v_uv;

uniform sampler2D u_atlas;

out vec4 outColor;

void main() {
    // Single-channel atlas: coverage is in red, and .a would read as 1.0.
    float alpha = texture(u_atlas, v_uv).r;
    outColor = mix(v_bgColor, v_fgColor, alpha);
}
`

/**
 * The one place cell metrics are derived. Both the renderer (which sizes the
 * canvas as `cols * cellWidth`) and the engine's fit (which derives cols from
 * the container) have to agree to the pixel: when they measured separately,
 * cols came from one width and the canvas from another, and nothing — not
 * re-fitting, not resizing the window — could reconcile them.
 */
export function measureCell(fontFamily: string, fontSize: number): { width: number; height: number } {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.font = `${fontSize}px ${fontFamily}`
  return {
    width: Math.ceil(ctx.measureText('W').width),
    height: Math.ceil(fontSize * 1.2),
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

/**
 * Codepoints read back for one grapheme cluster. Real clusters — a letter and
 * its marks, or an emoji and its joiners — are a handful; a longer one is
 * truncated rather than sized for, since this buffer is held for the pane's
 * lifetime.
 */
const GRAPHEME_CAP = 16

export interface SelectionRange {
  /** Absolute buffer coordinates — row counts from the top of scrollback. */
  start: { x: number; y: number }
  end: { x: number; y: number }
}

export interface SearchHighlight {
  from: number
  to: number
  /** The one the viewport is parked on, painted brighter than the rest. */
  active: boolean
}

// Matching the xterm engine's SEARCH_DECORATIONS, so switching engines doesn't
// change what a hit looks like.
const SEARCH_MATCH_BG = [0x5c, 0x4a, 0x1c]
const SEARCH_ACTIVE_BG = [0xd9, 0xa4, 0x41]

export interface CursorState {
  /** Viewport coordinates — the row as currently displayed, not absolute. */
  col: number
  row: number
  /** A blinked-off or unfocused cursor still occupies its cell. */
  on: boolean
  focused: boolean
}

export class WebGLRenderer {
  private canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private atlas!: GlyphAtlas
  private program!: WebGLProgram

  private instanceBuffer!: WebGLBuffer
  private quadBuffer!: WebGLBuffer
  private vao!: WebGLVertexArrayObject
  private uResolution: WebGLUniformLocation | null = null
  private uAtlas: WebGLUniformLocation | null = null

  private cols: number
  private rows: number
  private fontFamily: string
  private fontSize: number

  private defaultFgR = 200
  private defaultFgG = 200
  private defaultFgB = 200
  private defaultBgR = 0
  private defaultBgG = 0
  private defaultBgB = 0
  /** 0..1. Reaches the clear colour and default-background cells only. */
  private defaultBgA = 1

  // As measured, before display-scale quantisation. Kept so a scale change
  // re-quantises from the measurement rather than from an already-rounded value.
  private baseCellWidth: number
  private baseCellHeight: number
  private cellWidth: number
  private cellHeight: number
  // Cell size in whole device pixels. Windows commonly runs at 125% or 150%,
  // where a logical cell is a fractional number of device pixels: the canvas
  // height truncates, the shader still divides it into equal rows, and every
  // row boundary lands a little further off a real pixel than the last. The
  // glyph — rasterized on its own integer grid — then sits a pixel or two off
  // the cell the cursor paints, increasingly so down the screen. Rounding to
  // whole device pixels makes every cell an exact integer rect, which is also
  // what lets the atlas rasterize at native resolution instead of being
  // NEAREST-upscaled from logical size.
  private deviceCellWidth: number
  private deviceCellHeight: number
  private dpr: number

  private contextLost = false
  // False until the program links and the GL objects exist. A failed link would
  // otherwise turn one console error into an exception on every frame.
  private ready = false

  /** Absolute-coordinate selection to highlight, or null. */
  selection: SelectionRange | null = null

  /** Where to paint the cursor block, or null for none. */
  cursor: CursorState | null = null

  /**
   * Search hits to highlight, grouped by absolute row. Grouped rather than a
   * flat list because the alternative is scanning every match for every cell;
   * this way a row costs one lookup and a cell costs a walk of just its own
   * row's hits, which is almost always none.
   */
  searchHighlights: Map<number, SearchHighlight[]> | null = null

  private cursorR = 255
  private cursorG = 255
  private cursorB = 255

  /**
   * Called after a lost context has been rebuilt. Every GPU-side object comes
   * back empty, so the owner has to re-issue a draw or the pane sits blank
   * until its next byte arrives.
   */
  onRestore: (() => void) | null = null

  // Instance data buffer (floats):
  // cellPos.x, cellPos.y, fgR, fgG, fgB, fgA, bgR, bgG, bgB, bgA, u0, v0, u1, v1 (14 floats = 56 bytes per cell)
  private instanceData!: Float32Array

  // Scrollback is read one row at a time into a scratch buffer. It only has to
  // exist while the viewport is scrolled up, and it outlives the frame so
  // scrolling doesn't churn the WASM allocator once per row per frame.
  private lineWasm: GhosttyWasm | null = null
  private linePtr = 0
  private lineCells = 0
  private graphemePtr = 0

  constructor(
    canvas: HTMLCanvasElement,
    cols: number,
    rows: number,
    fontFamily: string,
    fontSize: number
  ) {
    this.canvas = canvas
    this.cols = cols
    this.rows = rows
    this.fontFamily = fontFamily
    this.fontSize = fontSize

    // This renderer only repaints on damage, so an idle pane goes many frames
    // without a draw. WebGL formally leaves a composited buffer's contents
    // undefined unless it is preserved, so an idle pane is relying on behaviour
    // it isn't promised; preserving costs a copy per frame and makes the buffer
    // mean what it says. The alternative is redrawing every frame, which gives
    // up the zero-cost idle pane this loop is built around.
    //
    // The buffer keeps an alpha channel so the pane's background opacity can
    // reach the clear colour and let the window's own backdrop through.
    // `premultipliedAlpha: false` because the colours written here are straight
    // RGBA — declaring them premultiplied would wash out every translucent
    // background by dividing it through by its own alpha at composite time.
    this.gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    })!

    const { width: cellWidth, height: cellHeight } = measureCell(fontFamily, fontSize)
    this.baseCellWidth = cellWidth
    this.baseCellHeight = cellHeight
    this.dpr = 0 // forces the first sync to compute
    this.cellWidth = cellWidth
    this.cellHeight = cellHeight
    this.deviceCellWidth = cellWidth
    this.deviceCellHeight = cellHeight
    this.syncDeviceMetrics()

    // A GPU reset — driver timeout, sleep/resume, WebView2 recycling its GPU
    // host — invalidates every object below without the pane knowing. Without
    // preventDefault the context is never eligible for restoration and the
    // pane stays dead for the rest of the session.
    canvas.addEventListener('webglcontextlost', this.onContextLost)
    canvas.addEventListener('webglcontextrestored', this.onContextRestored)

    this.resizeCanvas()
    this.initGL()
  }

  private onContextLost = (e: Event) => {
    e.preventDefault()
    this.contextLost = true
  }

  private onContextRestored = () => {
    this.contextLost = false
    // Nothing from the old context survives, so mark the build dead before
    // rebuilding rather than trying to delete objects that no longer exist.
    this.ready = false
    // Every glyph the atlas had cached lived in a texture that is gone too, so
    // the cache goes with it.
    this.initGL()
    this.onRestore?.()
  }

  /** Drops the current GL build, if there is a live one. */
  private releaseGL() {
    if (!this.ready) return
    this.atlas.dispose()
    this.gl.deleteProgram(this.program)
    this.gl.deleteBuffer(this.instanceBuffer)
    this.gl.deleteBuffer(this.quadBuffer)
    this.gl.deleteVertexArray(this.vao)
    this.ready = false
  }

  /**
   * Recomputes whole-pixel cell metrics, returning whether the display scale
   * moved — dragging a window between monitors of different DPI changes the
   * size a glyph has to be rasterized at.
   */
  private syncDeviceMetrics(): boolean {
    const dpr = window.devicePixelRatio || 1
    if (dpr === this.dpr) return false
    this.dpr = dpr
    this.deviceCellWidth = Math.max(1, Math.round(this.baseCellWidth * dpr))
    this.deviceCellHeight = Math.max(1, Math.round(this.baseCellHeight * dpr))
    // The logical size is derived back from the rounded device size rather than
    // kept at the measured value. Sizing the CSS box from the raw measurement
    // would leave the browser rescaling the backing store by the rounding error
    // — undoing the point of the exercise — and fit() reads these same numbers,
    // so deriving them keeps the grid it computes identical to the one drawn.
    this.cellWidth = this.deviceCellWidth / dpr
    this.cellHeight = this.deviceCellHeight / dpr
    return true
  }

  /** (Re)builds everything that lives on the GL context. */
  private initGL() {
    this.releaseGL()
    const gl = this.gl
    this.ready = false

    // Rasterized at device scale into device-sized slots, so a glyph is drawn
    // at the resolution it is displayed at rather than magnified from logical
    // size by a NEAREST sampler.
    this.atlas = new GlyphAtlas(
      gl,
      this.fontFamily,
      this.fontSize * this.dpr,
      this.deviceCellWidth,
      this.deviceCellHeight,
    )

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC)
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC)
    if (!vs || !fs) return

    this.program = gl.createProgram()!
    gl.attachShader(this.program, vs)
    gl.attachShader(this.program, fs)
    gl.linkProgram(this.program)
    // A link failure is otherwise completely silent: the clear still paints, so
    // the pane comes up showing its theme background with no text on it at all.
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error('Ghostty renderer program link failed:', gl.getProgramInfoLog(this.program))
      return
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)

    gl.useProgram(this.program)
    this.uResolution = gl.getUniformLocation(this.program, 'u_resolution')
    this.uAtlas = gl.getUniformLocation(this.program, 'u_atlas')
    gl.uniform2f(this.uResolution, this.cols, this.rows)
    gl.uniform1i(this.uAtlas, 0)

    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)

    // Quad vertices
    this.quadBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,
      1, 0,
      0, 1,
      0, 1,
      1, 0,
      1, 1
    ]), gl.STATIC_DRAW)

    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    // Instance buffer
    this.instanceBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)

    this.instanceData = new Float32Array(this.cols * this.rows * 14)
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData, gl.DYNAMIC_DRAW)

    const stride = 14 * 4

    // a_cellPos
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0)
    gl.vertexAttribDivisor(1, 1)

    // a_fgColor
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 2 * 4)
    gl.vertexAttribDivisor(2, 1)

    // a_bgColor
    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 6 * 4)
    gl.vertexAttribDivisor(3, 1)

    // a_uv
    gl.enableVertexAttribArray(4)
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, stride, 10 * 4)
    gl.vertexAttribDivisor(4, 1)

    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    this.ready = true
  }

  private resizeCanvas() {
    // Backing store in whole device pixels; CSS box in the logical units the
    // rest of the layout is measured in.
    this.canvas.width = this.cols * this.deviceCellWidth
    this.canvas.height = this.rows * this.deviceCellHeight
    this.canvas.style.width = `${this.cols * this.cellWidth}px`
    this.canvas.style.height = `${this.rows * this.cellHeight}px`
  }

  setTheme(fr: number, fg: number, fb: number, br: number, bg: number, bb: number, opacity = 1) {
    this.defaultFgR = fr
    this.defaultFgG = fg
    this.defaultFgB = fb
    this.defaultBgR = br
    this.defaultBgG = bg
    this.defaultBgB = bb
    this.defaultBgA = opacity
  }

  setCursorColor(r: number, g: number, b: number) {
    this.cursorR = r
    this.cursorG = g
    this.cursorB = b
  }

  getCellSize(): { width: number, height: number } {
    return { width: this.cellWidth, height: this.cellHeight }
  }

  resize(cols: number, rows: number, force = false) {
    const scaleChanged = this.syncDeviceMetrics()
    if (this.cols === cols && this.rows === rows && !force && !scaleChanged) return
    this.cols = cols
    this.rows = rows

    this.resizeCanvas()
    if (this.contextLost) return

    if (scaleChanged) {
      // The atlas holds glyphs rasterized for the old scale, and initGL sizes
      // the instance buffer for the current grid, so this covers the resize too.
      this.initGL()
      return
    }
    if (!this.ready) return

    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)

    gl.useProgram(this.program)
    gl.uniform2f(this.uResolution, cols, rows)

    this.instanceData = new Float32Array(cols * rows * 14)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData, gl.DYNAMIC_DRAW)
  }

  /** Scratch buffer for one grapheme cluster's codepoints. */
  private graphemeBuffer(wasm: GhosttyWasm): number {
    if (this.graphemePtr === 0) {
      this.graphemePtr = wasm.exports.ghostty_wasm_alloc_u8_array(GRAPHEME_CAP * 4)
      this.lineWasm = wasm
    }
    return this.graphemePtr
  }

  /** Scratch buffer for one scrollback row, grown on demand. */
  private lineBuffer(wasm: GhosttyWasm, cells: number): number {
    if (this.linePtr !== 0 && this.lineCells >= cells) return this.linePtr
    if (this.linePtr !== 0) {
      wasm.exports.ghostty_wasm_free_u8_array(this.linePtr, this.lineCells * CELL_BYTES)
    }
    this.linePtr = wasm.exports.ghostty_wasm_alloc_u8_array(cells * CELL_BYTES)
    this.lineCells = this.linePtr === 0 ? 0 : cells
    this.lineWasm = wasm
    return this.linePtr
  }

  /**
   * @param viewportOffset rows scrolled up from the bottom; 0 is live output.
   * @param scrollbackCount rows currently held above the active screen.
   */
  updateStaticGrid(wasm: GhosttyWasm, termPtr: number, viewportOffset = 0, scrollbackCount = 0) {
    if (this.contextLost || !this.ready) return

    const gl = this.gl
    const cols = this.cols
    const rows = this.rows
    const wasmCols = wasm.exports.ghostty_render_state_get_cols(termPtr)
    const wasmRows = wasm.exports.ghostty_render_state_get_rows(termPtr)

    // Sized from the WASM dimensions rather than ours, since a resize can land
    // on one side before the other.
    const cellCount = wasmCols * wasmRows
    const expectedBufSize = cellCount * CELL_BYTES
    const viewportBufPtr = wasm.exports.ghostty_wasm_alloc_u8_array(expectedBufSize)
    if (viewportBufPtr === 0) return

    new Uint8Array(wasm.exports.memory.buffer, viewportBufPtr, expectedBufSize).fill(0)

    // Takes a cell count, not a byte count.
    wasm.exports.ghostty_render_state_get_viewport(termPtr, viewportBufPtr, cellCount)

    viewportOffset = Math.max(0, Math.min(viewportOffset, scrollbackCount))
    // Only pay for the scratch row when the viewport is actually scrolled up.
    const linePtr = viewportOffset > 0 ? this.lineBuffer(wasm, wasmCols) : 0
    const graphemePtr = this.graphemeBuffer(wasm)

    // Both views are made after every allocation this frame will do: growing
    // WASM memory detaches the old ArrayBuffer, and a DataView built before the
    // growth throws on its next read.
    const viewportView = new DataView(wasm.exports.memory.buffer, viewportBufPtr, expectedBufSize)
    const lineView = linePtr !== 0
      ? new DataView(wasm.exports.memory.buffer, linePtr, wasmCols * CELL_BYTES)
      : null
    const graphemeView = graphemePtr !== 0
      ? new DataView(wasm.exports.memory.buffer, graphemePtr, GRAPHEME_CAP * 4)
      : null

    // The core has no runtime colour setter, so a pane that outlives a theme
    // change would otherwise keep painting default text in the palette it was
    // created with. Its current defaults are queryable and come back on cells
    // byte-for-byte, so cells still sitting on them can be mapped onto the live
    // theme. Explicitly-coloured text is left alone — remapping that would mean
    // guessing which palette slot it came from, which the resolved-RGB ABI
    // deliberately no longer tells us.
    const coreFg = wasm.exports.ghostty_render_state_get_fg_color(termPtr)
    const coreFgR = (coreFg >> 16) & 0xff, coreFgG = (coreFg >> 8) & 0xff, coreFgB = coreFg & 0xff
    const coreBg = wasm.exports.ghostty_render_state_get_bg_color(termPtr)
    const coreBgR = (coreBg >> 16) & 0xff, coreBgG = (coreBg >> 8) & 0xff, coreBgB = coreBg & 0xff

    // Normalised here so the caller can drag a selection in either direction.
    let selStart = this.selection?.start
    let selEnd = this.selection?.end
    if (selStart && selEnd) {
      if (selStart.y > selEnd.y || (selStart.y === selEnd.y && selStart.x > selEnd.x)) {
        const swap = selStart; selStart = selEnd; selEnd = swap
      }
    }

    // Hidden outright while scrolled back: the cursor belongs to the live
    // screen, and leaving it on history reads as an editable line up there.
    const cursor = this.cursor && viewportOffset === 0 ? this.cursor : null

    let outIdx = 0

    for (let r = 0; r < rows; r++) {
      // Absolute row: scrollback rows come first, then the active screen.
      const absRow = scrollbackCount - viewportOffset + r

      let isScrollback = false
      let activeRow = 0
      let rowValid = false

      if (absRow < scrollbackCount) {
        if (absRow >= 0 && lineView) {
          wasm.exports.ghostty_terminal_get_scrollback_line(termPtr, absRow, linePtr, wasmCols)
          isScrollback = true
          rowValid = true
        }
      } else {
        activeRow = absRow - scrollbackCount
        rowValid = activeRow < wasmRows
      }

      // A wide character occupies two columns: the core puts the codepoint in
      // the first with width 2 and leaves the second as a spacer with width 0.
      // The right half of that glyph is drawn from the same atlas entry when
      // the spacer comes round, so these carry it across one column.
      let pendingWide: GlyphRect | null = null
      let cursorOnWide: boolean = false

      const rowHighlights = this.searchHighlights?.get(absRow)

      for (let c = 0; c < cols; c++) {
        let codepoint = 0
        let flags = 0
        // 1 for an ordinary cell (and for anything outside the core's grid),
        // 2 for the head of a wide character, 0 for its trailing spacer.
        let cellWidth = 1
        /** Codepoints beyond the first; non-zero means a cluster to compose. */
        let graphemeLen = 0
        // Cells outside the core's grid (a resize we've seen but it hasn't)
        // fall back to the theme's own colors.
        let finalFgR = this.defaultFgR
        let finalFgG = this.defaultFgG
        let finalFgB = this.defaultFgB
        let finalBgR = this.defaultBgR
        let finalBgG = this.defaultBgG
        let finalBgB = this.defaultBgB
        // Only the default background is allowed to be see-through. A cell that
        // asked for a specific background gets it at full strength, the same way
        // xterm treats an explicit SGR background.
        let bgIsDefault = true

        if (rowValid && c < wasmCols) {
          const cell = isScrollback
            ? parseCell(lineView!, c * CELL_BYTES)
            : parseCell(viewportView, (activeRow * wasmCols + c) * CELL_BYTES)

          codepoint = cell.codepoint
          flags = cell.flags
          cellWidth = cell.width
          graphemeLen = cell.graphemeLen
          // Already resolved to RGB by the core against the palette and
          // defaults it was configured with, so the only substitution left is
          // pulling default-coloured cells onto the current theme.
          if (cell.fgR === coreFgR && cell.fgG === coreFgG && cell.fgB === coreFgB) {
            finalFgR = this.defaultFgR; finalFgG = this.defaultFgG; finalFgB = this.defaultFgB
          } else {
            finalFgR = cell.fgR; finalFgG = cell.fgG; finalFgB = cell.fgB
          }
          if (cell.bgR === coreBgR && cell.bgG === coreBgG && cell.bgB === coreBgB) {
            finalBgR = this.defaultBgR; finalBgG = this.defaultBgG; finalBgB = this.defaultBgB
          } else {
            finalBgR = cell.bgR; finalBgG = cell.bgG; finalBgB = cell.bgB
            bgIsDefault = false
          }
        }

        // Faint is a foreground effect, not a glyph one, so it stays out of the
        // atlas key — otherwise every dimmed character would cost a second
        // raster identical to the one already cached.
        if ((flags & CELL_FAINT) !== 0) {
          finalFgR = (finalFgR * 0.55) | 0
          finalFgG = (finalFgG * 0.55) | 0
          finalFgB = (finalFgB * 0.55) | 0
        }

        let u0 = 0, v0 = 0, u1 = 0, v1 = 0
        if (cellWidth === 0 && pendingWide) {
          // The spacer draws the right half of the glyph the previous column
          // started, so the character spans both cells at its true width.
          u0 = (pendingWide.u0 + pendingWide.u1) / 2
          v0 = pendingWide.v0
          u1 = pendingWide.u1
          v1 = pendingWide.v1
          pendingWide = null
        } else if (codepoint > 0 && (flags & CELL_INVISIBLE) === 0) {
          // Invisible keeps the cell's colours — it hides the character, it
          // does not blank the background — so it skips the glyph only.
          const wide = cellWidth === 2
          let style = wide ? GLYPH_WIDE : 0
          if (flags & CELL_BOLD) style |= GLYPH_BOLD
          if (flags & CELL_ITALIC) style |= GLYPH_ITALIC
          if (flags & CELL_UNDERLINE) style |= GLYPH_UNDERLINE
          if (flags & CELL_STRIKETHROUGH) style |= GLYPH_STRIKETHROUGH

          // A cell whose character carries combining marks or emoji joiners has
          // to be rasterized from the whole cluster; the cell's own codepoint is
          // only the first of them.
          let rect
          if (graphemeLen > 0 && graphemeView) {
            const n = isScrollback
              ? wasm.exports.ghostty_terminal_get_scrollback_grapheme(termPtr, absRow, c, graphemePtr, GRAPHEME_CAP)
              : wasm.exports.ghostty_render_state_get_grapheme(termPtr, activeRow, c, graphemePtr, GRAPHEME_CAP)
            if (n > 1) {
              let text = ''
              for (let i = 0; i < n && i < GRAPHEME_CAP; i++) {
                text += String.fromCodePoint(graphemeView.getUint32(i * 4, true))
              }
              rect = this.atlas.getClusterGlyph(text, style)
            }
          }
          if (!rect) rect = this.atlas.getGlyph(codepoint, style)
          v0 = rect.v0; v1 = rect.v1
          u0 = rect.u0
          u1 = wide ? (rect.u0 + rect.u1) / 2 : rect.u1
          pendingWide = wide ? rect : null
        } else {
          pendingWide = null
        }

        if ((flags & CELL_INVERSE) !== 0) {
          const tempR = finalFgR, tempG = finalFgG, tempB = finalFgB
          finalFgR = finalBgR; finalFgG = finalBgG; finalFgB = finalBgB
          finalBgR = tempR; finalBgG = tempG; finalBgB = tempB
          bgIsDefault = false
        }

        // Under the selection: a search hit you have then dragged over should
        // look selected, not still look like a hit.
        if (rowHighlights) {
          for (let i = 0; i < rowHighlights.length; i++) {
            const h = rowHighlights[i]
            if (c < h.from || c > h.to) continue
            const tint = h.active ? SEARCH_ACTIVE_BG : SEARCH_MATCH_BG
            finalBgR = tint[0]; finalBgG = tint[1]; finalBgB = tint[2]
            bgIsDefault = false
            // The active hit is a light background, so dark text reads on it.
            if (h.active) {
              finalFgR = 0x1a; finalFgG = 0x1a; finalFgB = 0x1a
            }
            break
          }
        }

        let isSelected = false
        if (selStart && selEnd && absRow >= selStart.y && absRow <= selEnd.y) {
          const from = absRow === selStart.y ? selStart.x : 0
          const to = absRow === selEnd.y ? selEnd.x : cols - 1
          isSelected = c >= from && c <= to
        }

        if (isSelected) {
          // Lightened rather than inverted so syntax colouring stays readable
          // through the highlight, and always opaque — a selection that fades
          // with the pane's transparency is hard to pick out against a desktop.
          finalBgR = (finalBgR * 0.7 + 255 * 0.3) | 0
          finalBgG = (finalBgG * 0.7 + 255 * 0.3) | 0
          finalBgB = (finalBgB * 0.7 + 255 * 0.3) | 0
          bgIsDefault = false
        }

        // The cursor is the cell's own background rather than a second draw
        // call: a block cursor is exactly "this cell, recoloured", so folding
        // it in here keeps the pane at one draw and needs no extra GL state.
        // The glyph underneath is repainted in the background colour so it
        // stays legible through the block, which is what makes it read as a
        // cursor sitting on the character rather than erasing it.
        // Sitting on a wide character means covering both of its columns —
        // half a block over half a glyph reads as a rendering fault.
        let atCursor = false
        if (cursor !== null && cursor.row === r) {
          atCursor = cursor.col === c || (cursorOnWide && cellWidth === 0)
        }
        cursorOnWide = atCursor && cellWidth === 2

        if (cursor && atCursor) {
          if (cursor.on && cursor.focused) {
            finalFgR = this.defaultBgR; finalFgG = this.defaultBgG; finalFgB = this.defaultBgB
            finalBgR = this.cursorR; finalBgG = this.cursorG; finalBgB = this.cursorB
            bgIsDefault = false
          } else if (!cursor.focused) {
            // An unfocused pane keeps a steady, dimmed block: it still says
            // where typing would land, without competing with the pane that
            // actually has focus.
            finalBgR = (finalBgR * 0.5 + this.cursorR * 0.5) | 0
            finalBgG = (finalBgG * 0.5 + this.cursorG * 0.5) | 0
            finalBgB = (finalBgB * 0.5 + this.cursorB * 0.5) | 0
            bgIsDefault = false
          }
        }

        this.instanceData[outIdx++] = c
        this.instanceData[outIdx++] = r

        this.instanceData[outIdx++] = finalFgR
        this.instanceData[outIdx++] = finalFgG
        this.instanceData[outIdx++] = finalFgB
        this.instanceData[outIdx++] = 255

        this.instanceData[outIdx++] = finalBgR
        this.instanceData[outIdx++] = finalBgG
        this.instanceData[outIdx++] = finalBgB
        this.instanceData[outIdx++] = bgIsDefault ? this.defaultBgA * 255 : 255

        this.instanceData[outIdx++] = u0
        this.instanceData[outIdx++] = v0
        this.instanceData[outIdx++] = u1
        this.instanceData[outIdx++] = v1
      }
    }

    wasm.exports.ghostty_wasm_free_u8_array(viewportBufPtr, expectedBufSize)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData)

    gl.clearColor(this.defaultBgR / 255, this.defaultBgG / 255, this.defaultBgB / 255, this.defaultBgA)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.texture)

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, cols * rows)
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    if (this.lineWasm) {
      if (this.linePtr !== 0) {
        this.lineWasm.exports.ghostty_wasm_free_u8_array(this.linePtr, this.lineCells * CELL_BYTES)
        this.linePtr = 0
      }
      if (this.graphemePtr !== 0) {
        this.lineWasm.exports.ghostty_wasm_free_u8_array(this.graphemePtr, GRAPHEME_CAP * 4)
        this.graphemePtr = 0
      }
    }
    if (this.contextLost) return
    this.releaseGL()
  }
}
