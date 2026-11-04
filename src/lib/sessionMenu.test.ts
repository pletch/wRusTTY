import { describe, it, expect } from 'vitest'
import { keepMenuOnScreen, menuAnchor } from './sessionMenu'

describe('keepMenuOnScreen', () => {
  const SIZE = { width: 200, height: 300 }
  const PHONE = { width: 412, height: 800 }

  it('leaves a menu that fits where it was asked for', () => {
    expect(keepMenuOnScreen({ x: 50, y: 60 }, SIZE, PHONE)).toEqual({ x: 50, y: 60 })
  })

  it('pulls one in from the right and the bottom', () => {
    expect(keepMenuOnScreen({ x: 400, y: 790 }, SIZE, PHONE)).toEqual({ x: 204, y: 492 })
  })

  it('stays clear of what covers the bottom', () => {
    expect(keepMenuOnScreen({ x: 50, y: 790 }, SIZE, PHONE, 64).y).toBe(428)
  })

  it('keeps the top reachable when the menu is taller than the room', () => {
    expect(keepMenuOnScreen({ x: 50, y: 90 }, SIZE, { width: 800, height: 200 }).y).toBe(8)
  })
})

/**
 * Where the menu opens: beside the row, never under the cursor.
 */
describe('menuAnchor', () => {
  const wide = 1200
  const tall = 800

  it('opens to the right of the row, clear of every session', () => {
    // The menu starts at or after the row's right edge.
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
