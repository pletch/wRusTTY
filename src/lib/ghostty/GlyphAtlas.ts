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
export const GLYPH_STYLE_COUNT = 32

export class GlyphAtlas {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private gl: WebGL2RenderingContext
  public texture: WebGLTexture
  /** Keyed by `codepoint * GLYPH_STYLE_COUNT + style`. */
  private cache = new Map<number, GlyphRect>()
  /** Grapheme clusters, keyed by `style:text`. */
  private clusterCache = new Map<string, GlyphRect>()

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

  private rasterize(text: string, style: number, remember: (r: GlyphRect) => void): GlyphRect {

    // A wide glyph is rasterized across a two-cell slot and later drawn as two
    // half-UV quads, so the whole character exists in the atlas exactly once.
    const slotWidth = style & GLYPH_WIDE ? this.cellWidth * 2 : this.cellWidth

    if (this.currentX + slotWidth > this.atlasWidth) {
      this.currentX = 0
      this.currentY += this.cellHeight
    }

    if (this.currentY + this.cellHeight > this.atlasHeight) {
      // Draws nothing rather than the wrong character, and only warns once —
      // this fires per glyph, so logging each one buries the console.
      if (!this.warnedFull) {
        this.warnedFull = true
        console.warn('GlyphAtlas full; further glyphs will not render.')
      }
      return this.blank ?? { x: 0, y: 0, width: 0, height: 0, u0: 0, v0: 0, u1: 0, v1: 0 }
    }

    const x = this.currentX
    const y = this.currentY

    this.ctx.font = this.fontFor(style)
    this.ctx.clearRect(x, y, slotWidth, this.cellHeight)
    this.ctx.fillText(text, x, y + this.baseline)

    if (style & GLYPH_UNDERLINE) {
      const uy = Math.min(this.cellHeight - this.lineThickness, this.baseline + this.lineThickness)
      this.ctx.fillRect(x, y + uy, slotWidth, this.lineThickness)
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

  dispose() {
    this.gl.deleteTexture(this.texture)
  }
}
