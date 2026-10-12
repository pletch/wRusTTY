import {
  UNDERLINE_DOUBLE,
  UNDERLINE_CURLY,
  UNDERLINE_DOTTED,
  UNDERLINE_DASHED,
} from './wasmBindings'
import { isBoxGlyph, drawBoxGlyph } from './boxDrawing'
import { familyForCodepoint, type FontSelection } from '../fontStack'
import { cellBaseline } from '../cellBaseline'

export interface GlyphRect {
  x: number
  y: number
  width: number
  height: number
  u0: number
  v0: number
  u1: number
  v1: number
  /**
   * True when the face drew the glyph in its own colors (COLR/CBDT emoji), so it
   * lives in `colorTexture`. Both atlases share the UV scheme; this says which
   * sampler to use.
   */
  color: boolean
}

/**
 * Style bits a glyph is rasterized with. Lines are baked into the raster so the
 * renderer stays at one quad per cell.
 */
export const GLYPH_BOLD = 1 << 0
export const GLYPH_ITALIC = 1 << 1
export const GLYPH_UNDERLINE = 1 << 2
export const GLYPH_STRIKETHROUGH = 1 << 3
/**
 * Rasterize into a two-cell slot, for East Asian characters and most emoji.
 */
export const GLYPH_WIDE = 1 << 4
export const GLYPH_OVERLINE = 1 << 5
/**
 * Which underline shape to draw, in bits 6-8 (`UNDERLINE_*` from wasmBindings).
 * `GLYPH_UNDERLINE` still gates drawing; zero here is the plain rule.
 */
export const GLYPH_UL_SHIFT = 6
export const GLYPH_UL_MASK = 0x07 << GLYPH_UL_SHIFT
export const GLYPH_STYLE_COUNT = 1 << 9

/**
 * Longest run `getRunGlyph` will shape, in cells. Five covers arrow ligatures
 * like `<===>`; longer ones mostly repeat.
 */
export const MAX_RUN_CELLS = 5

/**
 * How much atlas the run cache may hold, in cells (not runs, so changing
 * `MAX_RUN_CELLS` doesn't change the reservation). Past it `getRunGlyph`
 * declines and cells draw one at a time.
 */
const RUN_CACHE_CELL_BUDGET = 1536

/**
 * How far the atlas may double. 4096x4096 R8 is 16MB per pane (each pane has
 * its own context); growth is on demand.
 */
const MAX_ATLAS_SIZE = 4096

/**
 * The color atlas's starting size (vs 1024 for coverage): color glyphs are few
 * and cost four bytes a texel.
 */
const COLOR_ATLAS_START = 512

/**
 * The hollow rectangle an unfocused pane's cursor draws, as a cached glyph.
 * Uses a Unicode noncharacter so it can't collide with real text.
 */
export const GLYPH_CURSOR_OUTLINE = 0xfdd0
const CURSOR_OUTLINE_TEXT = String.fromCodePoint(GLYPH_CURSOR_OUTLINE)

/**
 * The bar and underline DECSCUSR cursor shapes, as cached glyphs on
 * noncharacters like the outline.
 */
export const GLYPH_CURSOR_BAR = 0xfdd1
export const GLYPH_CURSOR_UNDERLINE = 0xfdd2
const CURSOR_BAR_TEXT = String.fromCodePoint(GLYPH_CURSOR_BAR)
const CURSOR_UNDERLINE_TEXT = String.fromCodePoint(GLYPH_CURSOR_UNDERLINE)

export class GlyphAtlas {
  /**
   * A scratch surface one slot wide (the widest is a run): each glyph is drawn
   * at the origin and read back. The atlas contents live in `mirror`.
   */
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  /**
   * CPU copy of the coverage texture (one byte a texel), needed to reallocate
   * on growth.
   */
  private mirror: Uint8Array
  private gl: WebGL2RenderingContext
  public texture: WebGLTexture
  /** The color atlas; a 1x1 placeholder until the first color glyph. */
  public colorTexture: WebGLTexture
  private colorWidth = 0
  private colorHeight = 0
  private colorX = 0
  private colorY = 0
  /**
   * CPU copy of the color atlas, for growth.
   */
  private colorMirror: Uint8Array | null = null
  /** Keyed by `codepoint * GLYPH_STYLE_COUNT + style`. */
  private cache = new Map<number, GlyphRect>()
  /** Grapheme clusters, keyed by `style:text`. */
  private clusterCache = new Map<string, GlyphRect>()
  /** Shaped runs, keyed by `style:cells:text`. See `getRunGlyph`. */
  private runCache = new Map<string, GlyphRect>()
  /** Atlas cells those runs occupy; see the budget above. */
  private runCellsHeld = 0

  private atlasWidth = 1024
  private atlasHeight = 1024
  private currentX = 0
  private currentY = 0

  public readonly cellWidth: number
  public readonly cellHeight: number
  private readonly fonts: FontSelection
  private readonly fontSize: number
  /** Left offset for drawn text within its slot; see the constructor. */
  private readonly inset: number = 0
  /** Baseline offset from the top of a cell, in the same pixels as cellHeight. */
  private baseline = 0
  private ascent = 0
  private lineThickness = 1
  /** An empty slot, handed back when the atlas has no room left. */
  private blank: GlyphRect | null = null

  constructor(
    gl: WebGL2RenderingContext,
    fonts: FontSelection,
    fontSize: number,
    cellWidth: number,
    cellHeight: number,
    /** How much of `cellWidth` is letter spacing, in device pixels (the
     *  selection's value is in CSS pixels). */
    letterSpacing = 0
  ) {
    this.gl = gl
    this.cellWidth = cellWidth
    this.cellHeight = cellHeight
    this.fonts = fonts
    this.fontSize = fontSize
    // Center the glyph in a widened cell; an odd pixel goes on the right.
    this.inset = Math.max(0, Math.floor(letterSpacing / 2))

    // Wide enough for the widest slot (a run), one cell tall.
    this.canvas = document.createElement('canvas')
    this.canvas.width = Math.max(2, MAX_RUN_CELLS) * cellWidth
    this.canvas.height = cellHeight
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
    this.mirror = new Uint8Array(this.atlasWidth * this.atlasHeight)

    this.ctx.font = this.fontFor(0)
    this.ctx.fillStyle = 'white'

    // Place the baseline from measured metrics so the ascent+descent box is
    // centered in the cell (where a block cursor expects the glyph); 'top'
    // would bias by the face's internal leading. Fallback for engines without
    // fontBoundingBox*.
    this.ctx.textBaseline = 'alphabetic'
    const m = this.ctx.measureText('Mg')
    const ascent = m.fontBoundingBoxAscent ?? fontSize * 0.8
    const descent = m.fontBoundingBoxDescent ?? fontSize * 0.2
    this.ascent = ascent
    // Shared with the DOM inline suggestion, which must match exactly; see
    // lib/cellBaseline.ts.
    this.baseline = cellBaseline(ascent, descent, cellHeight)
    this.lineThickness = Math.max(1, Math.round(fontSize / 14))

    // Single-channel coverage. Color glyphs get a separate RGBA texture that
    // stays 1x1 until needed, so panes without emoji don't pay for RGBA.
    this.texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.atlasWidth, this.atlasHeight, 0, gl.RED, gl.UNSIGNED_BYTE, null)

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    // A sampler the shader references must have a complete texture bound.
    this.colorTexture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    // Space: blank, so it doubles as the fallback when the atlas is full.
    this.blank = this.getGlyph(32, 0)
  }

  /**
   * The CSS font shorthand for a style, optionally for a pinned family. Weight
   * and slant keywords are omitted when the family already is that face (the
   * `*IsFace` flags), to avoid double slant. A range override is one family, so
   * it keeps the keywords.
   */
  private fontFor(style: number, override?: string | null): string {
    const wantBold = (style & GLYPH_BOLD) !== 0
    const wantItalic = (style & GLYPH_ITALIC) !== 0
    let family: string
    let emitBold = wantBold
    let emitItalic = wantItalic

    if (override) {
      family = override
    } else if (wantBold && wantItalic) {
      family = this.fonts.boldItalic
      if (this.fonts.boldItalicIsFace) {
        emitItalic = false
        // Only the dedicated bold-italic slot supplies the weight too.
        emitBold = this.fonts.boldItalicNeedsWeight
      }
    } else if (wantItalic) {
      family = this.fonts.italic
      if (this.fonts.italicIsFace) emitItalic = false
    } else if (wantBold) {
      family = this.fonts.bold
      if (this.fonts.boldIsFace) emitBold = false
    } else {
      family = this.fonts.regular
    }

    // A numeric weight, emitted only when not the CSS default.
    const weight = emitBold ? this.fonts.boldWeight : this.fonts.weight
    const emitWeight = emitBold || weight !== 400
    return `${emitItalic ? 'italic ' : ''}${emitWeight ? `${weight} ` : ''}${this.fontSize}px ${family}`
  }

  getGlyph(codepoint: number, style = 0): GlyphRect {
    // Box glyphs have no face; weight and slant would only duplicate rasters.
    if (isBoxGlyph(codepoint)) style &= ~(GLYPH_BOLD | GLYPH_ITALIC)
    const key = codepoint * GLYPH_STYLE_COUNT + style
    const hit = this.cache.get(key)
    if (hit) return hit
    // A pinned range depends only on the codepoint, so it needs no key.
    return this.rasterize(String.fromCodePoint(codepoint), style, (r) => this.cache.set(key, r), 1, codepoint)
  }

  /**
   * A grapheme cluster (base plus combining marks, or a joined emoji),
   * rasterized as one string so the shaper composes it. Separate map so the
   * single-codepoint path keeps numeric keys.
   */
  getClusterGlyph(text: string, style = 0): GlyphRect {
    const key = `${style}:${text}`
    const hit = this.clusterCache.get(key)
    if (hit) return hit
    // The base character picks the face for the whole cluster.
    return this.rasterize(text, style, (r) => this.clusterCache.set(key, r), 1, text.codePointAt(0))
  }

  /**
   * A run of `cells` same-styled columns rasterized as one string, so `fillText`
   * applies ligatures (`calt`). The renderer slices it per cell to keep one quad
   * per cell. Returns null once `RUN_CACHE_CELL_BUDGET` is reached so the caller
   * can fall back.
   */
  getRunGlyph(text: string, style: number, cells: number): GlyphRect | null {
    const key = `${style}:${cells}:${text}`
    const hit = this.runCache.get(key)
    if (hit) return hit
    if (this.runCellsHeld + cells > RUN_CACHE_CELL_BUDGET) {
      // Warn once: the symptom is ligatures stopping partway down the screen.
      if (!this.warnedRunsFull) {
        this.warnedRunsFull = true
        console.warn(
          `GlyphAtlas run cache full at ${RUN_CACHE_CELL_BUDGET} cells;` +
            ' further runs draw cell by cell.',
        )
      }
      return null
    }
    // Runs are ASCII operators, so the first codepoint settles the face.
    return this.rasterize(
      text,
      style,
      (r) => {
        this.runCache.set(key, r)
        // Charged only when a slot is actually handed out.
        this.runCellsHeld += cells
      },
      cells,
      text.codePointAt(0),
    )
  }

  /**
   * One underline in the SGR style. Filled whole-pixel rects rather than strokes
   * (strokes straddle pixels); the curl is stroked. Unknown kinds draw a plain
   * rule.
   */
  private drawUnderline(x: number, y: number, w: number, kind: number): void {
    const t = this.lineThickness
    switch (kind) {
      case UNDERLINE_DOUBLE: {
        // Upward, so the lower rule doesn't touch the next row.
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
   * Doubles the atlas when it runs out of rows, up to `MAX_ATLAS_SIZE` or the GL
   * limit. Returns false when it can't grow; glyphs then draw blank.
   */
  private grow(): boolean {
    const gl = this.gl
    const size = this.atlasWidth * 2
    const limit = Math.min(MAX_ATLAS_SIZE, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number)
    if (size > limit) return false

    const oldWidth = this.atlasWidth
    const oldHeight = this.atlasHeight

    // Copy the old rows into the wider mirror.
    const next = new Uint8Array(size * size)
    for (let row = 0; row < oldHeight; row++) {
      next.set(this.mirror.subarray(row * oldWidth, (row + 1) * oldWidth), row * size)
    }
    this.mirror = next

    this.atlasWidth = size
    this.atlasHeight = size

    // Reallocate the same texture object; sampler parameters survive.
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, next)

    // The right half of existing rows stays unused (slots only move forward),
    // so a doubling buys about three times the slots. Cached rects are rescaled
    // in place, since the renderer may hold one mid-frame. The color atlas is
    // independent.
    this.rescale()
    return true
  }

  /** Re-normalizes every cached rect against the current atlas dimensions. */
  private rescale(): void {
    // Each rect against its own atlas's dimensions.
    const fix = (r: GlyphRect) => {
      const w = r.color ? this.colorWidth : this.atlasWidth
      const h = r.color ? this.colorHeight : this.atlasHeight
      r.u0 = r.x / w
      r.v0 = r.y / h
      r.u1 = (r.x + r.width) / w
      r.v1 = (r.y + r.height) / h
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
    codepoint?: number,
  ): GlyphRect {
// A wide glyph or run is rasterized once across its slot and drawn as
// per-cell slices.
    const slotWidth = (style & GLYPH_WIDE ? 2 : cells) * this.cellWidth

    if (this.currentX + slotWidth > this.atlasWidth) {
      this.currentX = 0
      this.currentY += this.cellHeight
    }

    if (this.currentY + this.cellHeight > this.atlasHeight && !this.grow()) {
      // Draw nothing rather than the wrong glyph; warn once.
      if (!this.warnedFull) {
        this.warnedFull = true
        console.warn(
          `GlyphAtlas full at ${this.atlasWidth}x${this.atlasHeight}; further glyphs will not render.`,
        )
      }
      return this.blank ?? { x: 0, y: 0, width: 0, height: 0, u0: 0, v0: 0, u1: 0, v1: 0, color: false }
    }

    const x = this.currentX
    const y = this.currentY

    const pinned =
      codepoint === undefined || this.fonts.ranges.length === 0
        ? null
        : familyForCodepoint(this.fonts.ranges, codepoint)
    this.ctx.font = this.fontFor(style, pinned)
    // Drawn at the scratch origin; placed at (x, y) below.
    this.ctx.clearRect(0, 0, slotWidth, this.cellHeight)

    // Box drawing, block elements and Powerline glyphs are drawn as geometry;
    // see boxDrawing.ts.
    const single = text.length <= 2 ? text.codePointAt(0) : undefined
    if (single !== undefined && isBoxGlyph(single)) {
      drawBoxGlyph(this.ctx, single, 0, 0, slotWidth, this.cellHeight, this.lineThickness)
    } else if (text === CURSOR_BAR_TEXT) {
      // Thicker than a rule so it stays visible on HiDPI.
      this.ctx.fillRect(0, 0, Math.max(1, Math.round(this.lineThickness * 2)), this.cellHeight)
    } else if (text === CURSOR_UNDERLINE_TEXT) {
      const t = Math.max(1, Math.round(this.lineThickness * 2))
      this.ctx.fillRect(0, this.cellHeight - t, slotWidth, t)
    } else if (text === CURSOR_OUTLINE_TEXT) {
      // Four edges rather than a stroke, to land on whole pixels.
      const t = this.lineThickness
      this.ctx.fillRect(0, 0, slotWidth, t)
      this.ctx.fillRect(0, this.cellHeight - t, slotWidth, t)
      this.ctx.fillRect(0, 0, t, this.cellHeight)
      this.ctx.fillRect(slotWidth - t, 0, t, this.cellHeight)
    } else {
      // Condense glyphs wider than the slot (fallback faces can overrun the
      // measured cell) rather than clipping them. Measured against the slot
      // minus letter spacing, so widening cells doesn't stretch glyphs.
      const drawWidth = Math.max(1, slotWidth - this.inset * 2)
      const inkWidth = this.ctx.measureText(text).width
      // Runs are fitted both ways, so rounding of the cell width doesn't drift
      // across columns.
      if (inkWidth > 0 && (cells > 1 ? inkWidth !== drawWidth : inkWidth > drawWidth)) {
        this.ctx.save()
        this.ctx.translate(this.inset, this.baseline)
        this.ctx.scale(drawWidth / inkWidth, 1)
        this.ctx.fillText(text, 0, 0)
        this.ctx.restore()
      } else {
        this.ctx.fillText(text, this.inset, this.baseline)
      }
    }

    if (style & GLYPH_UNDERLINE) {
      const uy = Math.min(this.cellHeight - this.lineThickness, this.baseline + this.lineThickness)
      this.drawUnderline(0, uy, slotWidth, (style & GLYPH_UL_MASK) >> GLYPH_UL_SHIFT)
    }
    if (style & GLYPH_OVERLINE) {
      this.ctx.fillRect(0, 0, slotWidth, this.lineThickness)
    }
    if (style & GLYPH_STRIKETHROUGH) {
      const sy = Math.max(0, Math.round(this.baseline - this.ascent * 0.3))
      this.ctx.fillRect(0, sy, slotWidth, this.lineThickness)
    }

    // Coverage is the canvas alpha. Everything is drawn white, so any
    // non-white pixel means the face painted its own colors (a color emoji).
    const rgba = this.ctx.getImageData(0, 0, slotWidth, this.cellHeight).data
    const coverage = new Uint8Array(slotWidth * this.cellHeight)
    let colored = false
    for (let i = 0; i < coverage.length; i++) {
      const a = rgba[i * 4 + 3]
      coverage[i] = a
      if (!colored && a !== 0) {
        colored = rgba[i * 4] !== 255 || rgba[i * 4 + 1] !== 255 || rgba[i * 4 + 2] !== 255
      }
    }

    const gl = this.gl
    if (colored) {
      // Never touched the coverage atlas; the slot is reused.
      const rect = this.packColor(rgba, slotWidth)
      remember(rect)
      return rect
    }
    // Into the mirror with the atlas's stride.
    for (let row = 0; row < this.cellHeight; row++) {
      this.mirror.set(
        coverage.subarray(row * slotWidth, (row + 1) * slotWidth),
        (y + row) * this.atlasWidth + x,
      )
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    // One-byte rows are rarely 4-aligned.
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

    const rect = this.finishSlot(x, y, slotWidth)
    remember(rect)
    return rect
  }

  /** The rect for a just-filled coverage slot; advances the cursor. */
  private finishSlot(x: number, y: number, slotWidth: number): GlyphRect {
    const rect: GlyphRect = {
      x, y,
      width: slotWidth,
      height: this.cellHeight,
      u0: x / this.atlasWidth,
      v0: y / this.atlasHeight,
      u1: (x + slotWidth) / this.atlasWidth,
      v1: (y + this.cellHeight) / this.atlasHeight,
      color: false,
    }
    this.currentX += slotWidth
    return rect
  }

  /**
   * Packs a color glyph into the color atlas, which has its own packing and
   * dimensions so it doesn't grow along with the coverage atlas.
   */
  private packColor(rgba: Uint8ClampedArray, slotWidth: number): GlyphRect {
    const gl = this.gl
    if (this.colorMirror === null) this.allocateColor()

    if (this.colorX + slotWidth > this.colorWidth) {
      this.colorX = 0
      this.colorY += this.cellHeight
    }
    if (this.colorY + this.cellHeight > this.colorHeight && !this.growColor()) {
      if (!this.warnedColorFull) {
        this.warnedColorFull = true
        console.warn(
          `GlyphAtlas color companion full at ${this.colorWidth}x${this.colorHeight};` +
            ' further color glyphs will not render.',
        )
      }
      return (
        this.blank ?? { x: 0, y: 0, width: 0, height: 0, u0: 0, v0: 0, u1: 0, v1: 0, color: false }
      )
    }

    const x = this.colorX
    const y = this.colorY
    const src = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length)
    this.writeMirror(src, x, y, slotWidth)

    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, x, y, slotWidth, this.cellHeight, gl.RGBA, gl.UNSIGNED_BYTE, src,
    )

    const rect: GlyphRect = {
      x, y,
      width: slotWidth,
      height: this.cellHeight,
      u0: x / this.colorWidth,
      v0: y / this.colorHeight,
      u1: (x + slotWidth) / this.colorWidth,
      v1: (y + this.cellHeight) / this.colorHeight,
      color: true,
    }
    this.colorX += slotWidth
    return rect
  }

  /** Allocates the color atlas on first use. */
  private allocateColor() {
    const gl = this.gl
    this.colorWidth = COLOR_ATLAS_START
    this.colorHeight = COLOR_ATLAS_START
    this.colorMirror = new Uint8Array(this.colorWidth * this.colorHeight * 4)
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8, this.colorWidth, this.colorHeight, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, this.colorMirror,
    )
  }

  /** One glyph's rows into the mirror, which has a stride of its own. */
  private writeMirror(src: Uint8Array, x: number, y: number, slotWidth: number) {
    const mirror = this.colorMirror
    if (!mirror) return
    const rowBytes = slotWidth * 4
    for (let row = 0; row < this.cellHeight; row++) {
      mirror.set(
        src.subarray(row * rowBytes, (row + 1) * rowBytes),
        ((y + row) * this.colorWidth + x) * 4,
      )
    }
  }

  /** Doubles the companion, on its own schedule and against its own ceiling. */
  private growColor(): boolean {
    const gl = this.gl
    const size = this.colorWidth * 2
    const limit = Math.min(MAX_ATLAS_SIZE, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number)
    if (size > limit) return false

    const old = this.colorMirror
    const oldWidth = this.colorWidth
    const oldHeight = this.colorHeight
    const next = new Uint8Array(size * size * 4)
    if (old) {
      for (let row = 0; row < oldHeight; row++) {
        next.set(old.subarray(row * oldWidth * 4, (row + 1) * oldWidth * 4), row * size * 4)
      }
    }
    this.colorMirror = next
    this.colorWidth = size
    this.colorHeight = size

    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, next)

    // Rescale handed-out rects, as for the coverage atlas.
    this.rescale()
    return true
  }


  private warnedFull = false
  private warnedRunsFull = false
  private warnedColorFull = false

  dispose() {
    this.gl.deleteTexture(this.texture)
    this.gl.deleteTexture(this.colorTexture)
  }
}
