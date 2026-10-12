import { describe, it, expect } from 'vitest'
import { fitGrid } from './GhosttyEngine'
import { SCROLLBAR_GUTTER_PX } from '../terminalEngine'

/**
 * Fitting a grid to a pane, keeping the scrollbar overlay's gutter clear. The
 * invariant is in pixels: the canvas's right edge never comes closer to the
 * container's than the gutter, at any width.
 */

const CELL = { width: 8, height: 17 }

/** Pixels between the fitted canvas's right edge and the container's. */
function gap(containerWidth: number, cell = CELL): number {
  const { cols } = fitGrid({ width: containerWidth, height: 400 }, cell, SCROLLBAR_GUTTER_PX)
  return containerWidth - cols * cell.width
}

describe('fitGrid', () => {
  it('leaves at least the gutter free at every width', () => {
    // Every width in a range: the failure depended on the remainder.
    for (let width = 100; width <= 2000; width++) {
      expect(gap(width)).toBeGreaterThanOrEqual(SCROLLBAR_GUTTER_PX)
    }
  })

  it('leaves at least the gutter free at every cell width too', () => {
    // Cell width moves with the font, and with it which widths fail.
    for (let cellWidth = 4; cellWidth <= 20; cellWidth++) {
      for (let width = 200; width <= 1600; width += 7) {
        expect(gap(width, { width: cellWidth, height: 17 })).toBeGreaterThanOrEqual(
          SCROLLBAR_GUTTER_PX,
        )
      }
    }
  })

  it('gives up exactly one column to the gutter, not more', () => {
    // The gutter is reserved without rounding a whole column away.
    const box = { width: 100 * CELL.width + SCROLLBAR_GUTTER_PX, height: 400 }
    expect(fitGrid(box, CELL, SCROLLBAR_GUTTER_PX).cols).toBe(100)
  })

  it('does not reserve anything vertically', () => {
    // The overlay takes no vertical space, so rows use the plain division.
    expect(fitGrid({ width: 800, height: 17 * 24 }, CELL, SCROLLBAR_GUTTER_PX).rows).toBe(24)
  })

  it('reports no grid for a pane too narrow to hold one', () => {
    // A pane can be dragged this small; `fit()` refuses to resize to zero.
    expect(fitGrid({ width: 4, height: 400 }, CELL, SCROLLBAR_GUTTER_PX).cols).toBe(0)
  })

  it('reports no grid rather than Infinity when the cell has no size', () => {
    // measureCell can return zero before a font resolves; dividing by it would
    // hand `setUint32` an Infinity.
    expect(fitGrid({ width: 800, height: 400 }, { width: 0, height: 0 }, SCROLLBAR_GUTTER_PX))
      .toEqual({ cols: 0, rows: 0 })
  })
})
