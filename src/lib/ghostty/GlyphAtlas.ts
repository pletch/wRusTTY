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
    this.ctx.textBaseline = 'top'
    this.ctx.fillStyle = 'white'
    
    // We will upload the entire canvas when a glyph is added.
    this.texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    
    // Explicitly size the texture to 1024x1024 to ensure it is created correctly
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
    this.ctx.fillText(char, x, y)
    
    const imageData = this.ctx.getImageData(x, y, this.cellWidth, this.cellHeight)
    // Extract raw bytes to bypass WebKit2GTK's broken ImageData/Canvas upload
    const pixels = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength)
    
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
      pixels
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
