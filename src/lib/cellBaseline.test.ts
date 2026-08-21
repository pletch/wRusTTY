// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'

import { cellBaseline, domBaselineShift } from './cellBaseline'

describe('where the baseline sits in a cell', () => {
  it('centres the ascent and descent box, so a block cursor covers the glyph', () => {
    // 17px cell, 13 up and 3 down: 1px of slack, half above the box.
    expect(cellBaseline(13, 3, 17)).toBe(14)
    // The same face measured taller has no slack to give and sits at 14 too.
    expect(cellBaseline(14, 4, 17)).toBe(14)
  })

  it('rounds to a whole pixel, because a glyph is rasterized at one', () => {
    expect(cellBaseline(13.4, 3.4, 17)).toBe(14)
    expect(Number.isInteger(cellBaseline(12.7, 4.1, 19))).toBe(true)
  })

  it('never leaves the cell, however odd the metrics it is handed', () => {
    expect(cellBaseline(40, 10, 17)).toBe(17)
    expect(cellBaseline(0, 40, 17)).toBe(0)
  })

  it('gives a taller cell the extra room below the baseline as well as above', () => {
    // Doubling the cell moves the baseline down by half the added height,
    // not by all of it — the box is centred, not top-aligned. Half of the 17
    // added here is 8.5, and the rounding at 17 already took the other half.
    expect(cellBaseline(13, 3, 34) - cellBaseline(13, 3, 17)).toBe(8)
  })
})

describe('nudging DOM text onto that baseline', () => {
  // jsdom lays nothing out and has no canvas, which is the case worth pinning:
  // the suggestion has to keep rendering where CSS put it rather than being
  // moved by a number nobody could measure.
  it('corrects by nothing when the environment cannot be asked', () => {
    expect(domBaselineShift('"Monaspace Neon", monospace', 14, 17)).toBe(0)
  })

  it('answers the same for a repeated question, since it measures layout', () => {
    const first = domBaselineShift('"Fira Code", monospace', 16, 20)
    expect(domBaselineShift('"Fira Code", monospace', 16, 20)).toBe(first)
  })

  it('treats a different size or cell as a different question', () => {
    expect(domBaselineShift('Consolas', 14, 17)).toBe(0)
    expect(domBaselineShift('Consolas', 20, 24)).toBe(0)
  })
})
