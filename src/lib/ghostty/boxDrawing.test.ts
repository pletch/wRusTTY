import { describe, it, expect } from 'vitest'
import { isBoxGlyph, drawBoxGlyph } from './boxDrawing'

/**
 * A pixel grid that honours the two operations the rect-based characters use —
 * `fillRect` and `fillRect` under `destination-out` — so the assertions below
 * can be about geometry (does this arm reach the cell edge, do these two cells
 * tile without a seam) rather than about which calls were made.
 *
 * Stroked shapes (the arcs, the diagonals, the Powerline separators) are not
 * modelled; those are only checked for being handled at all.
 */
function makeGrid(w: number, h: number) {
  const px = new Uint8Array(w * h)
  const ctx = {
    fillStyle: 'white',
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over' as string,
    fillRect(x: number, y: number, rw: number, rh: number) {
      const erase = ctx.globalCompositeOperation === 'destination-out'
      const value = erase ? 0 : Math.round(ctx.globalAlpha * 255)
      for (let yy = Math.max(0, Math.round(y)); yy < Math.min(h, Math.round(y + rh)); yy++) {
        for (let xx = Math.max(0, Math.round(x)); xx < Math.min(w, Math.round(x + rw)); xx++) {
          px[yy * w + xx] = value
        }
      }
    },
    // Path state the module sets up; none of it affects the grid, and the
    // clip is redundant here because fillRect is already bounded above.
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    rect() {},
    clip() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    ellipse() {},
    stroke() {},
    fill() {},
  }
  const at = (x: number, y: number) => px[y * w + x]
  const rowFilled = (y: number) => {
    for (let x = 0; x < w; x++) if (px[y * w + x] === 0) return false
    return true
  }
  const colFilled = (x: number) => {
    for (let y = 0; y < h; y++) if (px[y * w + x] === 0) return false
    return true
  }
  const anyInRow = (y: number) => {
    for (let x = 0; x < w; x++) if (px[y * w + x] !== 0) return true
    return false
  }
  const count = () => px.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0)
  return { ctx: ctx as unknown as CanvasRenderingContext2D, at, rowFilled, colFilled, anyInRow, count }
}

const W = 10
const H = 20
const LIGHT = 1

function draw(cp: number, w = W, h = H, light = LIGHT) {
  const g = makeGrid(w, h)
  const handled = drawBoxGlyph(g.ctx, cp, 0, 0, w, h, light)
  return { ...g, handled }
}

describe('isBoxGlyph', () => {
  it('claims the box-drawing, block-element and Powerline ranges and nothing else', () => {
    expect(isBoxGlyph(0x2500)).toBe(true)
    expect(isBoxGlyph(0x259f)).toBe(true)
    expect(isBoxGlyph(0xe0b0)).toBe(true)
    expect(isBoxGlyph(0xe0b7)).toBe(true)
    expect(isBoxGlyph(0x24ff)).toBe(false)
    expect(isBoxGlyph(0x25a0)).toBe(false)
    expect(isBoxGlyph(0xe0b8)).toBe(false)
    expect(isBoxGlyph(0x41)).toBe(false)
  })

  it('every codepoint it claims is one drawBoxGlyph actually draws', () => {
    const claimed: number[] = []
    for (let cp = 0x24f0; cp <= 0x25b0; cp++) if (isBoxGlyph(cp)) claimed.push(cp)
    for (let cp = 0xe0a0; cp <= 0xe0c0; cp++) if (isBoxGlyph(cp)) claimed.push(cp)
    const unhandled = claimed.filter((cp) => !draw(cp).handled)
    expect(unhandled).toEqual([])
  })

  it('declines a codepoint outside those ranges rather than drawing a blank', () => {
    expect(draw(0x41).handled).toBe(false)
    expect(draw(0x41).count()).toBe(0)
  })
})

describe('arms reach the cell edges', () => {
  it('a light horizontal spans the full width, so two side by side have no seam', () => {
    const g = draw(0x2500)
    const mid = Math.round(H / 2 - LIGHT / 2)
    expect(g.rowFilled(mid)).toBe(true)
  })

  it('a light vertical spans the full height, so two stacked have no seam', () => {
    const g = draw(0x2502)
    const mid = Math.round(W / 2 - LIGHT / 2)
    expect(g.colFilled(mid)).toBe(true)
  })

  it('a heavy rule is thicker than a light one on the same axis', () => {
    expect(draw(0x2501).count()).toBeGreaterThan(draw(0x2500).count())
    expect(draw(0x2503).count()).toBeGreaterThan(draw(0x2502).count())
  })

  it('a corner joins its two arms with no hole at the centre', () => {
    // U+250C: down and right. Every pixel from the centre to the right edge on
    // the centre row, and from the centre to the bottom on the centre column.
    const g = draw(0x250c)
    const cy = Math.round(H / 2 - LIGHT / 2)
    const cx = Math.round(W / 2 - LIGHT / 2)
    for (let x = cx; x < W; x++) expect(g.at(x, cy)).not.toBe(0)
    for (let y = cy; y < H; y++) expect(g.at(cx, y)).not.toBe(0)
    // ...and nothing above or to the left of it.
    expect(g.at(cx - 1, cy)).toBe(0)
    expect(g.at(cx, cy - 1)).toBe(0)
  })

  it('a cross fills both axes end to end', () => {
    const g = draw(0x253c)
    expect(g.rowFilled(Math.round(H / 2 - LIGHT / 2))).toBe(true)
    expect(g.colFilled(Math.round(W / 2 - LIGHT / 2))).toBe(true)
  })

  it('a light arm crossing a heavy one is not nicked by it', () => {
    // U+2542: heavy vertical, light horizontal arms on both sides.
    const g = draw(0x2542, W, H, 2)
    expect(g.rowFilled(Math.round(H / 2 - 1))).toBe(true)
  })

  it('a stub starts at the centre, not short of it', () => {
    // U+2576 draws rightwards only; U+2574 leftwards. Together they should
    // cover the same row a full U+2500 does.
    const right = draw(0x2576)
    const left = draw(0x2574)
    const cy = Math.round(H / 2 - LIGHT / 2)
    for (let x = 0; x < W; x++) {
      expect(right.at(x, cy) !== 0 || left.at(x, cy) !== 0).toBe(true)
    }
  })
})

describe('double lines', () => {
  it('a double horizontal is two rules with a gap between them', () => {
    const g = draw(0x2550, W, H, 1)
    const rows: boolean[] = []
    for (let y = 0; y < H; y++) rows.push(g.anyInRow(y))
    const filled = rows.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)
    expect(filled).toHaveLength(2)
    expect(filled[1] - filled[0]).toBe(2) // one rule of gap between them
  })

  it('a double cross leaves the middle open — four corners, not a plus', () => {
    const g = draw(0x256c, W, H, 1)
    const cx = Math.round(W / 2)
    const cy = Math.round(H / 2)
    expect(g.at(cx, cy)).toBe(0)
    // Each of the four rules still reaches its own edge.
    expect(g.at(0, cy - 1) !== 0 || g.at(0, cy - 2) !== 0).toBe(true)
    expect(g.at(W - 1, cy + 1) !== 0 || g.at(W - 1, cy) !== 0).toBe(true)
  })

  it('a double tee keeps one rule continuous through the junction', () => {
    // U+2560: double up, right and down. The left-hand vertical rule runs the
    // whole height; the right-hand one is broken by the two horizontals.
    const g = draw(0x2560, W, H, 1)
    let continuous = 0
    for (let x = 0; x < W; x++) if (g.colFilled(x)) continuous++
    expect(continuous).toBe(1)
  })

  it('a double corner has no rule reaching the edges its arms do not point at', () => {
    // U+2554: right and down. Nothing on the top or left edge.
    const g = draw(0x2554, W, H, 1)
    for (let x = 0; x < W; x++) expect(g.at(x, 0)).toBe(0)
    for (let y = 0; y < H; y++) expect(g.at(0, y)).toBe(0)
    // Both rules of the pair do reach the right edge: y - 1 and y + 1 either
    // side of the open gap at the centre.
    expect(g.at(W - 1, Math.round(H / 2) - 1)).not.toBe(0)
    expect(g.at(W - 1, Math.round(H / 2) + 1)).not.toBe(0)
  })

  it('a single stem meeting a double pair stops at the pair rather than filling its gap', () => {
    // U+2564: double horizontal, single stem hanging below it.
    const g = draw(0x2564, W, H, 1)
    const cy = Math.round(H / 2)
    expect(g.at(Math.round(W / 2 - 0.5), cy)).toBe(0) // the gap stays open
    expect(g.at(Math.round(W / 2 - 0.5), H - 1)).not.toBe(0) // the stem reaches the bottom
  })

  it('a single line crossing a double pair runs the whole way through', () => {
    // U+256A: double horizontal, single vertical through both rules.
    const g = draw(0x256a, W, H, 1)
    expect(g.colFilled(Math.round(W / 2 - 0.5))).toBe(true)
  })
})

describe('block elements', () => {
  it('the full block covers every pixel of the cell', () => {
    expect(draw(0x2588).count()).toBe(W * H)
  })

  it('upper and lower halves tile exactly, with no seam and no overlap', () => {
    const upper = draw(0x2580)
    const lower = draw(0x2584)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = upper.at(x, y) !== 0
        const b = lower.at(x, y) !== 0
        expect(a !== b).toBe(true)
      }
    }
  })

  it('the eighths grow monotonically from one eighth to the full block', () => {
    let last = 0
    for (let cp = 0x2581; cp <= 0x2588; cp++) {
      const n = draw(cp).count()
      expect(n).toBeGreaterThan(last)
      last = n
    }
  })

  it('the left eighths grow the other way, U+258F being the thinnest', () => {
    expect(draw(0x258f).count()).toBeLessThan(draw(0x2589).count())
  })

  it('the three shades are partial coverage, not solid', () => {
    for (const cp of [0x2591, 0x2592, 0x2593]) {
      const g = draw(cp)
      expect(g.at(0, 0)).toBeGreaterThan(0)
      expect(g.at(0, 0)).toBeLessThan(255)
    }
    expect(draw(0x2591).at(0, 0)).toBeLessThan(draw(0x2593).at(0, 0))
  })

  it('the four quadrants together cover the cell exactly once', () => {
    const cover = new Uint8Array(W * H)
    for (const cp of [0x2598, 0x259d, 0x2596, 0x2597]) {
      const g = draw(cp)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g.at(x, y)) cover[y * W + x]++
    }
    expect([...cover].every((v) => v === 1)).toBe(true)
  })
})

describe('tiling across cells', () => {
  it('a vertical rule lands on the same column whatever the row', () => {
    // The atlas rasterizes every glyph at (0, 0) of its own slot, so this is
    // really a statement that the geometry depends only on the cell size.
    const a = draw(0x2502)
    const b = draw(0x2502)
    for (let x = 0; x < W; x++) expect(a.colFilled(x)).toBe(b.colFilled(x))
  })

  it('a light and a heavy vertical share a centre, so a weight change is not a jog', () => {
    const light = draw(0x2502, W, H, 1)
    const heavy = draw(0x2503, W, H, 1)
    const centre = Math.round(W / 2 - 0.5)
    expect(light.colFilled(centre)).toBe(true)
    expect(heavy.colFilled(centre)).toBe(true)
  })
})
