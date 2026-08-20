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
layout(location = 5) in float a_color;   // 0 for coverage; else how much colour the glyph keeps

uniform vec2 u_resolution; // (cols, rows)

out vec4 v_fgColor;
out vec4 v_bgColor;
out vec2 v_uv;
// Flat because it is a per-instance flag, not a quantity: interpolating it
// would put fragments in the middle of a quad at values that mean neither.
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

// Glyph coverage and cell background resolve in one pass. The alpha channel is
// mixed along with the colour, so a glyph stays opaque even where it sits on a
// translucent default background — that is what lets the pane's opacity reach
// the clear colour without also fading the text.
const FRAGMENT_SHADER_SRC = `#version 300 es
// highp rather than the mediump this shader used to declare: the corrected
// mode divides by the fg/bg luminance difference, and a mediump quotient of
// two nearby values is exactly where that goes visibly wrong. Every target
// this app runs on (WebView2 on desktop GPUs) treats the two identically
// anyway, so the precision is free here in a way it would not be on mobile.
precision highp float;

in vec4 v_fgColor;
in vec4 v_bgColor;
in vec2 v_uv;
flat in float v_color;

uniform sampler2D u_atlas;
// The colour companion, sampled only by the branch below. It shares the
// coverage atlas's packing, so v_uv addresses it unchanged.
uniform sampler2D u_colorAtlas;
// One of the BLEND_* constants below. A uniform branch, so every fragment in
// a frame takes the same path and the GPU never diverges within a warp.
uniform int u_blendMode;

out vec4 outColor;

// Mix in the framebuffer's own space. Cheap, and what this renderer always
// did — but sRGB values are not proportional to light, so the result is not
// a blend of anything physical, and two cells whose colours differ in hue
// darken where their glyph edges meet.
const int BLEND_NATIVE = 0;
// Mix in linear light. Correct, and visibly so on contrasting hues — but it
// renders dark-on-light text thinner and light-on-dark thicker than the face
// was drawn to look, because rasterizers have long assumed the sRGB blend's
// accidental weight is there.
const int BLEND_LINEAR = 1;
// Linear, with ghostty's weight correction: solve for the coverage that
// reproduces the *native* blend's luminance, then blend linearly with it.
// Weight therefore matches BLEND_NATIVE while the darkening artifact stays
// gone. See the comment on the solve itself.
const int BLEND_LINEAR_CORRECTED = 2;

// The exact piecewise sRGB transfer function rather than a 2.2 power law.
// The two diverge near black, which for glyph coverage is precisely the
// range the correction below is solving in.
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
        // An emoji is not a mask, so none of the coverage machinery below
        // applies to it: there is no single foreground to weight against, and
        // the blend modes exist to make *text* the weight the face intended.
        // Straight source-over onto the cell's background is the whole job.
        //
        // v_color is a scale rather than a flag, because faint is the one
        // attribute that acts on a colour glyph as well: it darkens the
        // foreground towards black, and the equivalent here is to darken the
        // face's own colours by the same factor. Anything above zero means
        // colour; how far above says how much of it is kept.
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
        // Take the luminance of each end, blend *those* the gamma-incorrect
        // way to get the luminance the native path would have produced, then
        // map it back onto [bg_l, fg_l] to recover the coverage that reaches
        // the same luminance through a linear blend. The whole point is that
        // this has no tunable constant in it: the target is not a taste, it
        // is what the other mode already renders.
        float fgL = luminance(fgLin);
        float bgL = luminance(bgLin);
        // Guard the division: as the two luminances converge the quotient
        // stops being meaningful, and there is nothing to correct anyway.
        if (abs(fgL - bgL) > 0.001) {
            float blendL = linearize(unlinearize(fgL) * a + unlinearize(bgL) * (1.0 - a));
            a = clamp((blendL - bgL) / (fgL - bgL), 0.0, 1.0);
        }
    }

    // Alpha stays in coverage units: it is this pane's opacity, not light,
    // and it is what keeps a glyph opaque over a translucent background.
    outColor = vec4(unlinearize(mix(bgLin, fgLin, a)), mix(v_bgColor.a, v_fgColor.a, a));
}
`

/** Values `setTextBlending` takes; they are the shader's BLEND_* constants,
 *  and the engine maps the user-facing setting onto them. */
export const BLEND_NATIVE = 0
export const BLEND_LINEAR = 1
export const BLEND_LINEAR_CORRECTED = 2

/** Floats per instance: cell position, foreground, background, UVs, and the
 *  scale saying which atlas those UVs address and how strongly to draw it. */
const INSTANCE_FLOATS = 15

/** How far faint text is darkened towards black. One constant, because the
 *  coverage path applies it to the foreground and the colour path applies it
 *  to the glyph's own colours, and the two have to fade alike. */
const FAINT_SCALE = 0.55

/**
 * The one place cell metrics are derived. Both the renderer (which sizes the
 * canvas as `cols * cellWidth`) and the engine's fit (which derives cols from
 * the container) have to agree to the pixel: when they measured separately,
 * cols came from one width and the canvas from another, and nothing — not
 * re-fitting, not resizing the window — could reconcile them.
 */
export function measureCell(
  fonts: FontSelection,
  fontSize: number,
): { width: number; height: number } {
  const ctx = document.createElement('canvas').getContext('2d')!
  // Always the regular face, and always its ordinary weight. The grid must not
  // shift when a cell happens to be bold or italic, so a per-style face is
  // measured against the body font's cell rather than its own -- which is also
  // why an overwide face is condensed into its slot rather than given more
  // room. The weight is emitted because a Light and a Black cut of the same
  // family do not advance identically, so the cell has to be measured at the
  // weight the body text will actually be drawn in.
  ctx.font = `${fonts.weight === 400 ? '' : `${fonts.weight} `}${fontSize}px ${fonts.regular}`
  return {
    // Floored at one pixel: a face that has not resolved yet measures zero,
    // and a zero-width cell is a division by zero in every grid fit downstream.
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
  /**
   * Column-wise rather than line-wise: every row takes the same column span
   * instead of running to the end of the line and wrapping. Pulls one field out
   * of tabular output without the rest of each row.
   */
  rectangular?: boolean
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

/** Hint labels: dark on amber, so a label cannot be mistaken for output
 *  whatever the theme or the program underneath it is painting. */
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
  /** 0..1. Reaches the clear colour and default-background cells only. */
  private defaultBgA = 1

  // Held on the instance rather than only pushed to the uniform, because the
  // program is rebuilt on a context loss and the renderer itself is rebuilt on
  // every font change — and both start on the shader's own defaults. Same
  // reason the engine re-applies the theme in those paths.
  private blendMode = BLEND_NATIVE
  /**
   * Whether to shape runs of operators as one string, which is what makes a
   * ligature-carrying face actually ligate. Off by default: it costs atlas
   * slots and only pays for itself on a font that has the substitutions, so
   * it is the user's call rather than something a default install absorbs.
   */
  private ligatures = false
  /** Per-row run bookkeeping, allocated with the grid. See `computeRuns`. */
  private runs: RunScratch | null = null

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
  private loseExt: WEBGL_lose_context | null = null
  // False until the program links and the GL objects exist. A failed link would
  // otherwise turn one console error into an exception on every frame.
  private ready = false

  /** Absolute-coordinate selection to highlight, or null. */
  selection: SelectionRange | null = null

  /** Where to paint the cursor block, or null for none. */
  cursor: CursorState | null = null

  /** The blink phase for cells carrying the blink attribute. */
  blinkOn = true
  /**
   * Whether the last frame actually contained any. Lets the owner skip the
   * repaint a blink tick would otherwise force on every pane forever.
   */
  sawBlinkingCell = false

  /**
   * Search hits to highlight, grouped by absolute row. Grouped rather than a
   * flat list because the alternative is scanning every match for every cell;
   * this way a row costs one lookup and a cell costs a walk of just its own
   * row's hits, which is almost always none.
   */
  searchHighlights: Map<number, SearchHighlight[]> | null = null

  /**
   * The link under the pointer, as the rows and columns it covers, or null.
   *
   * A flat list rather than a map by row: there is at most one hovered link
   * and it covers one row, or a handful when it wraps, so the lookup per row
   * is a walk of two or three entries — the grouping `searchHighlights` needs
   * would cost more than it saves here.
   *
   * Feedback is a style bit on the covered cells rather than new geometry: the
   * renderer already folds `CELL_UNDERLINE` into the atlas key, so an
   * underlined link costs at most one extra atlas entry per glyph, bounded by
   * the link's own text.
   */
  linkHighlight: { row: number; from: number; to: number }[] | null = null

  /**
   * Every link on screen, whether or not the pointer is on one.
   *
   * These are drawn with a dotted underline and the hovered one with a solid
   * one, which is what makes a link *discoverable*: underlining only under the
   * pointer means a link is invisible until you happen to hold Ctrl over it,
   * and nobody holds Ctrl over text they have no reason to think is a link.
   * Two distinct rules rather than a colour change, so nothing here has to
   * argue with the theme or with whatever colour the program chose for its own
   * output.
   */
  linkRanges: { row: number; from: number; to: number }[] | null = null

  /**
   * Hint-mode labels to paint over the grid, or null when the mode is off.
   *
   * Drawn as cells rather than as an overlay: a label is a character in a
   * cell, which is exactly what this loop already draws, so it costs the
   * colours and nothing else. Absolute rows, so a label stays on its link as
   * output scrolls the screen underneath it.
   */
  hintLabels: { row: number; col: number; text: string }[] | null = null

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

  // The whole viewport is read into a scratch buffer once per frame, per pane.
  // Cached on the same terms as `lineBuffer` above rather than allocated and
  // freed inside updateStaticGrid: at 200x60 that is a 192 KB malloc, a
  // zero-fill and a free every frame, which is the one thing here its two
  // neighbours were already careful not to do.
  private viewportPtr = 0
  private viewportCells = 0

  /** One cell, reused for every cell of every frame — see `parseCellInto`. */
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

    const { width: cellWidth, height: cellHeight } = measureCell(fonts, fontSize)
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
    // The same extension is how a pane hands its context back voluntarily when
    // it is no longer on screen — see releaseContext.
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
    // Nothing from the old context survives, so mark the build dead before
    // rebuilding rather than trying to delete objects that no longer exist.
    this.ready = false
    // Every glyph the atlas had cached lived in a texture that is gone too, so
    // the cache goes with it.
    this.initGL()
    this.onRestore?.()
  }

  get isContextLost(): boolean {
    return this.contextLost
  }

  /**
   * Hands the GL context back to the browser.
   *
   * There is a hard ceiling on how many WebGL contexts can be live at once —
   * around sixteen in Chromium — and past it the browser starts taking them
   * from whoever it likes. Every tab in this app stays mounted, just hidden, so
   * a dozen tabs of one pane each is enough to reach that on its own. A pane
   * that isn't on screen has no use for a context, and giving it up on purpose
   * is what keeps the ceiling away from the panes that are.
   *
   * Nothing is lost by doing this: the terminal lives in WASM, and everything
   * dropped here — the atlas, the buffers, the program — is rebuilt from it.
   */
  releaseContext() {
    if (this.contextLost || !this.loseExt) return
    this.releaseGL()
    // Fires webglcontextlost, which is what actually sets contextLost.
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
      this.fonts,
      this.fontSize * this.dpr,
      this.deviceCellWidth,
      this.deviceCellHeight,
      // In device pixels, like everything else the atlas is handed: the cell
      // it centres a glyph in is the device-pixel one.
      Math.round(this.fonts.letterSpacing * this.dpr),
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

  /**
   * Colour space to blend glyph coverage in, as one of the BLEND_* values.
   *
   * Safe to call before the program links — the value is held and pushed at
   * link time, which is the path a new pane actually takes.
   */
  setTextBlending(mode: number) {
    this.blendMode = mode
    if (!this.ready) return
    this.gl.useProgram(this.program)
    this.gl.uniform1i(this.uBlendMode, mode)
  }

  /**
   * Turns run shaping on or off. Nothing is cached across the change beyond
   * the atlas slots already taken, which stay valid — a run slot is only ever
   * reached through a run, so switching off simply stops asking for them.
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
   * Scratch buffer for the whole viewport, grown on demand — the same shape
   * as `lineBuffer` below, deliberately, so the three scratch buffers in this
   * class read the same way.
   *
   * Grown rather than resized exactly: a pane that shrinks keeps the larger
   * allocation, which costs a little memory and saves a free/malloc pair on
   * every drag of a split divider. The caller only ever reads the first
   * `cells` of it.
   */
  private viewportBuffer(wasm: GhosttyWasm, cells: number): number {
    if (this.viewportPtr !== 0 && this.viewportCells >= cells) return this.viewportPtr
    // The replacement is taken before the incumbent is released, so a failure
    // costs nothing. Freeing first meant one refused allocation also threw away
    // the working buffer and pinned viewportCells at 0 — the pane could then
    // never repaint again even once memory came back.
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

    // Sized from the WASM dimensions rather than ours, since a resize can land
    // on one side before the other.
    const cellCount = wasmCols * wasmRows
    const expectedBufSize = cellCount * CELL_BYTES
    const viewportBufPtr = this.viewportBuffer(wasm, cellCount)

    // Kept even though the buffer is now cached rather than freshly allocated,
    // and *because* of it. The vendored PR #142 zero-initialises WASM page
    // buffers, which would make this redundant for a fresh allocation — but a
    // reused buffer is exactly the case that fix does not cover, so without
    // this a shrink (or a short `get_viewport` return) would leave the
    // previous frame's cells sitting in the uncovered tail and paint them.
    // Costs a memset against a malloc+free it replaces, which is the cheaper
    // half of what was here before.
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
    this.sawBlinkingCell = false

    // Grown with the grid rather than with the pane's lifetime: `cols` only
    // moves on a resize, and every one of these is overwritten per row before
    // it is read.
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
      const rowLink = this.linkHighlight?.find((s) => s.row === absRow) ?? null
      const rowLinks = this.linkRanges?.filter((s) => s.row === absRow) ?? null
      const rowHints = this.hintLabels?.filter((h) => h.row === absRow) ?? null

      // Ligature runs for this row. The two scratch rows are filled first
      // because `computeRuns` reads them: `rowBreak` for the cells whose
      // contents get replaced outright, `rowLinkState` for the underline this
      // loop adds from outside the cell's own flags.
      let runsThisRow = false
      if (this.ligatures && rowValid && runs !== null) {
        runs.brk.fill(0, 0, cols)
        runs.linkState.fill(0, 0, cols)
        if (cursor !== null && cursor.row === r && cursor.col < cols) {
          // The cursor's own cell leaves the run, so what sits under a block
          // cursor is the character you typed rather than a slice of the
          // ligature it formed. It is what other terminals do, and it reuses
          // the run breaking already needed for everything else.
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
        // 1 for an ordinary cell (and for anything outside the core's grid),
        // 2 for the head of a wide character, 0 for its trailing spacer.
        let cellWidth = 1
        /** Codepoints beyond the first; non-zero means a cluster to compose. */
        let graphemeLen = 0
        /** Underline style and overline; see CELL2_* in wasmBindings. */
        let attrs2 = 0
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
          // Read into the renderer's own scratch cell: every field is copied
          // into locals on the next few lines and the object never escapes,
          // so a fresh one per cell per frame was garbage by construction.
          const cell = isScrollback
            ? parseCellInto(lineView!, c * CELL_BYTES, this.scratchCell)
            : parseCellInto(viewportView, (activeRow * wasmCols + c) * CELL_BYTES, this.scratchCell)

          codepoint = cell.codepoint
          flags = cell.flags
          cellWidth = cell.width
          graphemeLen = cell.graphemeLen
          attrs2 = cell.attrs2
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

        // A hint label replaces whatever the cell held, in colours chosen to be
        // unmistakably not the program's output. Applied after the cell is read
        // so it wins outright, and before the glyph is chosen so the label is
        // what gets rasterized. A label never sits on a wide character's
        // spacer: overriding the width to 1 leaves nothing pending, and the
        // spacer beside it simply draws blank.
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

        // Faint is a foreground effect, not a glyph one, so it stays out of the
        // atlas key — otherwise every dimmed character would cost a second
        // raster identical to the one already cached.
        if ((flags & CELL_FAINT) !== 0) {
          finalFgR = (finalFgR * FAINT_SCALE) | 0
          finalFgG = (finalFgG * FAINT_SCALE) | 0
          finalFgB = (finalFgB * FAINT_SCALE) | 0
        }

        let u0 = 0, v0 = 0, u1 = 0, v1 = 0
        // Which atlas those UVs address. Set wherever they are, and from the
        // same rect, so a colour glyph cannot end up sampled as coverage --
        // which would draw it as a solid block of the foreground colour.
        let isColor = 0
        if (cellWidth === 0 && pendingWide) {
          // The spacer draws the right half of the glyph the previous column
          // started, so the character spans both cells at its true width.
          u0 = (pendingWide.u0 + pendingWide.u1) / 2
          v0 = pendingWide.v0
          u1 = pendingWide.u1
          v1 = pendingWide.v1
          isColor = pendingWide.color ? 1 : 0
          pendingWide = null
        } else if (codepoint > 0 && (flags & CELL_INVISIBLE) === 0) {
          // Invisible keeps the cell's colours — it hides the character, it
          // does not blank the background — so it skips the glyph only.
          const wide = cellWidth === 2
          let style = wide ? GLYPH_WIDE : 0
          if (flags & CELL_BOLD) style |= GLYPH_BOLD
          if (flags & CELL_ITALIC) style |= GLYPH_ITALIC
          if (flags & CELL_UNDERLINE) {
            // The bit says underlined; attrs2 says which of the five, and is
            // folded into the glyph key so each shape is its own raster.
            style |= GLYPH_UNDERLINE | ((attrs2 & CELL2_UNDERLINE_MASK) << GLYPH_UL_SHIFT)
          } else if (rowLink !== null && c >= rowLink.from && c <= rowLink.to) {
            // The link under the pointer: a solid rule, so it stands out from
            // the dotted one every other link on screen carries.
            style |= GLYPH_UNDERLINE
          } else if (rowLinks !== null && rowLinks.some((s) => c >= s.from && c <= s.to)) {
            // Every other link: dotted, which reads as "this is clickable"
            // without competing with an underline the program asked for.
            style |= GLYPH_UNDERLINE | (UNDERLINE_DOTTED << GLYPH_UL_SHIFT)
          }
          if (attrs2 & CELL2_OVERLINE) style |= GLYPH_OVERLINE
          if (flags & CELL_STRIKETHROUGH) style |= GLYPH_STRIKETHROUGH

          // The head of a ligature run shapes the whole run into one slot; the
          // cells after it draw their own slice of what came back. Asked for
          // here rather than in the row pre-pass because `style` is settled by
          // the lines above, and the run is keyed on it.
          if (runsThisRow && runs !== null && runs.head[c] === c) {
            const cells = runs.span[c]
            let text = ''
            for (let i = 0; i < cells; i++) text += String.fromCharCode(runs.cp[c + i])
            const shaped = this.atlas.getRunGlyph(text, style, cells)
            // Null once the run cache is full: the cells then take the
            // ordinary per-codepoint path below, which is what they did before
            // runs existed.
            if (shaped !== null) {
              runRect = shaped
              runCells = cells
              runIndex = 0
            }
          }

          // A cell whose character carries combining marks or emoji joiners has
          // to be rasterized from the whole cluster; the cell's own codepoint is
          // only the first of them.
          const inRun = runRect !== null
          let rect
          if (inRun && runRect !== null) {
            // One quad per column still, sampling its own slice of the run's
            // raster — the same split the wide-character path makes at the
            // midpoint, generalized from two cells to N.
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
          let from: number
          let to: number
          if (this.selection?.rectangular) {
            // Every row takes the same span, and the drag may have gone right
            // to left, so the columns are ordered here rather than by the
            // row-ordering swap above.
            from = Math.min(selStart.x, selEnd.x)
            to = Math.max(selStart.x, selEnd.x)
          } else {
            from = absRow === selStart.y ? selStart.x : 0
            to = absRow === selEnd.y ? selEnd.x : cols - 1
          }
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
            // A bar or underline does not cover the character, so unlike the
            // block it leaves the cell's own colours alone and only replaces
            // the glyph — the same substitution the unfocused outline makes.
            // A bar always draws in the leading column, so a wide cell's
            // trailing spacer must not draw one too.
            const spansTwo = shape !== CURSOR_STYLE_BAR && (cellWidth === 2 || cellWidth === 0)
            if (!(shape === CURSOR_STYLE_BAR && cellWidth === 0)) {
              const rect = this.atlas.getGlyph(shaped, spansTwo ? GLYPH_WIDE : 0)
              const mid = (rect.u0 + rect.u1) / 2
              v0 = rect.v0; v1 = rect.v1
              isColor = 0
              u0 = spansTwo && cellWidth === 0 ? mid : rect.u0
              u1 = spansTwo && cellWidth === 2 ? mid : rect.u1
              finalFgR = this.cursorR; finalFgG = this.cursorG; finalFgB = this.cursorB
            }
          } else if (cursor.on && cursor.focused) {
            finalFgR = this.defaultBgR; finalFgG = this.defaultBgG; finalFgB = this.defaultBgB
            finalBgR = this.cursorR; finalBgG = this.cursorG; finalBgB = this.cursorB
            bgIsDefault = false
          } else if (!cursor.focused) {
            // An unfocused pane outlines the cell instead of filling it: it
            // still says where typing would land, without competing with the
            // pane that actually has focus. Replacing the glyph rather than
            // tinting the cell is what makes it read as an outline — and it
            // costs no extra geometry, since the outline is a cached glyph.
            // A cursor on a wide character outlines both its columns, so the
            // outline is rasterized double-width and split like any wide glyph.
            const spansTwo = cellWidth === 2 || cellWidth === 0
            const rect = this.atlas.getGlyph(GLYPH_CURSOR_OUTLINE, spansTwo ? GLYPH_WIDE : 0)
            const mid = (rect.u0 + rect.u1) / 2
            v0 = rect.v0; v1 = rect.v1
            isColor = 0
            u0 = cellWidth === 0 ? mid : rect.u0
            u1 = cellWidth === 2 ? mid : rect.u1
            finalFgR = this.cursorR; finalFgG = this.cursorG; finalFgB = this.cursorB
          }
        }

        // Applied last, once every other rule has settled what this cell's
        // colours are. Blink is the pane's own phase, not something the core
        // tracks — it says which cells asked to blink and this decides when
        // they are in their off half — and hiding the text by matching the
        // final background is what keeps it right on a cell that is also
        // inverse, selected, a search hit, or under the cursor.
        if ((flags & CELL_BLINK) !== 0) {
          this.sawBlinkingCell = true
          if (!this.blinkOn) {
            finalFgR = finalBgR; finalFgG = finalBgG; finalFgB = finalBgB
            // A colour glyph does not read the foreground, so matching it to
            // the background hides everything except an emoji -- which would
            // then be the one character on the row refusing to blink. Sending
            // the cell down the coverage path is what hides it: the sample
            // there is a slot no coverage was ever written to, and whatever it
            // returns is mixed between a foreground and a background that are
            // by now the same colour.
            isColor = 0
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
        // Faint reaches a colour glyph here rather than through the
        // foreground, which it does not read: same factor, applied to the
        // face's own colours instead.
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
