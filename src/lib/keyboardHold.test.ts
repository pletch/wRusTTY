import { beforeEach, describe, expect, it } from 'vitest'

import { heldOffset, keyboardOpen, resetKeyboardHold } from './keyboardHold'

describe('keyboardOpen', () => {
  beforeEach(resetKeyboardHold)

  it('sees a large drop in height at the same width', () => {
    expect(keyboardOpen(412, 800)).toBe(false)
    expect(keyboardOpen(412, 450)).toBe(true)
    expect(keyboardOpen(412, 800)).toBe(false)
  })

  it('ignores a small change, like a system bar', () => {
    expect(keyboardOpen(412, 800)).toBe(false)
    expect(keyboardOpen(412, 760)).toBe(false)
  })

  it('does not read a rotation as a keyboard', () => {
    expect(keyboardOpen(412, 800)).toBe(false)
    expect(keyboardOpen(800, 380)).toBe(false)
    expect(keyboardOpen(412, 800)).toBe(false)
  })

  it('tracks a keyboard in each orientation separately', () => {
    keyboardOpen(412, 800)
    keyboardOpen(800, 380)
    expect(keyboardOpen(800, 108)).toBe(true)
    expect(keyboardOpen(412, 450)).toBe(true)
  })
})

describe('heldOffset', () => {
  const CELL = 20
  const GRID = 800
  const VISIBLE = 360

  it('leaves the grid in place when the cursor already shows', () => {
    expect(heldOffset(3, CELL, GRID, VISIBLE)).toBe(0)
  })

  it('slides up just enough to show the cursor and the row after it', () => {
    expect(heldOffset(20, CELL, GRID, VISIBLE)).toBe(22 * CELL - VISIBLE)
  })

  it('stops with the grid bottom at the keyboard', () => {
    expect(heldOffset(39, CELL, GRID, VISIBLE)).toBe(GRID - VISIBLE)
  })

  it('shows the bottom for a cursor scrolled out of view', () => {
    expect(heldOffset(500, CELL, GRID, VISIBLE)).toBe(GRID - VISIBLE)
  })
})
