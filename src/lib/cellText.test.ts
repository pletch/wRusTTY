import { describe, it, expect } from 'vitest'
import { fitToCells, toCellUnits } from './cellText'

/**
 * Splitting text into cells, so DOM text over the grid advances one cell per
 * unit rather than by the font's slightly different advance.
 */
describe('toCellUnits', () => {
  it('gives every ordinary character a cell of its own', () => {
    expect(toCellUnits('ls -la').map((u) => u.text)).toEqual(['l', 's', ' ', '-', 'l', 'a'])
    expect(toCellUnits('ls -la').every((u) => u.cells === 1)).toBe(true)
  })

  it('keeps spaces as units, since a command is full of them', () => {
    // Collapsed spaces would shift every later character's column.
    expect(toCellUnits('a  b')).toHaveLength(4)
  })

  it('gives a wide character two cells', () => {
    expect(toCellUnits('世界')).toEqual([
      { text: '世', cells: 2 },
      { text: '界', cells: 2 },
    ])
    // Mixed, as in a path containing CJK.
    expect(toCellUnits('cd 世/x').map((u) => u.cells)).toEqual([1, 1, 1, 2, 1, 1])
  })

  it('treats an emoji as one wide unit rather than its code units', () => {
    const units = toCellUnits('echo 🚀')
    expect(units).toHaveLength(6)
    expect(units[5]).toEqual({ text: '🚀', cells: 2 })
  })

  it('folds a combining mark into the character it modifies', () => {
    // `e` + U+0301 is one glyph in one cell, not an accent in its own box.
    const units = toCellUnits('café')
    expect(units).toHaveLength(4)
    expect(units[3]).toEqual({ text: 'é', cells: 1 })
  })

  it('does not crash on a leading combining mark', () => {
    expect(toCellUnits('́x')).toHaveLength(2)
  })

  it('has nothing to say about an empty string', () => {
    expect(toCellUnits('')).toEqual([])
  })
})

describe('fitToCells', () => {
  it('takes as much as fits', () => {
    const units = toCellUnits('abcdef')
    expect(fitToCells(units, 3).map((u) => u.text)).toEqual(['a', 'b', 'c'])
    expect(fitToCells(units, 99)).toHaveLength(6)
    expect(fitToCells(units, 0)).toEqual([])
  })

  /** A blank last column reads as the end of the line; half a glyph reads as
   * a rendering fault. */
  it('never leaves half a wide character in the last column', () => {
    const units = toCellUnits('a世b')
    // Two cells free: `a` fits, the wide character does not.
    expect(fitToCells(units, 2).map((u) => u.text)).toEqual(['a'])
    // Three, and it does.
    expect(fitToCells(units, 3).map((u) => u.text)).toEqual(['a', '世'])
  })

  /**
   * A wide character that doesn't fit stops the run, so later text never
   * misaligns.
   */
  it('stops at the first thing that does not fit', () => {
    expect(fitToCells(toCellUnits('世ab'), 2).map((u) => u.text)).toEqual(['世'])
    expect(fitToCells(toCellUnits('世ab'), 1)).toEqual([])
  })
})
