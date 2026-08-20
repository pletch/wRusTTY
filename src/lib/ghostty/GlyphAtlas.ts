import {
  UNDERLINE_DOUBLE,
  UNDERLINE_CURLY,
  UNDERLINE_DOTTED,
  UNDERLINE_DASHED,
} from './wasmBindings'
import { isBoxGlyph, drawBoxGlyph } from './boxDrawing'

export interface GlyphRect {
  x: number
  y: number
  width: number
  height: number
  u0: number
  v0: number
  u1: number
  v1: number
}

/**
 * Style bits a glyph is rasterized with. Weight and slant change the face, and
 * the two lines are baked into the raster rather than drawn as extra geometry —
 * an underline is a rectangle inside the cell either way, and baking it keeps
 * the renderer at one quad per cell.
 */
export const GLYPH_BOLD = 1 << 0
export const GLYPH_ITALIC = 1 << 1
export const GLYPH_UNDERLINE = 1 << 2
export const GLYPH_STRIKETHROUGH = 1 << 3
/**
 * Rasterize into a slot two cells wide. East-Asian characters and most emoji
 * are drawn across two columns; squeezing one into a single-cell slot is what
 * made them come out narrow and overlapped.
 */
export const GLYPH_WIDE = 1 << 4
export const GLYPH_OVERLINE = 1 << 5
/**
 * Which underline to draw, in bits 6-8, using the `UNDERLINE_*` values from
 * wasmBindings. `GLYPH_UNDERLINE` above still means "underlined at all" and is
 * what gates the drawing; this only selects the shape, so a caller that never
 * sets it gets the plain rule it always got.
 */
export const GLYPH_UL_SHIFT = 6
export const GLYPH_UL_MASK = 0x07 << GLYPH_UL_SHIFT
export const GLYPH_STYLE_COUNT = 1 << 9

/**
 * Longest run `getRunGlyph` will shape, in cells. Three covers what the
 * ligature-forming fonts actually substitute — `===`, `!==`, `<=>`, `...` —
 * and every cell of it is atlas the single-codepoint cache is not getting.
 */
export const MAX_RUN_CELLS = 3

/**
 * How many distinct runs may hold slots before the atlas stops taking new
 * ones. Unlike a codepoint, a run's key is arbitrary text, so this is the one
 * cache here whose key space isn't bounded by the character repertoire; past
 * the cap `getRunGlyph` declines and the caller falls back to drawing the
 * cells one at a time, which is what it did before runs existed.
 */
const RUN_CACHE_CAP = 512

/**
 * How far the atlas may double. 4096x4096 of R8 is 16MB, and it is per pane —
 * each pane has its own WebGL context, so the texture genuinely cannot be
 * shared with another one. Growth is demand-driven, so this is a ceiling on
 * the pathological case rather than a cost anything pays up front.
 */
const MAX_ATLAS_SIZE = 4096

/**
 * The hollow rectangle an unfocused pane draws instead of a filled block. It is
 * a glyph rather than geometry for the same reason the underline is: the
 * renderer draws exactly one quad per cell, and a shape that fits inside a cell
 * can just be part of what that cell samples.
 *
 * Given a codepoint no text will ever use, so it cannot collide with a real
 * glyph in the cache. (A Unicode noncharacter — permanently unassigned.)
 */
export const GLYPH_CURSOR_OUTLINE = 0xfdd0
const CURSOR_OUTLINE_TEXT = String.fromCodePoint(GLYPH_CURSOR_OUTLINE)

/**
 * The non-block DECSCUSR shapes, drawn the same way as the outline above: as
 * cached glyphs substituted for the cell's own, so a shaped cursor costs no
 * extra geometry and no second draw call. A block cursor stays a recolour of
 * the cell, which is what it is.
 */
export const GLYPH_CURSOR_BAR = 0xfdd1
export const GLYPH_CURSOR_UNDERLINE = 0xfdd2
const CURSOR_BAR_TEXT = String.fromCodePoint(GLYPH_CURSOR_BAR)
const CURSOR_UNDERLINE_TEXT = String.fromCodePoint(GLYPH_CURSOR_UNDERLINE)

export class GlyphAtlas {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private gl: WebGL2RenderingContext
  public texture: WebGLTexture
  /** Keyed by `codepoint * GLYPH_STYLE_COUNT + style`. */
  private cache = new Map<number, GlyphRect>()
  /** Grapheme clusters, keyed by `style:text`. */
  private clusterCache = new Map<string, GlyphRect>()
  /** Shaped runs, keyed by `style:cells:text`. See `getRunGlyph`. */
  private runCache = new Map<string, GlyphRect>()

  private atlasWidth = 1024
  private atlasHeight = 1024
  private currentX = 0
  private currentY = 0

  public readonly cellWidth: number
  public readonly cellHeight: number
  private readonly fontFamily: string
  private readonly fontSize: number
  /** Baseline offset from the top of a cell, in the same pixels as cellHeight. */
  private baseline = 0
  private ascent = 0
  private lineThickness = 1
  /** An empty slot, handed back when the atlas has no room left. */
  private blank: GlyphRect | null = null

  constructor(
    gl: WebGL2RenderingContext,
    fontFamily: string,
    fontSize: number,
    cellWidth: number,
    cellHeight: number
  ) {
    this.gl = gl
    this.cellWidth = cellWidth
    this.cellHeight = cellHeight
    this.fontFamily = fontFamily
    this.fontSize = fontSize

    this.canvas = document.createElement('canvas')
    this.canvas.width = this.atlasWidth
    this.canvas.height = this.atlasHeight
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!

    this.ctx.fillStyle = 'rgba(0,0,0,0)'
    this.ctx.fillRect(0, 0, this.atlasWidth, this.atlasHeight)

    this.ctx.font = this.fontFor(0)
    this.ctx.fillStyle = 'white'

    // 'top' anchors to the font's ascent, which carries whatever internal
    // leading the face declares — so the ink lands wherever that happens to
    // put it, biased up or down by an amount that varies per font. The cursor
    // is drawn as the whole cell, so any such bias reads as the block sitting
    // off-centre against the character it covers.
    //
    // Placing the baseline from measured metrics instead centres the ascent +
    // descent box in the cell, which is where a block cursor expects to find
    // the glyph. Older engines omit fontBoundingBox*, hence the fallback.
    this.ctx.textBaseline = 'alphabetic'
    const m = this.ctx.measureText('Mg')
    const ascent = m.fontBoundingBoxAscent ?? fontSize * 0.8
    const descent = m.fontBoundingBoxDescent ?? fontSize * 0.2
    this.ascent = ascent
    this.baseline = Math.max(
      0,
      Math.min(cellHeight, Math.round((cellHeight - (ascent + descent)) / 2 + ascent)),
    )
    this.lineThickness = Math.max(1, Math.round(fontSize / 14))

    // Single-channel: the shader only ever reads coverage, and caching each
    // glyph in up to sixteen style combinations makes an RGBA atlas four times
    // the texture it needs to be, per pane.
    this.texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.atlasWidth, this.atlasHeight, 0, gl.RED, gl.UNSIGNED_BYTE, null)

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    // Space, unstyled — blank by construction, so it doubles as the fallback
    // for a codepoint that arrives once the atlas is full.
    this.blank = this.getGlyph(32, 0)
  }

  private fontFor(style: number): string {
    const italic = style & GLYPH_ITALIC ? 'italic ' : ''
    const bold = style & GLYPH_BOLD ? 'bold ' : ''
    return `${italic}${bold}${this.fontSize}px ${this.fontFamily}`
  }

  getGlyph(codepoint: number, style = 0): GlyphRect {
    // Weight and slant are properties of a face, and these glyphs have no
    // face — the heavy box-drawing characters are their own codepoints. Left
    // in the key they would buy a second, identical raster of every border a
    // bold prompt happens to draw.
    if (isBoxGlyph(codepoint)) style &= ~(GLYPH_BOLD | GLYPH_ITALIC)
    const key = codepoint * GLYPH_STYLE_COUNT + style
    const hit = this.cache.get(key)
    if (hit) return hit
    return this.rasterize(String.fromCodePoint(codepoint), style, (r) => this.cache.set(key, r))
  }

  /**
   * A grapheme cluster — a base character plus its combining marks, or an emoji
   * built out of joiners. It has to be rasterized as one string for the shaper
   * to compose it; drawing only the first codepoint is what left accented
   * letters bare and turned joined emoji into their first component.
   *
   * Kept in its own map so the single-codepoint path above stays a numeric key
   * and doesn't build a string per cell per frame.
   */
  getClusterGlyph(text: string, style = 0): GlyphRect {
    const key = `${style}:${text}`
    const hit = this.clusterCache.get(key)
    if (hit) return hit
    return this.rasterize(text, style, (r) => this.clusterCache.set(key, r))
  }

  /**
   * A run of `cells` same-styled columns, rasterized as one string into a slot
   * that wide — which is what makes ligatures happen. Canvas 2D `fillText`
   * runs the browser's full shaping stack, so `calt` fires as soon as the
   * substitution has both of its inputs in the same call; drawing one cell at
   * a time is the only reason it never did.
   *
   * The renderer slices the returned rect at cell boundaries and emits one
   * quad per column, exactly as the two-cell wide path already does. Handing
   * back a single quad spanning the run would be less code and would reopen
   * every decision that rests on one-quad-per-cell: the baked underline, the
   * unfocused cursor outline, the DECSCUSR shapes.
   *
   * Returns null once `RUN_CACHE_CAP` distinct runs are held, so the caller
   * can fall back rather than fill the atlas with them.
   */
  getRunGlyph(text: string, style: number, cells: number): GlyphRect | null {
    const key = `${style}:${cells}:${text}`
    const hit = this.runCache.get(key)
    if (hit) return hit
    if (this.runCache.size >= RUN_CACHE_CAP) {
      // Said once, for the same reason the full-atlas warning is: this is
      // reached per run per frame. Worth saying at all because the symptom of
      // silently declining is "ligatures stopped working partway down the
      // screen", which looks like a renderer fault rather than a bound.
      if (!this.warnedRunsFull) {
        this.warnedRunsFull = true
        console.warn(
          `GlyphAtlas run cache full at ${RUN_CACHE_CAP} runs; further runs draw cell by cell.`,
        )
      }
      return null
    }
    return this.rasterize(text, style, (r) => this.runCache.set(key, r), cells)
  }

  /**
   * One underline in the style SGR asked for. Everything is drawn as filled
   * rects on whole pixels rather than stroked paths, for the same reason the
   * cursor outline is: a stroke straddles its path and comes out half-covered
   * on both sides at these sizes. The curl is the exception and is stroked,
   * because a wave built from rects reads as a dotted line.
   *
   * `kind` is a `UNDERLINE_*` value; anything unrecognised (including `none`,
   * which the caller should not have passed) falls back to a plain rule so an
   * underlined cell is never silently un-underlined.
   */
  private drawUnderline(x: number, y: number, w: number, kind: number): void {
    const t = this.lineThickness
    switch (kind) {
      case UNDERLINE_DOUBLE: {
        // Pulled up rather than down: the lower rule would otherwise sit on the
        // cell boundary and touch the row beneath.
        const gap = Math.max(1, Math.round(t * 2))
        this.ctx.fillRect(x, Math.max(0, y - gap), w, t)
        this.ctx.fillRect(x, y, w, t)
        break
      }
      case UNDERLINE_DOTTED: {
        const dot = Math.max(1, Math.round(t))
        for (let i = 0; i < w; i += dot * 2) this.ctx.fillRect(x + i, y, Math.min(dot, w - i), t)
        break
      }
      case UNDERLINE_DASHED: {
        const dash = Math.max(2, Math.round(t * 3))
        for (let i = 0; i < w; i += dash * 2) this.ctx.fillRect(x + i, y, Math.min(dash, w - i), t)
        break
      }
      case UNDERLINE_CURLY: {
        const amp = Math.max(1, t)
        const period = Math.max(4, amp * 4)
        const mid = y + t / 2
        this.ctx.save()
        this.ctx.strokeStyle = this.ctx.fillStyle
        this.ctx.lineWidth = t
        this.ctx.beginPath()
        for (let i = 0; i <= w; i++) {
          const py = mid + Math.sin((i / period) * Math.PI * 2) * amp
          if (i === 0) this.ctx.moveTo(x, py)
          else this.ctx.lineTo(x + i, py)
        }
        this.ctx.stroke()
        this.ctx.restore()
        break
      }
      default:
        this.ctx.fillRect(x, y, w, t)
    }
  }

  /**
   * Doubles the atlas when it runs out of rows, up to `MAX_ATLAS_SIZE` or
   * whatever the GL implementation will give us.
   *
   * This exists because running out was not a degradation, it was a cliff:
   * every glyph after the last slot drew blank, nothing ever evicted, and the
   * pane stayed that way until its font changed. And the cliff is close. At
   * device-pixel-ratio 2 — an ordinary laptop — a 14px cell is 16x34, which is
   * 1920 slots, or 960 for the double-width ones CJK uses. A thousand distinct
   * Han characters is a document, not a stress test.
   *
   * Growth is demand-driven, so a Latin pane never leaves 1MB. Returns false
   * when there is nowhere left to grow, which puts the old warn-and-blank back
   * as the terminal state rather than as the first thing that happens.
   */
  private grow(): boolean {
    const gl = this.gl
    const size = this.atlasWidth * 2
    const limit = Math.min(MAX_ATLAS_SIZE, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number)
    if (size > limit) return false

    const oldWidth = this.atlasWidth
    const oldHeight = this.atlasHeight

    // Read the coverage out before touching anything: resizing a canvas resets
    // it, and this is the only copy of what has been rasterized so far.
    const rgba = this.ctx.getImageData(0, 0, oldWidth, oldHeight).data
    const coverage = new Uint8Array(oldWidth * oldHeight)
    for (let i = 0; i < coverage.length; i++) coverage[i] = rgba[i * 4 + 3]

    // A fresh canvas rather than a resize of this one, so the old content can
    // be blitted across in the same step. Context state does not survive
    // either way, hence the re-establishment below.
    const next = document.createElement('canvas')
    next.width = size
    next.height = size
    const nextCtx = next.getContext('2d', { willReadFrequently: true })
    if (!nextCtx) return false
    nextCtx.drawImage(this.canvas, 0, 0)
    this.canvas = next
    this.ctx = nextCtx
    this.ctx.fillStyle = 'white'
    this.ctx.textBaseline = 'alphabetic'

    this.atlasWidth = size
    this.atlasHeight = size

    // The same texture object, reallocated. Sampler parameters are texture
    // state rather than level state, so they survive; the renderer re-reads
    // `.texture` every frame anyway, but keeping the identity means nothing
    // holding it can go stale.
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, null)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, oldWidth, oldHeight, gl.RED, gl.UNSIGNED_BYTE, coverage)

    // The right-hand half of every already-packed row is left unused — slots
    // are handed out strictly forward and nothing goes back to fill it. So a
    // doubling buys roughly three times the slots rather than four, which is
    // the price of not having to relocate anything that has already been
    // handed out.
    //
    // Every cached rect's UVs are normalized against the old dimensions, so
    // they all move. Mutated in place rather than replaced: the renderer holds
    // rects across cells within a frame — `pendingWide`, and a run's rect
    // across its slices — and growth can happen in the middle of one.
    this.rescale()
    return true
  }

  /** Re-normalizes every cached rect against the current atlas dimensions. */
  private rescale(): void {
    const fix = (r: GlyphRect) => {
      r.u0 = r.x / this.atlasWidth
      r.v0 = r.y / this.atlasHeight
      r.u1 = (r.x + r.width) / this.atlasWidth
      r.v1 = (r.y + r.height) / this.atlasHeight
    }
    for (const r of this.cache.values()) fix(r)
    for (const r of this.clusterCache.values()) fix(r)
    for (const r of this.runCache.values()) fix(r)
  }

  private rasterize(
    text: string,
    style: number,
    remember: (r: GlyphRect) => void,
    cells = 1,
  ): GlyphRect {

    // A wide glyph is rasterized across a two-cell slot and later drawn as two
    // half-UV quads, so the whole character exists in the atlas exactly once.
    // A shaped run is the same idea at `cells` wide.
    const slotWidth = (style & GLYPH_WIDE ? 2 : cells) * this.cellWidth

    if (this.currentX + slotWidth > this.atlasWidth) {
      this.currentX = 0
      this.currentY += this.cellHeight
    }

    if (this.currentY + this.cellHeight > this.atlasHeight && !this.grow()) {
      // Draws nothing rather than the wrong character, and only warns once —
      // this fires per glyph, so logging each one buries the console.
      if (!this.warnedFull) {
        this.warnedFull = true
        console.warn(
          `GlyphAtlas full at ${this.atlasWidth}x${this.atlasHeight}; further glyphs will not render.`,
        )
      }
      return this.blank ?? { x: 0, y: 0, width: 0, height: 0, u0: 0, v0: 0, u1: 0, v1: 0 }
    }

    const x = this.currentX
    const y = this.currentY

    this.ctx.font = this.fontFor(style)
    this.ctx.clearRect(x, y, slotWidth, this.cellHeight)

    // Box drawing, block elements and Powerline separators are geometry
    // against the cell rather than characters from a face; see boxDrawing.ts
    // for why. Tried before the cursor shapes only because it is the same
    // kind of substitution and reads better grouped with them.
    const single = text.length <= 2 ? text.codePointAt(0) : undefined
    if (single !== undefined && isBoxGlyph(single)) {
      drawBoxGlyph(this.ctx, single, x, y, slotWidth, this.cellHeight, this.lineThickness)
    } else if (text === CURSOR_BAR_TEXT) {
      // A bar sits at the leading edge of the cell and is deliberately thicker
      // than a rule: at one pixel it disappears against text on a HiDPI pane.
      this.ctx.fillRect(x, y, Math.max(1, Math.round(this.lineThickness * 2)), this.cellHeight)
    } else if (text === CURSOR_UNDERLINE_TEXT) {
      const t = Math.max(1, Math.round(this.lineThickness * 2))
      this.ctx.fillRect(x, y + this.cellHeight - t, slotWidth, t)
    } else if (text === CURSOR_OUTLINE_TEXT) {
      // Drawn as four edges rather than a stroked rect so the line lands on
      // whole pixels; a stroke straddles its path and comes out half-covered on
      // both sides of it.
      const t = this.lineThickness
      this.ctx.fillRect(x, y, slotWidth, t)
      this.ctx.fillRect(x, y + this.cellHeight - t, slotWidth, t)
      this.ctx.fillRect(x, y, t, this.cellHeight)
      this.ctx.fillRect(x + slotWidth - t, y, t, this.cellHeight)
    } else {
      // Condensed to the slot when the face draws wider than the cell it was
      // measured for. `measureCell` sizes a cell from one glyph of the first
      // family that resolves, so anything reached by per-glyph fallback — a
      // proportional face, a symbol font, a wide character that arrived
      // without GLYPH_WIDE — can overrun. The readback below is bounded to the
      // slot, so an overrun never reaches another glyph's texels; it is simply
      // sliced off, and the character loses its right-hand side for the
      // session. Scaling it to fit keeps it legible instead, which is what the
      // GLYPH_WIDE slot already does for the wide characters the core flags.
      const inkWidth = this.ctx.measureText(text).width
      // A run is fitted in both directions, not just condensed. Its ink is the
      // font's own advances for `cells` characters, and the cell is a rounded
      // measurement of one — over three columns that difference accumulates
      // into a visible drift against the cells the slices are drawn into.
      if (inkWidth > 0 && (cells > 1 ? inkWidth !== slotWidth : inkWidth > slotWidth)) {
        this.ctx.save()
        this.ctx.translate(x, y + this.baseline)
        this.ctx.scale(slotWidth / inkWidth, 1)
        this.ctx.fillText(text, 0, 0)
        this.ctx.restore()
      } else {
        this.ctx.fillText(text, x, y + this.baseline)
      }
    }

    if (style & GLYPH_UNDERLINE) {
      const uy = Math.min(this.cellHeight - this.lineThickness, this.baseline + this.lineThickness)
      this.drawUnderline(x, y + uy, slotWidth, (style & GLYPH_UL_MASK) >> GLYPH_UL_SHIFT)
    }
    if (style & GLYPH_OVERLINE) {
      this.ctx.fillRect(x, y, slotWidth, this.lineThickness)
    }
    if (style & GLYPH_STRIKETHROUGH) {
      const sy = Math.max(0, Math.round(this.baseline - this.ascent * 0.3))
      this.ctx.fillRect(x, y + sy, slotWidth, this.lineThickness)
    }

    // Coverage lives in the alpha channel of the 2D canvas; the atlas stores
    // only that, so it is unpacked here rather than uploaded four-fold.
    const rgba = this.ctx.getImageData(x, y, slotWidth, this.cellHeight).data
    const coverage = new Uint8Array(slotWidth * this.cellHeight)
    for (let i = 0; i < coverage.length; i++) coverage[i] = rgba[i * 4 + 3]

    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    // Rows are one byte per texel and so rarely 4-aligned, which is the
    // default and would shear every upload whose width isn't a multiple of 4.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      x,
      y,
      slotWidth,
      this.cellHeight,
      gl.RED,
      gl.UNSIGNED_BYTE,
      coverage,
    )

    const rect: GlyphRect = {
      x, y,
      width: slotWidth,
      height: this.cellHeight,
      u0: x / this.atlasWidth,
      v0: y / this.atlasHeight,
      u1: (x + slotWidth) / this.atlasWidth,
      v1: (y + this.cellHeight) / this.atlasHeight
    }

    remember(rect)

    this.currentX += slotWidth

    return rect
  }

  private warnedFull = false
  private warnedRunsFull = false

  dispose() {
    this.gl.deleteTexture(this.texture)
  }
}
