import {
  GlyphAtlas,
  GLYPH_BOLD,
  GLYPH_ITALIC,
  GLYPH_UNDERLINE,
  GLYPH_STRIKETHROUGH,
  GLYPH_WIDE,
  GLYPH_CURSOR_OUTLINE,
  GLYPH_CURSOR_BAR,
  GLYPH_CURSOR_UNDERLINE,
  GLYPH_OVERLINE,
  GLYPH_UL_SHIFT,
  type GlyphRect,
} from './GlyphAtlas'
import { computeRuns, type RunScratch } from './ligatureRuns'
import type { FontSelection } from '../fontStack'
import {
  parseCellInto,
  emptyCell,
  CELL_BYTES,
  CELL_INVERSE,
  CELL_BOLD,
  CELL_ITALIC,
  CELL_UNDERLINE,
  CELL_STRIKETHROUGH,
  CELL_FAINT,
  CELL_INVISIBLE,
  CELL_BLINK,
  allocBufferOrThrow,
  type GhosttyWasm,
  CELL2_UNDERLINE_MASK,
  CELL2_OVERLINE,
  UNDERLINE_DOTTED,
  CURSOR_STYLE_BLOCK,
  CURSOR_STYLE_BAR,
  CURSOR_STYLE_UNDERLINE,
} from './wasmBindings'

const VERTEX_SHADER_SRC = `#version 300 es
layout(location = 0) in vec2 a_position; // (0,0) to (1,1)
layout(location = 1) in vec2 a_cellPos;  // (col, row)
layout(location = 2) in vec4 a_fgColor;  // (r,g,b,a)
layout(location = 3) in vec4 a_bgColor;  // (r,g,b,a)
layout(location = 4) in vec4 a_uv;       // (u0,v0, u1,v1)
layout(location = 5) in float a_color;   // 0 for coverage; else how much color the glyph keeps

uniform vec2 u_resolution; // (cols, rows)

out vec4 v_fgColor;
out vec4 v_bgColor;
out vec2 v_uv;
// Flat: a per-instance flag, not a quantity to interpolate.
flat out float v_color;

void main() {
    v_fgColor = a_fgColor / 255.0;
    v_bgColor = a_bgColor / 255.0;
    v_color = a_color;

    v_uv = mix(a_uv.xy, a_uv.zw, a_position);

    vec2 pos = a_cellPos + a_position;
    vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
    clip.y = -clip.y; // top-left origin

    gl_Position = vec4(clip, 0.0, 1.0);
}
`

// Glyph coverage and cell background resolve in one pass. Alpha is mixed too,
// so a glyph stays opaque over a translucent default background.
const FRAGMENT_SHADER_SRC = `#version 300 es
// highp: the corrected mode divides by a luminance difference.
precision highp float;

in vec4 v_fgColor;
in vec4 v_bgColor;
in vec2 v_uv;
flat in float v_color;

uniform sampler2D u_atlas;
// The color companion atlas; same packing, so v_uv addresses it unchanged.
uniform sampler2D u_colorAtlas;
// One of the BLEND_* constants; a uniform branch, so no divergence.
uniform int u_blendMode;

out vec4 outColor;

// Mix in sRGB: cheap, but darkens edges where colors differ in hue.
const int BLEND_NATIVE = 0;
// Mix in linear light: no fringe, but dark-on-light text looks thinner and
// light-on-dark thicker than designed.
const int BLEND_LINEAR = 1;
// Linear, with ghostty's weight correction: solve for the coverage that
// reproduces the native blend's luminance, then blend linearly.
const int BLEND_LINEAR_CORRECTED = 2;

// The exact sRGB transfer function; a 2.2 power law diverges near black.
float linearize(float v) {
    return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4);
}
vec3 linearize(vec3 c) {
    return vec3(linearize(c.r), linearize(c.g), linearize(c.b));
}
float unlinearize(float v) {
    return v <= 0.0031308 ? v * 12.92 : pow(v, 1.0 / 2.4) * 1.055 - 0.055;
}
vec3 unlinearize(vec3 c) {
    return vec3(unlinearize(c.r), unlinearize(c.g), unlinearize(c.b));
}
float luminance(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
    if (v_color > 0.0) {
        // Color glyphs (emoji) are composited source-over onto the background; the
        // blend modes only apply to text. v_color > 0 means color, and its value
        // scales the glyph's colors (faint).
        vec4 src = texture(u_colorAtlas, v_uv);
        outColor = vec4(mix(v_bgColor.rgb, src.rgb * v_color, src.a), mix(v_bgColor.a, 1.0, src.a));
        return;
    }

    // Single-channel atlas: coverage is in red, and .a would read as 1.0.
    float a = texture(u_atlas, v_uv).r;

    if (u_blendMode == BLEND_NATIVE) {
        outColor = mix(v_bgColor, v_fgColor, a);
        return;
    }

    vec3 fgLin = linearize(v_fgColor.rgb);
    vec3 bgLin = linearize(v_bgColor.rgb);

    if (u_blendMode == BLEND_LINEAR_CORRECTED) {
        // Blend the luminances the native way, then find the coverage that
        // reaches that luminance through a linear blend. No tunable constants.
        float fgL = luminance(fgLin);
        float bgL = luminance(bgLin);
        // Nothing to correct when the luminances converge.
        if (abs(fgL - bgL) > 0.001) {
            float blendL = linearize(unlinearize(fgL) * a + unlinearize(bgL) * (1.0 - a));
            a = clamp((blendL - bgL) / (fgL - bgL), 0.0, 1.0);
        }
    }

    // Alpha stays in coverage units: it's the pane's opacity, not light.
    outColor = vec4(unlinearize(mix(bgLin, fgLin, a)), mix(v_bgColor.a, v_fgColor.a, a));
}
`

/** Values for `setTextBlending`: the shader's BLEND_* constants. */
export const BLEND_NATIVE = 0
export const BLEND_LINEAR = 1
export const BLEND_LINEAR_CORRECTED = 2

/** Floats per instance: cell position, foreground, background, UVs, and the
 *  color-atlas scale. */
const INSTANCE_FLOATS = 15

/** Cursor overlay instances per frame: one per column (two on a wide char). */
const CURSOR_OVERLAY_CAP = 2

/** How far faint text is darkened toward black, for both text and color
 *  glyphs. */
const FAINT_SCALE = 0.55

/**
 * The one place cell metrics are derived, so the renderer's canvas size and
 * the engine's fit always agree to the pixel.
 */
export function measureCell(
  fonts: FontSelection,
  fontSize: number,
): { width: number; height: number } {
  const ctx = document.createElement('canvas').getContext('2d')!
  // The regular face at the body weight: the grid must not shift for bold or
  // italic cells (other faces are condensed into this cell), and weights of
  // one family advance differently.
  ctx.font = `${fonts.weight === 400 ? '' : `${fonts.weight} `}${fontSize}px ${fonts.regular}`
  return {
    // Floored at one pixel: an unresolved face measures zero.
    width: Math.max(1, Math.ceil(ctx.measureText('W').width) + fonts.letterSpacing),
    height: Math.max(1, Math.ceil(fontSize * fonts.lineHeight)),
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
 * Codepoints read back for one grapheme cluster; longer clusters are
 * truncated.
 */
const GRAPHEME_CAP = 16

export interface SelectionRange {
  /** Absolute buffer coordinates — row counts from the top of scrollback. */
  start: { x: number; y: number }
  end: { x: number; y: number }
  /**
   * Column-wise: every row takes the same column span.
   */
  rectangular?: boolean
}

export interface SearchHighlight {
  from: number
  to: number
  /** The one the viewport is parked on, painted brighter than the rest. */
  active: boolean
}

// Matches the xterm engine's SEARCH_DECORATIONS.
const SEARCH_MATCH_BG = [0x5c, 0x4a, 0x1c]
const SEARCH_ACTIVE_BG = [0xd9, 0xa4, 0x41]

/** Hint labels: dark on amber, distinct from any output. */
const HINT_FG = [0x1a, 0x1a, 0x1a]
const HINT_BG = [0xf5, 0xc2, 0x42]

export interface CursorState {
  /** Viewport coordinates — the row as currently displayed, not absolute. */
  col: number
  row: number
  /** A blinked-off or unfocused cursor still occupies its cell. */
  on: boolean
  focused: boolean
  /** DECSCUSR shape as a CURSOR_STYLE_* value; block when unset. */
  shape?: number
}

export class WebGLRenderer {
  private canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private atlas!: GlyphAtlas
  private program!: WebGLProgram

  private instanceBuffer!: WebGLBuffer
  private quadBuffer!: WebGLBuffer
  private vao!: WebGLVertexArrayObject
  private overlayBuffer!: WebGLBuffer
  private overlayVao!: WebGLVertexArrayObject
  private uResolution: WebGLUniformLocation | null = null
  private uAtlas: WebGLUniformLocation | null = null
  private uColorAtlas: WebGLUniformLocation | null = null
  private uBlendMode: WebGLUniformLocation | null = null

  private cols: number
  private rows: number
  private fonts: FontSelection
  private fontSize: number

  private defaultFgR = 200
  private defaultFgG = 200
  private defaultFgB = 200
  private defaultBgR = 0
  private defaultBgG = 0
  private defaultBgB = 0
  /** 0..1. Reaches the clear color and default-background cells only. */
  private defaultBgA = 1

  // Held here because the program and the renderer are both rebuilt (context
  // loss, font change) and start on the shader defaults.
  private blendMode = BLEND_NATIVE
  /**
   * Whether to shape operator runs as one string so ligatures apply. Off by
   * default: it costs atlas slots.
   */
  private ligatures = false
  /** Per-row run bookkeeping, allocated with the grid. See `computeRuns`. */
  private runs: RunScratch | null = null

  // As measured, before display-scale rounding.
  private baseCellWidth: number
  private baseCellHeight: number
  private cellWidth: number
  private cellHeight: number
  // Cell size in whole device pixels. At fractional scales (125%, 150%) a
  // fractional cell drifts off the pixel grid down the screen; rounding makes
  // every cell an exact integer rect and lets the atlas rasterize at native
  // resolution.
  private deviceCellWidth: number
  private deviceCellHeight: number
  private dpr: number

  private contextLost = false
  private loseExt: WEBGL_lose_context | null = null
  // False until the program links; a failed link must not throw every frame.
  private ready = false

  /** Absolute-coordinate selection to highlight, or null. */
  selection: SelectionRange | null = null

  /** Where to paint the cursor block, or null for none. */
  cursor: CursorState | null = null

  /** The blink phase for cells carrying the blink attribute. */
  blinkOn = true
  /** Whether the last frame contained any blinking cells, so blink ticks can
   *  skip repainting otherwise. */
  sawBlinkingCell = false

  /**
   * Search hits to highlight, grouped by absolute row so each cell only checks
   * its own row's hits.
   */
  searchHighlights: Map<number, SearchHighlight[]> | null = null

  /**
   * The link under the pointer, as the rows and columns it covers, or null.
   * Rendered as a solid underline style bit on the covered cells.
   */
  linkHighlight: { row: number; from: number; to: number }[] | null = null

  /**
   * Every link on screen, drawn with a dotted underline so links are
   * discoverable; the hovered one is solid.
   */
  linkRanges: { row: number; from: number; to: number }[] | null = null

  /**
   * Hint-mode labels, drawn as cells, in absolute rows so they stay on their
   * links. Null when the mode is off.
   */
  hintLabels: { row: number; col: number; text: string }[] | null = null

  /**
   * Spans whose glyphs are hidden by drawing them in the background color, for
   * the history flicker (see lib/historyRepeat.ts). Hiding the glyph rather than
   * overlaying a band keeps a translucent background correct. Absolute rows.
   */
  hiddenSpans: { row: number; from: number; to: number }[] | null = null

  private cursorR = 255
  private cursorG = 255
  private cursorB = 255

  /**
   * Called after a lost context is rebuilt; the owner must redraw or the pane
   * stays blank.
   */
  onRestore: (() => void) | null = null

  // Per-cell instance data; see INSTANCE_FLOATS.
  private instanceData!: Float32Array

  // The cursor overlay's instances, allocated once.
  private overlayData = new Float32Array(CURSOR_OVERLAY_CAP * INSTANCE_FLOATS)
  private overlayCount = 0

  // Scratch row for scrollback, kept across frames while scrolled up.
  private lineWasm: GhosttyWasm | null = null
  private linePtr = 0
  private lineCells = 0
  private graphemePtr = 0

  // Scratch buffer for the whole viewport, cached rather than reallocated
  // every frame (192 KB at 200x60).
  private viewportPtr = 0
  private viewportCells = 0

  /** One cell reused for every cell of every frame; see `parseCellInto`. */
  private scratchCell = emptyCell()

  constructor(
    canvas: HTMLCanvasElement,
    cols: number,
    rows: number,
    fonts: FontSelection,
    fontSize: number
  ) {
    this.canvas = canvas
    this.cols = cols
    this.rows = rows
    this.fonts = fonts
    this.fontSize = fontSize

    // The renderer only draws on damage, so the drawing buffer must be
    // preserved between frames. Alpha lets the pane's opacity reach the
    // window backdrop; colors are straight RGBA, not premultiplied.
    this.gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    })!

    const { width: cellWidth, height: cellHeight } = measureCell(fonts, fontSize)
    this.baseCellWidth = cellWidth
    this.baseCellHeight = cellHeight
    this.dpr = 0 // forces the first sync to compute
    this.cellWidth = cellWidth
    this.cellHeight = cellHeight
    this.deviceCellWidth = cellWidth
    this.deviceCellHeight = cellHeight
    this.syncDeviceMetrics()

    // A GPU reset invalidates everything; preventDefault makes the context
    // restorable.
    canvas.addEventListener('webglcontextlost', this.onContextLost)
    canvas.addEventListener('webglcontextrestored', this.onContextRestored)
    // Also used to release the context voluntarily; see releaseContext.
    this.loseExt = this.gl.getExtension('WEBGL_lose_context')

    this.resizeCanvas()
    this.initGL()
  }

  private onContextLost = (e: Event) => {
    e.preventDefault()
    this.contextLost = true
  }

  private onContextRestored = () => {
    this.contextLost = false
    // The old objects are gone; don't try to delete them.
    this.ready = false
    this.initGL()
    this.onRestore?.()
  }

  get isContextLost(): boolean {
    return this.contextLost
  }

  /**
   * Hands the GL context back to the browser. Chromium allows about sixteen live
   * WebGL contexts and evicts arbitrarily past that; hidden tabs stay mounted, so
   * off-screen panes give theirs up. Everything is rebuilt from WASM on restore.
   */
  releaseContext() {
    if (this.contextLost || !this.loseExt) return
    this.releaseGL()
    // Fires webglcontextlost, which sets contextLost.
    this.loseExt.loseContext()
  }

  /** Asks for the context back. The restore lands asynchronously. */
  restoreContext() {
    if (!this.contextLost || !this.loseExt) return
    this.loseExt.restoreContext()
  }

  /** Drops the current GL build, if there is a live one. */
  private releaseGL() {
    if (!this.ready) return
    this.atlas.dispose()
    this.gl.deleteProgram(this.program)
    this.gl.deleteBuffer(this.instanceBuffer)
    this.gl.deleteBuffer(this.quadBuffer)
    this.gl.deleteBuffer(this.overlayBuffer)
    this.gl.deleteVertexArray(this.vao)
    this.gl.deleteVertexArray(this.overlayVao)
    this.ready = false
  }

  /**
   * Recomputes whole-pixel cell metrics; returns whether the display scale
   * changed (e.g. a window moved between monitors).
   */
  private syncDeviceMetrics(): boolean {
    const dpr = window.devicePixelRatio || 1
    if (dpr === this.dpr) return false
    this.dpr = dpr
    this.deviceCellWidth = Math.max(1, Math.round(this.baseCellWidth * dpr))
    this.deviceCellHeight = Math.max(1, Math.round(this.baseCellHeight * dpr))
    // Derive the logical size back from the rounded device size, so the browser
    // doesn't rescale the backing store and fit() sees the drawn grid.
    this.cellWidth = this.deviceCellWidth / dpr
    this.cellHeight = this.deviceCellHeight / dpr
    return true
  }

  /** (Re)builds everything that lives on the GL context. */
  private initGL() {
    this.releaseGL()
    const gl = this.gl
    this.ready = false

    // Rasterized at device scale.
    this.atlas = new GlyphAtlas(
      gl,
      this.fonts,
      this.fontSize * this.dpr,
      this.deviceCellWidth,
      this.deviceCellHeight,
      // In device pixels, like the cell.
      Math.round(this.fonts.letterSpacing * this.dpr),
    )

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC)
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC)
    if (!vs || !fs) return

    this.program = gl.createProgram()!
    gl.attachShader(this.program, vs)
    gl.attachShader(this.program, fs)
    gl.linkProgram(this.program)
    // Otherwise a link failure just shows an empty background.
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error('Ghostty renderer program link failed:', gl.getProgramInfoLog(this.program))
      return
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)

    gl.useProgram(this.program)
    this.uResolution = gl.getUniformLocation(this.program, 'u_resolution')
    this.uAtlas = gl.getUniformLocation(this.program, 'u_atlas')
    this.uColorAtlas = gl.getUniformLocation(this.program, 'u_colorAtlas')
    this.uBlendMode = gl.getUniformLocation(this.program, 'u_blendMode')
    gl.uniform2f(this.uResolution, this.cols, this.rows)
    gl.uniform1i(this.uAtlas, 0)
    gl.uniform1i(this.uColorAtlas, 1)
    gl.uniform1i(this.uBlendMode, this.blendMode)

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

    this.instanceData = new Float32Array(this.cols * this.rows * INSTANCE_FLOATS)
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData, gl.DYNAMIC_DRAW)

    this.bindInstanceAttribs()

    // The cursor overlay has its own VAO and buffer: WebGL2 has no base-instance
    // draw, so this avoids re-pointing attributes twice a frame.
    this.overlayVao = gl.createVertexArray()!
    gl.bindVertexArray(this.overlayVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.overlayBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.overlayData, gl.DYNAMIC_DRAW)
    this.bindInstanceAttribs()
    gl.bindVertexArray(this.vao)

    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    this.ready = true
  }

  /**
   * Queues one column of a cursor shape to draw over the finished grid. The
   * background is the cursor color at zero alpha, so the shader returns the
   * cursor color with coverage as alpha, which composites correctly in every
   * blend mode. `spansTwo` means the shape was rasterized double-width for a
   * wide cell, and each column samples its half.
   */
  private pushCursorOverlay(
    col: number,
    row: number,
    glyph: number,
    spansTwo: boolean,
    cellWidth: number,
  ) {
    if (this.overlayCount >= CURSOR_OVERLAY_CAP) return
    const rect = this.atlas.getGlyph(glyph, spansTwo ? GLYPH_WIDE : 0)
    const mid = (rect.u0 + rect.u1) / 2

    let i = this.overlayCount * INSTANCE_FLOATS
    const d = this.overlayData
    d[i++] = col
    d[i++] = row
    d[i++] = this.cursorR
    d[i++] = this.cursorG
    d[i++] = this.cursorB
    d[i++] = 255
    d[i++] = this.cursorR
    d[i++] = this.cursorG
    d[i++] = this.cursorB
    d[i++] = 0
    d[i++] = spansTwo && cellWidth === 0 ? mid : rect.u0
    d[i++] = rect.v0
    d[i++] = spansTwo && cellWidth === 2 ? mid : rect.u1
    d[i++] = rect.v1
    d[i++] = 0
    this.overlayCount++
  }

  /**
   * Points the per-instance attributes at the bound ARRAY_BUFFER, in the bound
   * VAO. Shared by the grid and the cursor overlay.
   */
  private bindInstanceAttribs() {
    const gl = this.gl
    const stride = INSTANCE_FLOATS * 4

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

    // a_color
    gl.enableVertexAttribArray(5)
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 14 * 4)
    gl.vertexAttribDivisor(5, 1)
  }

  private resizeCanvas() {
    // Backing store in device pixels; CSS box in logical units.
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

  /**
   * Color space to blend glyph coverage in, as a BLEND_* value. Safe before the
   * program links; the value is applied at link time.
   */
  setTextBlending(mode: number) {
    this.blendMode = mode
    if (!this.ready) return
    this.gl.useProgram(this.program)
    this.gl.uniform1i(this.uBlendMode, mode)
  }

  /**
   * Turns run shaping on or off. Existing atlas slots stay valid.
   */
  setLigatures(on: boolean) {
    this.ligatures = on
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
      // initGL rebuilds the atlas for the new scale and sizes the buffer.
      this.initGL()
      return
    }
    if (!this.ready) return

    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)

    gl.useProgram(this.program)
    gl.uniform2f(this.uResolution, cols, rows)

    this.instanceData = new Float32Array(cols * rows * INSTANCE_FLOATS)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData, gl.DYNAMIC_DRAW)
  }

  /** Scratch buffer for one grapheme cluster's codepoints. */
  private graphemeBuffer(wasm: GhosttyWasm): number {
    if (this.graphemePtr === 0) {
      this.graphemePtr = allocBufferOrThrow(wasm, GRAPHEME_CAP * 4)
      this.lineWasm = wasm
    }
    return this.graphemePtr
  }

  /**
   * Scratch buffer for the whole viewport, grown on demand (never shrunk, to
   * avoid reallocating on every divider drag).
   */
  private viewportBuffer(wasm: GhosttyWasm, cells: number): number {
    if (this.viewportPtr !== 0 && this.viewportCells >= cells) return this.viewportPtr
    // Allocate the replacement before freeing, so a failure keeps the old
    // buffer.
    const next = allocBufferOrThrow(wasm, cells * CELL_BYTES)
    if (this.viewportPtr !== 0) {
      wasm.exports.ghostty_wasm_free_u8_array(this.viewportPtr, this.viewportCells * CELL_BYTES)
    }
    this.viewportPtr = next
    this.viewportCells = cells
    this.lineWasm = wasm
    return this.viewportPtr
  }

  /** Scratch buffer for one scrollback row, grown on demand. */
  private lineBuffer(wasm: GhosttyWasm, cells: number): number {
    if (this.linePtr !== 0 && this.lineCells >= cells) return this.linePtr
    // Replacement before release — see viewportBuffer.
    const next = allocBufferOrThrow(wasm, cells * CELL_BYTES)
    if (this.linePtr !== 0) {
      wasm.exports.ghostty_wasm_free_u8_array(this.linePtr, this.lineCells * CELL_BYTES)
    }
    this.linePtr = next
    this.lineCells = cells
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

    // Sized from the WASM dimensions, which may lag ours during a resize.
    const cellCount = wasmCols * wasmRows
    const expectedBufSize = cellCount * CELL_BYTES
    const viewportBufPtr = this.viewportBuffer(wasm, cellCount)

    // Zero the reused buffer so a shrink or short read can't leave the previous
    // frame's cells in the tail.
    new Uint8Array(wasm.exports.memory.buffer, viewportBufPtr, expectedBufSize).fill(0)

    // Takes a cell count, not a byte count.
    wasm.exports.ghostty_render_state_get_viewport(termPtr, viewportBufPtr, cellCount)

    viewportOffset = Math.max(0, Math.min(viewportOffset, scrollbackCount))
    // The scratch row is only needed when scrolled up.
    const linePtr = viewportOffset > 0 ? this.lineBuffer(wasm, wasmCols) : 0
    const graphemePtr = this.graphemeBuffer(wasm)

    // Views after all allocations: growing memory detaches older buffers.
    const viewportView = new DataView(wasm.exports.memory.buffer, viewportBufPtr, expectedBufSize)
    const lineView = linePtr !== 0
      ? new DataView(wasm.exports.memory.buffer, linePtr, wasmCols * CELL_BYTES)
      : null
    const graphemeView = graphemePtr !== 0
      ? new DataView(wasm.exports.memory.buffer, graphemePtr, GRAPHEME_CAP * 4)
      : null

    // The core can't change colors at runtime, so cells still on its default
    // fg/bg are mapped onto the current theme. Explicitly colored cells are left
    // alone.
    const coreFg = wasm.exports.ghostty_render_state_get_fg_color(termPtr)
    const coreFgR = (coreFg >> 16) & 0xff, coreFgG = (coreFg >> 8) & 0xff, coreFgB = coreFg & 0xff
    const coreBg = wasm.exports.ghostty_render_state_get_bg_color(termPtr)
    const coreBgR = (coreBg >> 16) & 0xff, coreBgG = (coreBg >> 8) & 0xff, coreBgB = coreBg & 0xff

    // Normalized so selections can be dragged either way.
    let selStart = this.selection?.start
    let selEnd = this.selection?.end
    if (selStart && selEnd) {
      if (selStart.y > selEnd.y || (selStart.y === selEnd.y && selStart.x > selEnd.x)) {
        const swap = selStart; selStart = selEnd; selEnd = swap
      }
    }

    // Hidden while scrolled back: the cursor belongs to the live screen.
    const cursor = this.cursor && viewportOffset === 0 ? this.cursor : null
    this.sawBlinkingCell = false

    // Grown with the grid; overwritten per row before use.
    if (this.ligatures && (this.runs === null || this.runs.head.length < cols)) {
      this.runs = {
        head: new Int32Array(cols),
        span: new Int32Array(cols),
        cp: new Int32Array(cols),
        brk: new Uint8Array(cols),
        linkState: new Uint8Array(cols),
        cell: emptyCell(),
      }
    }
    const runs = this.runs

    let outIdx = 0
    this.overlayCount = 0

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

      // A wide character's spacer column draws the right half of the glyph
      // started in the previous column.
      let pendingWide: GlyphRect | null = null
      let cursorOnWide: boolean = false

      const rowHighlights = this.searchHighlights?.get(absRow)
      const rowLink = this.linkHighlight?.find((s) => s.row === absRow) ?? null
      const rowLinks = this.linkRanges?.filter((s) => s.row === absRow) ?? null
      const rowHints = this.hintLabels?.filter((h) => h.row === absRow) ?? null
      const rowHidden = this.hiddenSpans?.filter((s) => s.row === absRow) ?? null

      // Ligature runs for this row. The break and link-state scratch rows are
      // filled first because `computeRuns` reads them.
      let runsThisRow = false
      if (this.ligatures && rowValid && runs !== null) {
        runs.brk.fill(0, 0, cols)
        runs.linkState.fill(0, 0, cols)
        if (cursor !== null && cursor.row === r && cursor.col < cols) {
          // The cursor's cell leaves the run, so a block cursor shows the typed
          // character rather than a slice of a ligature.
          runs.brk[cursor.col] = 1
        }
        if (rowHints !== null) {
          for (const hint of rowHints) {
            for (let i = 0; i < hint.text.length; i++) {
              const at = hint.col + i
              if (at >= 0 && at < cols) runs.brk[at] = 1
            }
          }
        }
        if (rowLinks !== null) {
          for (const s of rowLinks) {
            for (let i = Math.max(0, s.from); i <= Math.min(cols - 1, s.to); i++) {
              runs.linkState[i] = 2
            }
          }
        }
        if (rowLink !== null) {
          for (let i = Math.max(0, rowLink.from); i <= Math.min(cols - 1, rowLink.to); i++) {
            runs.linkState[i] = 1
          }
        }
        const base = isScrollback ? 0 : activeRow * wasmCols * CELL_BYTES
        computeRuns(isScrollback ? lineView! : viewportView, base, wasmCols, cols, runs)
        runsThisRow = true
      }
      /** The run in progress, and how far through its cells this row is. */
      let runRect: GlyphRect | null = null
      let runCells = 0
      let runIndex = 0

      for (let c = 0; c < cols; c++) {
        let codepoint = 0
        let flags = 0
        // 1 for a normal cell, 2 for a wide character's head, 0 for its spacer.
        let cellWidth = 1
        /** Codepoints beyond the first; non-zero means a cluster to compose. */
        let graphemeLen = 0
        /** Underline style and overline; see CELL2_* in wasmBindings. */
        let attrs2 = 0
        // Cells outside the core's grid use the theme colors.
        let finalFgR = this.defaultFgR
        let finalFgG = this.defaultFgG
        let finalFgB = this.defaultFgB
        let finalBgR = this.defaultBgR
        let finalBgG = this.defaultBgG
        let finalBgB = this.defaultBgB
        // Only the default background may be translucent, as in xterm.
        let bgIsDefault = true
        /**
         * The glyph should vanish into its cell (`hiddenSpans`, or blink off). Its
         * alpha must also follow the background's, or on a translucent pane the
         * hidden glyph shows as a more opaque silhouette.
         */
        let glyphHidden = false

        if (rowValid && c < wasmCols) {
          // Into the reusable scratch cell.
          const cell = isScrollback
            ? parseCellInto(lineView!, c * CELL_BYTES, this.scratchCell)
            : parseCellInto(viewportView, (activeRow * wasmCols + c) * CELL_BYTES, this.scratchCell)

          codepoint = cell.codepoint
          flags = cell.flags
          cellWidth = cell.width
          graphemeLen = cell.graphemeLen
          attrs2 = cell.attrs2
          // Already RGB; just map default-colored cells onto the current theme.
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

        // A hint label replaces the cell's contents. Labels never sit on a wide
        // character's spacer.
        if (rowHints !== null) {
          for (let i = 0; i < rowHints.length; i++) {
            const hint = rowHints[i]
            const at = c - hint.col
            if (at < 0 || at >= hint.text.length) continue
            codepoint = hint.text.charCodeAt(at)
            flags = CELL_BOLD
            attrs2 = 0
            cellWidth = 1
            graphemeLen = 0
            finalFgR = HINT_FG[0]; finalFgG = HINT_FG[1]; finalFgB = HINT_FG[2]
            finalBgR = HINT_BG[0]; finalBgG = HINT_BG[1]; finalBgB = HINT_BG[2]
            bgIsDefault = false
            break
          }
        }

        // Faint is applied to the color, not the atlas key, so it costs no extra
        // rasters.
        if ((flags & CELL_FAINT) !== 0) {
          finalFgR = (finalFgR * FAINT_SCALE) | 0
          finalFgG = (finalFgG * FAINT_SCALE) | 0
          finalFgB = (finalFgB * FAINT_SCALE) | 0
        }

        let u0 = 0, v0 = 0, u1 = 0, v1 = 0
        // Set alongside the UVs, so a color glyph is never sampled as coverage.
        let isColor = 0
        if (cellWidth === 0 && pendingWide) {
          // The spacer draws the right half of the previous column's glyph.
          u0 = (pendingWide.u0 + pendingWide.u1) / 2
          v0 = pendingWide.v0
          u1 = pendingWide.u1
          v1 = pendingWide.v1
          isColor = pendingWide.color ? 1 : 0
          pendingWide = null
        } else if (codepoint > 0 && (flags & CELL_INVISIBLE) === 0) {
          // Invisible hides the character but keeps the cell's colors.
          const wide = cellWidth === 2
          let style = wide ? GLYPH_WIDE : 0
          if (flags & CELL_BOLD) style |= GLYPH_BOLD
          if (flags & CELL_ITALIC) style |= GLYPH_ITALIC
          if (flags & CELL_UNDERLINE) {
            // attrs2 says which underline style; each is its own raster.
            style |= GLYPH_UNDERLINE | ((attrs2 & CELL2_UNDERLINE_MASK) << GLYPH_UL_SHIFT)
          } else if (rowLink !== null && c >= rowLink.from && c <= rowLink.to) {
            // The hovered link: solid.
            style |= GLYPH_UNDERLINE
          } else if (rowLinks !== null && rowLinks.some((s) => c >= s.from && c <= s.to)) {
            // Other links: dotted.
            style |= GLYPH_UNDERLINE | (UNDERLINE_DOTTED << GLYPH_UL_SHIFT)
          }
          if (attrs2 & CELL2_OVERLINE) style |= GLYPH_OVERLINE
          if (flags & CELL_STRIKETHROUGH) style |= GLYPH_STRIKETHROUGH

          // The head of a ligature run shapes the whole run into one slot; later
          // cells draw their slice of it.
          if (runsThisRow && runs !== null && runs.head[c] === c) {
            const cells = runs.span[c]
            let text = ''
            for (let i = 0; i < cells; i++) text += String.fromCharCode(runs.cp[c + i])
            const shaped = this.atlas.getRunGlyph(text, style, cells)
            // Null when the run cache is full; fall back to per-codepoint glyphs.
            if (shaped !== null) {
              runRect = shaped
              runCells = cells
              runIndex = 0
            }
          }

          // Clusters (combining marks, emoji joiners) rasterize as a whole.
          const inRun = runRect !== null
          let rect
          if (inRun && runRect !== null) {
            // Each column samples its slice of the run's raster.
            const slice = (runRect.u1 - runRect.u0) / runCells
            u0 = runRect.u0 + slice * runIndex
            u1 = u0 + slice
            v0 = runRect.v0
            v1 = runRect.v1
            isColor = runRect.color ? 1 : 0
            if (++runIndex >= runCells) runRect = null
            pendingWide = null
          } else if (graphemeLen > 0 && graphemeView) {
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
          if (!inRun) {
            if (!rect) rect = this.atlas.getGlyph(codepoint, style)
            v0 = rect.v0; v1 = rect.v1
            u0 = rect.u0
            u1 = wide ? (rect.u0 + rect.u1) / 2 : rect.u1
            isColor = rect.color ? 1 : 0
            pendingWide = wide ? rect : null
          }
        } else {
          pendingWide = null
        }

        if ((flags & CELL_INVERSE) !== 0) {
          const tempR = finalFgR, tempG = finalFgG, tempB = finalFgB
          finalFgR = finalBgR; finalFgG = finalBgG; finalFgB = finalBgB
          finalBgR = tempR; finalBgG = tempG; finalBgB = tempB
          bgIsDefault = false
        }

        // Search tint goes under the selection.
        if (rowHighlights) {
          for (let i = 0; i < rowHighlights.length; i++) {
            const h = rowHighlights[i]
            if (c < h.from || c > h.to) continue
            const tint = h.active ? SEARCH_ACTIVE_BG : SEARCH_MATCH_BG
            finalBgR = tint[0]; finalBgG = tint[1]; finalBgB = tint[2]
            bgIsDefault = false
            // The active hit is light, so use dark text.
            if (h.active) {
              finalFgR = 0x1a; finalFgG = 0x1a; finalFgB = 0x1a
            }
            break
          }
        }

        let isSelected = false
        if (selStart && selEnd && absRow >= selStart.y && absRow <= selEnd.y) {
          let from: number
          let to: number
          if (this.selection?.rectangular) {
            // Same span on every row; order the columns.
            from = Math.min(selStart.x, selEnd.x)
            to = Math.max(selStart.x, selEnd.x)
          } else {
            from = absRow === selStart.y ? selStart.x : 0
            to = absRow === selEnd.y ? selEnd.x : cols - 1
          }
          isSelected = c >= from && c <= to
        }

        if (isSelected) {
          // Lightened rather than inverted, and always opaque.
          finalBgR = (finalBgR * 0.7 + 255 * 0.3) | 0
          finalBgG = (finalBgG * 0.7 + 255 * 0.3) | 0
          finalBgB = (finalBgB * 0.7 + 255 * 0.3) | 0
          bgIsDefault = false
        }

        // After the background rules, so a flickering line also hides under a
        // selection or search hit.
        if (rowHidden !== null) {
          for (let i = 0; i < rowHidden.length; i++) {
            const span = rowHidden[i]
            if (c < span.from || c >= span.to) continue
            finalFgR = finalBgR; finalFgG = finalBgG; finalFgB = finalBgB
            glyphHidden = true
            // A color glyph ignores the foreground; send it down the coverage path
            // (an empty slot) so it hides too.
            isColor = 0
            break
          }
        }

        // A block cursor recolors this cell (glyph in the background color), so
        // it needs no extra draw. On a wide character it covers both columns.
        let atCursor = false
        if (cursor !== null && cursor.row === r) {
          atCursor = cursor.col === c || (cursorOnWide && cellWidth === 0)
        }
        cursorOnWide = atCursor && cellWidth === 2

        if (cursor && atCursor) {
          const shape = cursor.shape ?? CURSOR_STYLE_BLOCK
          const shaped =
            cursor.on && cursor.focused && shape !== CURSOR_STYLE_BLOCK
              ? shape === CURSOR_STYLE_BAR
                ? GLYPH_CURSOR_BAR
                : shape === CURSOR_STYLE_UNDERLINE
                  ? GLYPH_CURSOR_UNDERLINE
                  : GLYPH_CURSOR_OUTLINE // hollow block
              : 0
          if (shaped !== 0) {
            // Bars, underlines and hollow blocks are drawn over the cell in a second
            // pass so the character stays visible. A bar draws only in the leading
            // column.
            const spansTwo = shape !== CURSOR_STYLE_BAR && (cellWidth === 2 || cellWidth === 0)
            if (!(shape === CURSOR_STYLE_BAR && cellWidth === 0)) {
              this.pushCursorOverlay(c, r, shaped, spansTwo, cellWidth)
            }
          } else if (cursor.on && cursor.focused) {
            finalFgR = this.defaultBgR; finalFgG = this.defaultBgG; finalFgB = this.defaultBgB
            finalBgR = this.cursorR; finalBgG = this.cursorG; finalBgB = this.cursorB
            bgIsDefault = false
          } else if (!cursor.focused) {
            // An unfocused pane outlines the cell (over it, in the second pass).
            const spansTwo = cellWidth === 2 || cellWidth === 0
            this.pushCursorOverlay(c, r, GLYPH_CURSOR_OUTLINE, spansTwo, cellWidth)
          }
        }

        // Blink last, once all colors are settled, so hiding by matching the
        // background works under inverse, selection, search and cursor.
        if ((flags & CELL_BLINK) !== 0) {
          this.sawBlinkingCell = true
          if (!this.blinkOn) {
            finalFgR = finalBgR; finalFgG = finalBgG; finalFgB = finalBgB
            glyphHidden = true
            // Same as hiddenSpans: route color glyphs through the coverage path.
            isColor = 0
          }
        }

        this.instanceData[outIdx++] = c
        this.instanceData[outIdx++] = r

        this.instanceData[outIdx++] = finalFgR
        this.instanceData[outIdx++] = finalFgG
        this.instanceData[outIdx++] = finalFgB
        // Opaque normally; a hidden glyph takes the background's alpha.
        this.instanceData[outIdx++] =
          glyphHidden && bgIsDefault ? this.defaultBgA * 255 : 255

        this.instanceData[outIdx++] = finalBgR
        this.instanceData[outIdx++] = finalBgG
        this.instanceData[outIdx++] = finalBgB
        this.instanceData[outIdx++] = bgIsDefault ? this.defaultBgA * 255 : 255

        this.instanceData[outIdx++] = u0
        this.instanceData[outIdx++] = v0
        this.instanceData[outIdx++] = u1
        this.instanceData[outIdx++] = v1
        // Faint scales a color glyph's own colors.
        this.instanceData[outIdx++] =
          isColor === 0 ? 0 : (flags & CELL_FAINT) !== 0 ? FAINT_SCALE : 1
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData)

    gl.clearColor(this.defaultBgR / 255, this.defaultBgG / 255, this.defaultBgB / 255, this.defaultBgA)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.texture)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.colorTexture)

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, cols * rows)

    // Cursor shapes drawn over the finished grid.
    if (this.overlayCount > 0) {
      gl.bindVertexArray(this.overlayVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuffer)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.overlayData, 0, this.overlayCount * INSTANCE_FLOATS)
      gl.enable(gl.BLEND)
      // Separate alpha: straight RGBA, so the cursor's edges match glyph edges
      // on a translucent pane.
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.overlayCount)
      gl.disable(gl.BLEND)
      gl.bindVertexArray(this.vao)
    }
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    if (this.lineWasm) {
      if (this.viewportPtr !== 0) {
        this.lineWasm.exports.ghostty_wasm_free_u8_array(this.viewportPtr, this.viewportCells * CELL_BYTES)
        this.viewportPtr = 0
        this.viewportCells = 0
      }
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
