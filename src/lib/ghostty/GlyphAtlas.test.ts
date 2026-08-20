// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { plainSelection } from '../fontStack'
import {
  GlyphAtlas,
  GLYPH_BOLD,
  GLYPH_ITALIC,
  GLYPH_UNDERLINE,
  GLYPH_STRIKETHROUGH,
  GLYPH_WIDE,
} from './GlyphAtlas'

// GlyphAtlas needs a real canvas 2D context (for measureText/fillText) and a
// real WebGL2 context (for the texture it uploads into) — neither exists in
// jsdom. Both are stubbed with just the surface GlyphAtlas actually calls;
// per the plan, "the atlas only needs measureText and fillText to exist."
function make2dContextStub() {
  return {
    fillStyle: '',
    font: '',
    textBaseline: '',
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    // The path calls boxDrawing sets up around its geometry. No-ops: what
    // these tests read is the rects, and fillRect is already bounded by the
    // slot the caller passed in.
    beginPath: vi.fn(),
    closePath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    ellipse: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    measureText: vi.fn(
      (): { fontBoundingBoxAscent?: number; fontBoundingBoxDescent?: number } => ({
        fontBoundingBoxAscent: 12,
        fontBoundingBoxDescent: 4,
      }),
    ),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(255),
    })),
    drawImage: vi.fn(),
  }
}

function makeGlStub(maxTextureSize = 4096) {
  return {
    MAX_TEXTURE_SIZE: 0x0d33,
    getParameter: vi.fn((p: number) => (p === 0x0d33 ? maxTextureSize : 0)),
    TEXTURE_2D: 1,
    R8: 2,
    RED: 3,
    UNSIGNED_BYTE: 4,
    TEXTURE_MIN_FILTER: 5,
    TEXTURE_MAG_FILTER: 6,
    NEAREST: 7,
    TEXTURE_WRAP_S: 8,
    TEXTURE_WRAP_T: 9,
    CLAMP_TO_EDGE: 10,
    UNPACK_ALIGNMENT: 11,
    RGBA: 12,
    RGBA8: 13,
    createTexture: vi.fn(() => ({}) as WebGLTexture),
    bindTexture: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    texSubImage2D: vi.fn(),
    pixelStorei: vi.fn(),
    deleteTexture: vi.fn(),
  } as unknown as WebGL2RenderingContext
}

/** One family for every style and no pinned ranges — the shape the atlas had
 *  before per-style faces existed, which is what these tests are about. */
const FONTS = plainSelection('monospace')

let ctxStub: ReturnType<typeof make2dContextStub>

beforeEach(() => {
  ctxStub = make2dContextStub()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((id: string) =>
    id === '2d' ? ctxStub : null) as typeof HTMLCanvasElement.prototype.getContext)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cache keys', () => {
  it('a repeated getGlyph call for the same codepoint+style is a cache hit', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    ctxStub.fillText.mockClear()
    const a = atlas.getGlyph(65) // 'A'
    const b = atlas.getGlyph(65)
    expect(a).toBe(b)
    expect(ctxStub.fillText).toHaveBeenCalledTimes(1)
  })

  it('the same codepoint under a different style rasterizes separately', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    const plain = atlas.getGlyph(65, 0)
    const bold = atlas.getGlyph(65, GLYPH_BOLD)
    expect(plain).not.toBe(bold)
    expect(plain.x).not.toBe(bold.x)
  })

  it('bold and italic are independent style bits, not aliases of each other', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    const bold = atlas.getGlyph(65, GLYPH_BOLD)
    const italic = atlas.getGlyph(65, GLYPH_ITALIC)
    const boldItalic = atlas.getGlyph(65, GLYPH_BOLD | GLYPH_ITALIC)
    const rects = [bold, italic, boldItalic]
    expect(new Set(rects.map((r) => `${r.x},${r.y}`)).size).toBe(3)
  })

  it('a grapheme cluster is cached separately from a single-codepoint glyph, keyed by its own text', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    const single = atlas.getGlyph('A'.codePointAt(0)!)
    const cluster = atlas.getClusterGlyph('A')
    // Same visible text, but different cache maps — not required to collide,
    // and in this implementation they don't share slots at all.
    expect(single).not.toBe(cluster)

    const clusterHit = atlas.getClusterGlyph('A')
    expect(clusterHit).toBe(cluster)
  })

  it('different cluster strings under the same style get distinct slots', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    const a = atlas.getClusterGlyph('é') // e + combining acute
    const b = atlas.getClusterGlyph('è') // e + combining grave
    expect(a).not.toBe(b)
    expect(a.x).not.toBe(b.x)
  })
})

describe('cell metrics for wide/CJK cells', () => {
  it('a normal glyph occupies exactly one cell width', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    const rect = atlas.getGlyph(65)
    expect(rect.width).toBe(8)
    expect(rect.height).toBe(16)
  })

  it('a GLYPH_WIDE glyph (CJK / emoji) occupies a two-cell-wide slot', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    const rect = atlas.getGlyph(0x4e2d /* 中 */, GLYPH_WIDE)
    expect(rect.width).toBe(16)
    expect(rect.height).toBe(16)
  })

  it('UV coordinates are normalized against the atlas dimensions', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    const rect = atlas.getGlyph(65)
    expect(rect.u1 - rect.u0).toBeCloseTo(rect.width / 1024, 5)
    expect(rect.v1 - rect.v0).toBeCloseTo(rect.height / 1024, 5)
  })

  it('positions the baseline using measured font metrics, not a hardcoded offset', () => {
    ctxStub.measureText = vi.fn(() => ({ fontBoundingBoxAscent: 20, fontBoundingBoxDescent: 10 }))
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 40)
    ctxStub.fillText.mockClear()
    atlas.getGlyph(65)
    // baseline = clamp(0, cellHeight, round((cellHeight - (ascent+descent))/2 + ascent))
    //          = round((40 - 30)/2 + 20) = round(5 + 20) = 25
    const [, , y] = ctxStub.fillText.mock.calls[0]
    expect(y).toBe(25)
  })

  it('falls back to a fraction of font size when fontBoundingBox metrics are unavailable', () => {
    ctxStub.measureText = vi.fn(() => ({}))
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 20, 8, 40)
    ctxStub.fillText.mockClear()
    atlas.getGlyph(65)
    // ascent = 20*0.8=16, descent = 20*0.2=4 -> baseline = round((40-20)/2+16) = round(10+16) = 26
    const [, , y] = ctxStub.fillText.mock.calls[0]
    expect(y).toBe(26)
  })
})

describe('underline / strikethrough / cursor outline', () => {
  it('draws an extra rect for GLYPH_UNDERLINE beyond the glyph itself', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    ctxStub.fillRect.mockClear()
    atlas.getGlyph(65, GLYPH_UNDERLINE)
    expect(ctxStub.fillRect).toHaveBeenCalledTimes(1)
  })

  it('draws an extra rect for GLYPH_STRIKETHROUGH beyond the glyph itself', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    ctxStub.fillRect.mockClear()
    atlas.getGlyph(65, GLYPH_STRIKETHROUGH)
    expect(ctxStub.fillRect).toHaveBeenCalledTimes(1)
  })

  it('draws neither extra rect for a plain glyph', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    ctxStub.fillRect.mockClear()
    atlas.getGlyph(65)
    expect(ctxStub.fillRect).not.toHaveBeenCalled()
  })

  it('draws the cursor outline as four edge rects and never calls fillText for it', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    ctxStub.fillRect.mockClear()
    ctxStub.fillText.mockClear()
    // GLYPH_CURSOR_OUTLINE isn't exported; re-derive its codepoint the same
    // way the module does (a permanently-unassigned Unicode noncharacter).
    atlas.getGlyph(0xfdd0)
    expect(ctxStub.fillText).not.toHaveBeenCalled()
    expect(ctxStub.fillRect).toHaveBeenCalledTimes(4)
  })
})

describe('atlas growth', () => {
  /** 512x512 cells leave exactly 4 slots at 1024, so the atlas runs out after
   *  the constructor's own blank plus three glyphs — which makes the growth
   *  boundary reachable in a handful of calls instead of thousands. */
  const HUGE = 512

  it('doubles rather than turning a glyph away', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, HUGE, HUGE)
    // Slot 0 is the constructor's blank; 65..67 fill 1024x1024 exactly.
    for (const cp of [65, 66, 67]) expect(atlas.getGlyph(cp).width).toBe(HUGE)
    // The fourth would have been blank before; now it gets a real slot.
    const grown = atlas.getGlyph(68)
    expect(grown.width).toBe(HUGE)
    expect(grown).not.toEqual(atlas.getGlyph(32))
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps a rect handed out before the growth pointing at the same pixels', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, HUGE, HUGE)
    const early = atlas.getGlyph(65)
    const beforeX = early.x
    const beforeU0 = early.u0
    for (const cp of [66, 67, 68, 69]) atlas.getGlyph(cp)

    // Same object — the renderer holds rects across cells within a frame, and
    // growth can happen in the middle of one.
    expect(atlas.getGlyph(65)).toBe(early)
    // Same pixels, renormalized: x is untouched and u0 has halved, because the
    // atlas it is a fraction of is twice as wide.
    expect(early.x).toBe(beforeX)
    expect(early.u0).toBeCloseTo(beforeU0 / 2, 10)
    expect(early.u1 - early.u0).toBeCloseTo(HUGE / 2048, 10)
  })

  it('renormalizes cluster and run rects too, not only single codepoints', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, HUGE, HUGE)
    const cluster = atlas.getClusterGlyph('é')
    const before = cluster.u0
    for (const cp of [66, 67, 68, 69]) atlas.getGlyph(cp)
    expect(cluster.u0).toBeCloseTo(before / 2, 10)
    expect(cluster.u1).toBeCloseTo((cluster.x + cluster.width) / 2048, 10)
  })

  it('stops at the largest texture the GL implementation offers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A driver that will not go past the starting size: growth is refused on
    // the first attempt and the old warn-and-blank is what is left.
    const atlas = new GlyphAtlas(makeGlStub(1024), FONTS, 14, HUGE, HUGE)
    for (const cp of [65, 66, 67]) atlas.getGlyph(cp)
    const blank = atlas.getGlyph(32)
    expect(atlas.getGlyph(68)).toEqual(blank)
    expect(atlas.getGlyph(69)).toEqual(blank)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('1024x1024')
  })

  it('grows repeatedly, and gives up only at the ceiling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, HUGE, HUGE)
    // 4096 is the ceiling, so 8x8 slots is everything this atlas can ever
    // hold. Ask for more than that and the last few are turned away.
    const rects = []
    for (let i = 0; i < 80; i++) rects.push(atlas.getGlyph(0x4e00 + i))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('4096x4096')
    // 44, not the 64 a 4096x4096 atlas would hold if it were packed from
    // scratch: 4 slots at 1024, then 8 more in the rows a 2048 atlas adds,
    // then 32 in the rows 4096 adds. The right-hand half of every row packed
    // before a growth is never revisited, which is the price of never having
    // to relocate a rect that has already been handed out.
    const distinct = new Set(rects.map((r) => `${r.x},${r.y}`))
    expect(distinct.size).toBe(44)
  })
})

describe('weight', () => {
  /** The selection with the two weights set; everything else as it was. */
  const weighted = (weight: number, boldWeight: number) => ({
    ...FONTS,
    weight,
    boldWeight,
  })

  it('emits nothing for ordinary text at the CSS default, exactly as before', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    atlas.getGlyph(65)
    expect(ctxStub.font).toBe('14px monospace')
  })

  it('emits the number for a body weight that is not 400', () => {
    const atlas = new GlyphAtlas(makeGlStub(), weighted(300, 700), 14, 8, 16)
    atlas.getGlyph(65)
    expect(ctxStub.font).toBe('300 14px monospace')
  })

  it('emits the bold weight for bold cells, not the keyword', () => {
    // 700 and `bold` are the same computed weight; a number is the spelling
    // that can also say 600, which is the point of the setting.
    const atlas = new GlyphAtlas(makeGlStub(), weighted(300, 600), 14, 8, 16)
    atlas.getGlyph(65, GLYPH_BOLD)
    expect(ctxStub.font).toBe('600 14px monospace')
  })

  it('keeps the slant alongside the weight', () => {
    const atlas = new GlyphAtlas(makeGlStub(), weighted(400, 800), 14, 8, 16)
    atlas.getGlyph(65, GLYPH_BOLD | GLYPH_ITALIC)
    expect(ctxStub.font).toBe('italic 800 14px monospace')
  })

  it('asks a named bold face for no weight at all, whatever the setting says', () => {
    // The face is the weight. Emitting one as well is what gets a Black cut
    // synthesized on top of a face that was already bold.
    const atlas = new GlyphAtlas(
      makeGlStub(),
      { ...weighted(400, 900), bold: 'Iosevka Bold', boldIsFace: true },
      14,
      8,
      16,
    )
    atlas.getGlyph(65, GLYPH_BOLD)
    expect(ctxStub.font).toBe('14px Iosevka Bold')
  })
})

describe('letter spacing', () => {
  it('draws the glyph centred in the widened cell rather than against its edge', () => {
    // Cell 12 wide, 4 of which is spacing: 2 either side of the slot the
    // glyph was given, which is not the origin — slot 0 is the blank.
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 12, 16, 4)
    ctxStub.fillText.mockClear()
    const rect = atlas.getGlyph(65)
    expect(ctxStub.fillText).toHaveBeenCalledWith('A', rect.x + 2, expect.any(Number))
  })

  it('leaves the glyph at the slot edge when nothing was added', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    ctxStub.fillText.mockClear()
    const rect = atlas.getGlyph(65)
    expect(ctxStub.fillText).toHaveBeenCalledWith('A', rect.x, expect.any(Number))
  })

  it('measures a glyph against the face\'s share of the cell, not the added space', () => {
    // Ink of 10 in a 12-wide cell whose spacing is 4: the face has 8 to draw
    // in, so this overruns and is condensed to 8 — a glyph must not be
    // stretched into the gap that widening the cell just created.
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 12, 16, 4)
    ctxStub.measureText = vi.fn(() => ({
      width: 10,
      fontBoundingBoxAscent: 11,
      fontBoundingBoxDescent: 3,
    })) as unknown as typeof ctxStub.measureText
    ctxStub.scale.mockClear()
    atlas.getGlyph(0x4e00)
    expect(ctxStub.scale).toHaveBeenCalledWith(8 / 10, 1)
  })

  it('still draws the box characters across the whole cell, so they tile', () => {
    // Geometry against the cell rect, spacing included: a border that inset
    // itself would leave a hairline gap down every column.
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 12, 16, 4)
    ctxStub.fillRect.mockClear()
    const rect = atlas.getGlyph(0x2500)
    // A rule is drawn as two arms from the centre, so what matters is where
    // the pair starts and ends rather than how wide either one is.
    const lefts = ctxStub.fillRect.mock.calls.map((c) => c[0] as number)
    const rights = ctxStub.fillRect.mock.calls.map((c) => (c[0] as number) + (c[2] as number))
    expect(Math.min(...lefts)).toBe(rect.x)
    expect(Math.max(...rights)).toBe(rect.x + 12)
  })
})

/** The width of every RGBA texture allocation made on this context, in order
 *  — which is the companion's whole size history. */
function rgbaAllocations(gl: WebGL2RenderingContext): number[] {
  const calls = (gl.texImage2D as unknown as { mock: { calls: unknown[][] } }).mock.calls
  return calls.filter((c) => c[2] === 13).map((c) => c[3] as number)
}

describe('colour glyphs', () => {
  /**
   * A readback where the glyph's pixels carry the face's own colours rather
   * than the white everything here is drawn in — which is what a COLR or CBDT
   * emoji produces, and the only signal the atlas uses to tell one apart.
   */
  function paintingInColor() {
    ctxStub.getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < w * h; i++) {
        data[i * 4] = 240
        data[i * 4 + 1] = 128
        data[i * 4 + 2] = 40
        data[i * 4 + 3] = 255
      }
      return { data }
    }) as unknown as typeof ctxStub.getImageData
  }

  it('leaves an ordinary glyph on the coverage atlas', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    expect(atlas.getGlyph(65).color).toBe(false)
  })

  it('marks a glyph the face painted in its own colours', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    paintingInColor()
    expect(atlas.getGlyph(0x1f600, GLYPH_WIDE).color).toBe(true)
  })

  it('costs nothing until one appears — the companion stays 1x1', () => {
    const gl = makeGlStub()
    const atlas = new GlyphAtlas(gl, FONTS, 14, 8, 16)
    atlas.getGlyph(65)
    // The only RGBA allocation is the 1x1 placeholder the sampler needs.
    expect(rgbaAllocations(gl)).toEqual([1])
  })

  it('gives the companion a quarter of the coverage atlas, not a copy of it', () => {
    // Four bytes a texel against one, for a handful of glyphs against
    // thousands: the companion is the expensive one per slot and starts small.
    const gl = makeGlStub()
    const atlas = new GlyphAtlas(gl, FONTS, 14, 8, 16)
    paintingInColor()
    atlas.getGlyph(0x1f600, GLYPH_WIDE)
    expect(rgbaAllocations(gl)).toEqual([1, 512])
  })

  it('packs colour out of a cursor of its own, spending no coverage slot', () => {
    // The trial draw happens on the coverage canvas because that is what the
    // detection reads back, but the slot is handed back: the next ordinary
    // glyph takes it.
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    const before = atlas.getGlyph(65)
    paintingInColor()
    const emoji = atlas.getGlyph(0x1f600)
    ctxStub.getImageData = make2dContextStub().getImageData
    const after = atlas.getGlyph(66)
    expect(after.x).toBe(before.x + before.width)
    expect(after.color).toBe(false)
    // And the emoji is at the start of its own space, not after the 'A'.
    expect(emoji.x).toBe(0)
    expect(emoji.color).toBe(true)
  })

  it('normalizes a colour rect against the companion, not the coverage atlas', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    paintingInColor()
    const emoji = atlas.getGlyph(0x1f600)
    // 8 wide in a 512 companion, not in the 1024 coverage atlas.
    expect(emoji.u1 - emoji.u0).toBeCloseTo(8 / 512, 6)
  })

  it('leaves the companion alone when the coverage atlas grows', () => {
    // The case the separate packing exists for: a pane full of CJK must not
    // drag a 64MB companion along behind it to hold three emoji.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A cell big enough that four of them fill the coverage atlas.
    const BIG = 512
    const gl = makeGlStub()
    const atlas = new GlyphAtlas(gl, FONTS, 14, BIG, BIG)
    paintingInColor()
    const emoji = atlas.getGlyph(0x1f600)
    ctxStub.getImageData = make2dContextStub().getImageData
    // Fill the coverage atlas until it doubles.
    for (const cp of [65, 66, 67, 68]) atlas.getGlyph(cp)
    expect(rgbaAllocations(gl)).toEqual([1, 512])
    // The colour rect's UVs are untouched by a growth that was not its own.
    expect(emoji.u1 - emoji.u0).toBeCloseTo(BIG / 512, 6)
    warn.mockRestore()
  })

  it('doubles the companion on its own when colour glyphs fill it', () => {
    const gl = makeGlStub()
    // A cell a quarter of the starting companion: four rows of one slot each.
    const atlas = new GlyphAtlas(gl, FONTS, 14, 512, 128)
    paintingInColor()
    for (let i = 0; i < 5; i++) atlas.getGlyph(0x1f600 + i)
    expect(rgbaAllocations(gl)).toEqual([1, 512, 1024])
  })

  it('caches it like any other glyph rather than re-reading it every frame', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    paintingInColor()
    const a = atlas.getGlyph(0x1f600)
    const b = atlas.getGlyph(0x1f600)
    expect(a).toBe(b)
    expect(a.color).toBe(true)
  })
})

describe('dispose', () => {
  it('deletes the underlying GL texture', () => {
    const gl = makeGlStub()
    const atlas = new GlyphAtlas(gl, FONTS, 14, 8, 16)
    atlas.dispose()
    expect(gl.deleteTexture).toHaveBeenCalledWith(atlas.texture)
  })

  it('deletes the colour companion too, which is a second allocation', () => {
    const gl = makeGlStub()
    const atlas = new GlyphAtlas(gl, FONTS, 14, 8, 16)
    atlas.dispose()
    expect(gl.deleteTexture).toHaveBeenCalledWith(atlas.colorTexture)
  })
})

describe('glyphs wider than their slot', () => {
  /** The stub's default `measureText` reports no `width` at all, which is what
   *  keeps every other test on the plain `fillText` path. This one reports a
   *  real one, plus the metrics the constructor reads. */
  function measuringAt(width: number) {
    return vi.fn(() => ({ width, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 4 }))
  }

  it('condenses horizontally when the face draws past the cell it was measured for', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    ctxStub.measureText = measuringAt(20)
    ctxStub.fillText.mockClear()
    atlas.getGlyph(0x4e00) // a CJK ideograph reaching the single-cell path

    // Drawn at the origin the transform establishes, not at the slot's own
    // coordinates — that is what distinguishes the condensed path.
    expect(ctxStub.fillText).toHaveBeenCalledWith(expect.any(String), 0, 0)
    expect(ctxStub.scale).toHaveBeenCalledWith(8 / 20, 1)
    expect(ctxStub.save).toHaveBeenCalled()
    expect(ctxStub.restore).toHaveBeenCalled()
  })

  it('scales against the two-cell slot for a wide glyph, not the single cell', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    ctxStub.measureText = measuringAt(20)
    atlas.getGlyph(0x4e00, GLYPH_WIDE)
    expect(ctxStub.scale).toHaveBeenCalledWith(16 / 20, 1)
  })

  it('leaves a glyph that fits on the untransformed path', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    ctxStub.measureText = measuringAt(7)
    ctxStub.fillText.mockClear()
    ctxStub.scale.mockClear()
    atlas.getGlyph(65)
    expect(ctxStub.scale).not.toHaveBeenCalled()
    expect(ctxStub.fillText).toHaveBeenCalledTimes(1)
    // The slot's own x: the constructor already took slot 0 for the blank.
    expect(ctxStub.fillText.mock.calls[0][1]).toBe(8)
  })
})

describe('shaped runs', () => {
  function measuringAt(width: number) {
    return vi.fn(() => ({ width, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 4 }))
  }

  it('takes a slot as many cells wide as the run', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    const rect = atlas.getRunGlyph('===', 0, 3)!
    expect(rect.width).toBe(24)
  })

  it('is a cache hit on the same run, and a miss on a different style', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    ctxStub.fillText.mockClear()
    const a = atlas.getRunGlyph('=>', 0, 2)
    const b = atlas.getRunGlyph('=>', 0, 2)
    expect(a).toBe(b)
    expect(ctxStub.fillText).toHaveBeenCalledTimes(1)
    expect(atlas.getRunGlyph('=>', GLYPH_BOLD, 2)).not.toBe(a)
  })

  it('fits the run to its slot in both directions, not only when it overruns', () => {
    // A monospace advance rounds to the cell independently per column, so over
    // three columns the font's own ink can come up short of the slot as easily
    // as over it; either way the slices have to land on the cells.
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 8, 16)
    ctxStub.measureText = measuringAt(20)
    atlas.getRunGlyph('===', 0, 3)
    expect(ctxStub.scale).toHaveBeenCalledWith(24 / 20, 1)
  })

  it('declines once the run cache is full rather than crowding out the atlas', () => {
    const atlas = new GlyphAtlas(makeGlStub(), FONTS, 14, 1, 1)
    // Distinct two-cell runs, more than the cap allows.
    let refused = 0
    for (let i = 0; i < 600; i++) {
      const text = String.fromCharCode(0x21 + (i % 90), 0x21 + ((i / 90) | 0))
      if (atlas.getRunGlyph(text, 0, 2) === null) refused++
    }
    expect(refused).toBeGreaterThan(0)
  })
})
