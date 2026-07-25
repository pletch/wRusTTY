// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
    measureText: vi.fn(
      (): { fontBoundingBoxAscent?: number; fontBoundingBoxDescent?: number } => ({
        fontBoundingBoxAscent: 12,
        fontBoundingBoxDescent: 4,
      }),
    ),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(255),
    })),
  }
}

function makeGlStub() {
  return {
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
    createTexture: vi.fn(() => ({}) as WebGLTexture),
    bindTexture: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    texSubImage2D: vi.fn(),
    pixelStorei: vi.fn(),
    deleteTexture: vi.fn(),
  } as unknown as WebGL2RenderingContext
}

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
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 8, 16)
    ctxStub.fillText.mockClear()
    const a = atlas.getGlyph(65) // 'A'
    const b = atlas.getGlyph(65)
    expect(a).toBe(b)
    expect(ctxStub.fillText).toHaveBeenCalledTimes(1)
  })

  it('the same codepoint under a different style rasterizes separately', () => {
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 8, 16)
    const plain = atlas.getGlyph(65, 0)
    const bold = atlas.getGlyph(65, GLYPH_BOLD)
    expect(plain).not.toBe(bold)
    expect(plain.x).not.toBe(bold.x)
  })

  it('bold and italic are independent style bits, not aliases of each other', () => {
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 8, 16)
    const bold = atlas.getGlyph(65, GLYPH_BOLD)
    const italic = atlas.getGlyph(65, GLYPH_ITALIC)
    const boldItalic = atlas.getGlyph(65, GLYPH_BOLD | GLYPH_ITALIC)
    const rects = [bold, italic, boldItalic]
    expect(new Set(rects.map((r) => `${r.x},${r.y}`)).size).toBe(3)
  })

  it('a grapheme cluster is cached separately from a single-codepoint glyph, keyed by its own text', () => {
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 8, 16)
    const single = atlas.getGlyph('A'.codePointAt(0)!)
    const cluster = atlas.getClusterGlyph('A')
    // Same visible text, but different cache maps — not required to collide,
    // and in this implementation they don't share slots at all.
    expect(single).not.toBe(cluster)

    const clusterHit = atlas.getClusterGlyph('A')
    expect(clusterHit).toBe(cluster)
  })

  it('different cluster strings under the same style get distinct slots', () => {
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 8, 16)
    const a = atlas.getClusterGlyph('é') // e + combining acute
    const b = atlas.getClusterGlyph('è') // e + combining grave
    expect(a).not.toBe(b)
    expect(a.x).not.toBe(b.x)
  })
})

describe('cell metrics for wide/CJK cells', () => {
  it('a normal glyph occupies exactly one cell width', () => {
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 8, 16)
    const rect = atlas.getGlyph(65)
    expect(rect.width).toBe(8)
    expect(rect.height).toBe(16)
  })

  it('a GLYPH_WIDE glyph (CJK / emoji) occupies a two-cell-wide slot', () => {
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 8, 16)
    const rect = atlas.getGlyph(0x4e2d /* 中 */, GLYPH_WIDE)
    expect(rect.width).toBe(16)
    expect(rect.height).toBe(16)
  })

  it('UV coordinates are normalized against the atlas dimensions', () => {
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 8, 16)
    const rect = atlas.getGlyph(65)
    expect(rect.u1 - rect.u0).toBeCloseTo(rect.width / 1024, 5)
    expect(rect.v1 - rect.v0).toBeCloseTo(rect.height / 1024, 5)
  })

  it('positions the baseline using measured font metrics, not a hardcoded offset', () => {
    ctxStub.measureText = vi.fn(() => ({ fontBoundingBoxAscent: 20, fontBoundingBoxDescent: 10 }))
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 8, 40)
    ctxStub.fillText.mockClear()
    atlas.getGlyph(65)
    // baseline = clamp(0, cellHeight, round((cellHeight - (ascent+descent))/2 + ascent))
    //          = round((40 - 30)/2 + 20) = round(5 + 20) = 25
    const [, , y] = ctxStub.fillText.mock.calls[0]
    expect(y).toBe(25)
  })

  it('falls back to a fraction of font size when fontBoundingBox metrics are unavailable', () => {
    ctxStub.measureText = vi.fn(() => ({}))
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 20, 8, 40)
    ctxStub.fillText.mockClear()
    atlas.getGlyph(65)
    // ascent = 20*0.8=16, descent = 20*0.2=4 -> baseline = round((40-20)/2+16) = round(10+16) = 26
    const [, , y] = ctxStub.fillText.mock.calls[0]
    expect(y).toBe(26)
  })
})

describe('underline / strikethrough / cursor outline', () => {
  it('draws an extra rect for GLYPH_UNDERLINE beyond the glyph itself', () => {
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 8, 16)
    ctxStub.fillRect.mockClear()
    atlas.getGlyph(65, GLYPH_UNDERLINE)
    expect(ctxStub.fillRect).toHaveBeenCalledTimes(1)
  })

  it('draws an extra rect for GLYPH_STRIKETHROUGH beyond the glyph itself', () => {
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 8, 16)
    ctxStub.fillRect.mockClear()
    atlas.getGlyph(65, GLYPH_STRIKETHROUGH)
    expect(ctxStub.fillRect).toHaveBeenCalledTimes(1)
  })

  it('draws neither extra rect for a plain glyph', () => {
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 8, 16)
    ctxStub.fillRect.mockClear()
    atlas.getGlyph(65)
    expect(ctxStub.fillRect).not.toHaveBeenCalled()
  })

  it('draws the cursor outline as four edge rects and never calls fillText for it', () => {
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 8, 16)
    ctxStub.fillRect.mockClear()
    ctxStub.fillText.mockClear()
    // GLYPH_CURSOR_OUTLINE isn't exported; re-derive its codepoint the same
    // way the module does (a permanently-unassigned Unicode noncharacter).
    atlas.getGlyph(0xfdd0)
    expect(ctxStub.fillText).not.toHaveBeenCalled()
    expect(ctxStub.fillRect).toHaveBeenCalledTimes(4)
  })
})

describe('atlas exhaustion', () => {
  it('falls back to the blank glyph once the atlas has no room left, warning only once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // atlasWidth/atlasHeight are fixed at 1024x1024. A 512x512 cell leaves
    // exactly 4 slots: the constructor's own forced blank-glyph rasterization
    // (space) consumes the first, so 3 more distinct codepoints fit before
    // a 4th is turned away.
    const atlas = new GlyphAtlas(makeGlStub(), 'monospace', 14, 512, 512)
    const first = atlas.getGlyph(65)
    const second = atlas.getGlyph(66)
    const third = atlas.getGlyph(67)
    expect([first, second, third].every((r) => r.width === 512)).toBe(true)

    // The blank glyph (space, rasterized once in the constructor before the
    // atlas held anything else) is what every subsequent overflow falls
    // back to — same rect, not a fresh zero-sized one, and only one warning
    // no matter how many more glyphs are turned away after the first.
    const blank = atlas.getGlyph(32)
    const overflow1 = atlas.getGlyph(68)
    const overflow2 = atlas.getGlyph(69)
    expect(overflow1).toEqual(blank)
    expect(overflow2).toEqual(blank)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('dispose', () => {
  it('deletes the underlying GL texture', () => {
    const gl = makeGlStub()
    const atlas = new GlyphAtlas(gl, 'monospace', 14, 8, 16)
    atlas.dispose()
    expect(gl.deleteTexture).toHaveBeenCalledWith(atlas.texture)
  })
})
