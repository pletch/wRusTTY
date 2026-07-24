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

export class GlyphAtlas {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private gl: WebGL2RenderingContext
  public texture: WebGLTexture
  private cache = new Map<number, GlyphRect>()
  
  private atlasWidth = 1024
  private atlasHeight = 1024
  private currentX = 0
  private currentY = 0
  
  public readonly cellWidth: number
  public readonly cellHeight: number
  /** Baseline offset from the top of a cell, in the same pixels as cellHeight. */
  private baseline = 0

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
    
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.atlasWidth
    this.canvas.height = this.atlasHeight
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
    
    this.ctx.fillStyle = 'rgba(0,0,0,0)'
    this.ctx.fillRect(0, 0, this.atlasWidth, this.atlasHeight)
    
    this.ctx.font = `${fontSize}px ${fontFamily}`
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
    this.baseline = Math.max(
      0,
      Math.min(cellHeight, Math.round((cellHeight - (ascent + descent)) / 2 + ascent)),
    )

    this.texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.atlasWidth, this.atlasHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    // Pre-cache space
    this.getGlyph(32)
  }

  getGlyph(codepoint: number): GlyphRect {
    if (this.cache.has(codepoint)) {
      return this.cache.get(codepoint)!
    }

    if (this.currentX + this.cellWidth > this.atlasWidth) {
      this.currentX = 0
      this.currentY += this.cellHeight
    }
    
    if (this.currentY + this.cellHeight > this.atlasHeight) {
      console.warn("GlyphAtlas full! Falling back to space.")
      return this.cache.get(32)!
    }

    const char = String.fromCodePoint(codepoint)
    const x = this.currentX
    const y = this.currentY
    
    this.ctx.clearRect(x, y, this.cellWidth, this.cellHeight)
    this.ctx.fillText(char, x, y + this.baseline)

    const imageData = this.ctx.getImageData(x, y, this.cellWidth, this.cellHeight)
    
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture)
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      x,
      y,
      this.cellWidth,
      this.cellHeight,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      imageData
    )

    const rect: GlyphRect = {
      x, y, 
      width: this.cellWidth, 
      height: this.cellHeight,
      u0: x / this.atlasWidth,
      v0: y / this.atlasHeight,
      u1: (x + this.cellWidth) / this.atlasWidth,
      v1: (y + this.cellHeight) / this.atlasHeight
    }

    this.cache.set(codepoint, rect)
    
    this.currentX += this.cellWidth
    
    return rect
  }

  dispose() {
    this.gl.deleteTexture(this.texture)
  }
}
