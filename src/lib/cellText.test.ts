import { describe, it, expect } from 'vitest'
import { fitToCells, toCellUnits } from './cellText'

/**
 * These exist because the alternative — handing a whole string to the browser
 * and trusting it to advance one cell per character — is what produced a
 * visible offset between the inline suggestion and the real text above it.
 * The font's advance and the engine's cell width are close and not equal, so
 * the error accumulates per character.
 */
describe('toCellUnits', () => {
  it('gives every ordinary character a cell of its own', () => {
    expect(toCellUnits('ls -la').map((u) => u.text)).toEqual(['l', 's', ' ', '-', 'l', 'a'])
    expect(toCellUnits('ls -la').every((u) => u.cells === 1)).toBe(true)
  })

  it('keeps spaces as units, since a command is full of them', () => {
    // Collapsed or dropped, every character after the run lands in the wrong
    // column — which is the whole failure this module exists to prevent.
    expect(toCellUnits('a  b')).toHaveLength(4)
  })

  it('gives a wide character two cells', () => {
    expect(toCellUnits('世界')).toEqual([
      { text: '世', cells: 2 },
      { text: '界', cells: 2 },
    ])
    // Mixed, which is what a path with CJK in it actually looks like.
    expect(toCellUnits('cd 世/x').map((u) => u.cells)).toEqual([1, 1, 1, 2, 1, 1])
  })

  it('treats an emoji as one wide unit rather than its code units', () => {
    const units = toCellUnits('echo 🚀')
    expect(units).toHaveLength(6)
    expect(units[5]).toEqual({ text: '🚀', cells: 2 })
  })

  it('folds a combining mark into the character it modifies', () => {
    // `e` + U+0301 is one glyph in one cell. Given a box each, the accent
    // would sit in the next column on its own.
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

  /** Half a glyph in the last column looks like a rendering fault; a blank
   * column looks like the end of the line, which is what it is. */
  it('never leaves half a wide character in the last column', () => {
    const units = toCellUnits('a世b')
    // Two cells free: `a` fits, the wide character does not.
    expect(fitToCells(units, 2).map((u) => u.text)).toEqual(['a'])
    // Three, and it does.
    expect(fitToCells(units, 3).map((u) => u.text)).toEqual(['a', '世'])
  })

  /**
   * A wide character that does not fit stops the run rather than being
   * skipped over — text after a gap would no longer line up with the command
   * it is supposed to be continuing.
   */
  it('stops at the first thing that does not fit', () => {
    expect(fitToCells(toCellUnits('世ab'), 2).map((u) => u.text)).toEqual(['世'])
    expect(fitToCells(toCellUnits('世ab'), 1)).toEqual([])
  })
})
