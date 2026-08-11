import { describe, it, expect } from 'vitest'
import { menuAnchor } from './sessionMenu'

/**
 * Where the menu opens.
 *
 * Beside the row, never under the cursor. Opening it at the click point laid
 * it over the sessions *below* the one it belongs to, and both consequences
 * were real: a click that missed an item slightly connected the wrong host,
 * and after the menu closed the cursor sat on a highlighted row that was not
 * the one being worked on, which reads as the app having selected it.
 */
describe('menuAnchor', () => {
  const wide = 1200
  const tall = 800

  it('opens to the right of the row, clear of every session', () => {
    // A row ending at 490 must not have the menu starting before it.
    expect(menuAnchor(490, 260, wide, tall).x).toBeGreaterThanOrEqual(490)
  })

  it('follows the cursor vertically, so it stays attached to its row', () => {
    expect(menuAnchor(490, 260, wide, tall).y).toBe(260)
    expect(menuAnchor(490, 410, wide, tall).y).toBe(410)
  })

  it('stays on screen in a narrow window rather than opening off the edge', () => {
    const { x } = menuAnchor(490, 260, 560, tall)
    expect(x + 144).toBeLessThanOrEqual(560)
  })

  it('lifts the menu for a row near the bottom, so the last session is usable', () => {
    const { y } = menuAnchor(490, 780, wide, tall)
    expect(y + 128).toBeLessThanOrEqual(tall)
  })
})
