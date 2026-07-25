import { describe, it, expect } from 'vitest'
import { PALETTE_16, PALETTE_256, DEFAULT_FG, DEFAULT_BG, rgbHex } from './gridPalette'

describe('grid-parity palette', () => {
  it('has 256 entries', () => {
    expect(PALETTE_256).toHaveLength(256)
    expect(PALETTE_256.slice(0, 16)).toEqual([...PALETTE_16])
  })

  // The whole point of the table is that a colour identifies its slot. If two
  // slots shared a value, a cell reported under the wrong index would compare
  // equal and the parity test would pass on a real divergence.
  it('maps every index to a distinct colour', () => {
    const seen = new Map<number, number>()
    for (let i = 0; i < PALETTE_256.length; i++) {
      const prev = seen.get(PALETTE_256[i])
      expect(prev, `index ${i} duplicates index ${prev} (${rgbHex(PALETTE_256[i])})`).toBeUndefined()
      seen.set(PALETTE_256[i], i)
    }
  })

  // Same argument for the defaults: "this cell is on the theme default" and
  // "this cell explicitly asked for slot N" have to be distinguishable, or a
  // dropped SGR reset would read as correct.
  it('keeps the default fg and bg outside the palette', () => {
    expect(PALETTE_256).not.toContain(DEFAULT_FG)
    expect(PALETTE_256).not.toContain(DEFAULT_BG)
    expect(DEFAULT_FG).not.toBe(DEFAULT_BG)
  })

  it('builds the cube and grey ramp at the standard xterm-256 values', () => {
    // Spot checks against the well-known table rather than a reimplementation
    // of the same formula, which would agree with a wrong formula too.
    expect(rgbHex(PALETTE_256[16])).toBe('000000')
    expect(rgbHex(PALETTE_256[21])).toBe('0000ff')
    expect(rgbHex(PALETTE_256[196])).toBe('ff0000')
    expect(rgbHex(PALETTE_256[231])).toBe('ffffff')
    expect(rgbHex(PALETTE_256[232])).toBe('080808')
    expect(rgbHex(PALETTE_256[255])).toBe('eeeeee')
  })
})
