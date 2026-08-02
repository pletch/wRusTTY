import { describe, it, expect } from 'vitest'
import { fitGrid } from './GhosttyEngine'
import { SCROLLBAR_GUTTER_PX } from '../terminalEngine'

/**
 * Fitting a grid to a pane, and specifically the gutter the scrollbar overlay
 * sits in.
 *
 * The bug this pins: the grid was derived from the full container width, so
 * the canvas ran under an overlay that is painted on top of it, and the last
 * column was clipped whenever `width % cellWidth` came out under the
 * scrollbar's 8px. That is most widths at a typical cell size, but not all of
 * them — which is why it read as the last character vanishing "sometimes"
 * rather than as a grid that was simply one column too wide.
 *
 * The invariant is therefore not about column counts but about pixels: the
 * canvas's right edge must never come closer to the container's than the
 * gutter.
 */

const CELL = { width: 8, height: 17 }

/** Pixels between the fitted canvas's right edge and the container's. */
function gap(containerWidth: number, cell = CELL): number {
  const { cols } = fitGrid({ width: containerWidth, height: 400 }, cell, SCROLLBAR_GUTTER_PX)
  return containerWidth - cols * cell.width
}

describe('fitGrid', () => {
  it('leaves at least the gutter free at every width', () => {
    // Every pixel width across a wide range, since the failure was width-
    // dependent: a spot check picks exactly the widths that used to work.
    for (let width = 100; width <= 2000; width++) {
      expect(gap(width)).toBeGreaterThanOrEqual(SCROLLBAR_GUTTER_PX)
    }
  })

  it('leaves at least the gutter free at every cell width too', () => {
    // Cell width moves with the font, and the old bug's visibility moved with
    // it — at a 4px cell the remainder was under 8px far more often.
    for (let cellWidth = 4; cellWidth <= 20; cellWidth++) {
      for (let width = 200; width <= 1600; width += 7) {
        expect(gap(width, { width: cellWidth, height: 17 })).toBeGreaterThanOrEqual(
          SCROLLBAR_GUTTER_PX,
        )
      }
    }
  })

  it('gives up exactly one column to the gutter, not more', () => {
    // A pane exactly 100 cells wide plus the gutter fits 100 columns: the
    // fix reserves the gutter, it doesn't round a whole column away on top.
    const box = { width: 100 * CELL.width + SCROLLBAR_GUTTER_PX, height: 400 }
    expect(fitGrid(box, CELL, SCROLLBAR_GUTTER_PX).cols).toBe(100)
  })

  it('does not reserve anything vertically', () => {
    // The overlay spans the full height but takes no vertical space — rows
    // come from the plain division, and reserving there would cost a row for
    // nothing.
    expect(fitGrid({ width: 800, height: 17 * 24 }, CELL, SCROLLBAR_GUTTER_PX).rows).toBe(24)
  })

  it('reports no grid for a pane too narrow to hold one', () => {
    // A pane can be dragged this small mid-layout. `fit()` refuses to resize
    // on a zero, which is the only sane answer — a zero-column terminal is
    // not a thing the core can be asked for.
    expect(fitGrid({ width: 4, height: 400 }, CELL, SCROLLBAR_GUTTER_PX).cols).toBe(0)
  })

  it('reports no grid rather than Infinity when the cell has no size', () => {
    // measureCell can return zero before a font has resolved; dividing by it
    // would hand the core an Infinity, which `setUint32` turns into garbage.
    expect(fitGrid({ width: 800, height: 400 }, { width: 0, height: 0 }, SCROLLBAR_GUTTER_PX))
      .toEqual({ cols: 0, rows: 0 })
  })
})
