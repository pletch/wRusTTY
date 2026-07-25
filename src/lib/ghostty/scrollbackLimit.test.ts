import { describe, it, expect } from 'vitest'
import { scrollbackLinesFor } from './GhosttyEngine'

/**
 * Guards the unit and the range of the value handed to the core as
 * `scrollbackLimit`.
 *
 * This is the arithmetic behind a real wedge, and the failure was silent in
 * both directions, which is why it is pinned here rather than left to review.
 * The core takes a **line count** and multiplies it by its per-line page cost
 * using 32-bit `usize` — and on overflow it does not error, it falls back to
 * "unlimited". An earlier version of this function returned a *byte* budget
 * (rows x cols x 16), so a routine 5000-line setting arrived as ~8,000,000,
 * overflowed, and turned the scrollback cap off entirely. A 100 MB flood then
 * retained every one of its ~1.15 M rows, grew the WASM heap to ~2 GB, and the
 * pane wedged when an allocation was finally refused.
 *
 * So the property that matters is not "some number comes back" but that the
 * number is small enough that the core's own multiply stays in range.
 */

/** The core's measured per-cell cost of a retained line, at its worst across
 *  the widths swept (40-400 columns): ~12.65 bytes. */
const CORE_BYTES_PER_CELL_WORST = 12.65
const U32_MAX = 4294967295

describe('scrollbackLinesFor', () => {
  it('returns a line count, not a byte budget', () => {
    // The regression in one assertion: a byte budget for this pane would be
    // 5000 * 80 * ~13 = ~5.2M. A line count is just the setting.
    expect(scrollbackLinesFor(5000, 80)).toBe(5000)
  })

  it('passes ordinary settings through untouched', () => {
    expect(scrollbackLinesFor(1000, 80)).toBe(1000)
    expect(scrollbackLinesFor(5000, 200)).toBe(5000)
    expect(scrollbackLinesFor(10000, 100)).toBe(10000)
  })

  it('never lets the core overflow its 32-bit lines-to-bytes multiply', () => {
    // Every plausible width, against settings far past anything a UI offers —
    // including the value that actually broke, and one absurd enough to stand
    // in for a corrupt or hostile setting.
    for (const cols of [1, 40, 80, 100, 120, 200, 300, 400, 1000]) {
      for (const setting of [0, 1000, 5000, 100000, 8000000, 1e9]) {
        const lines = scrollbackLinesFor(setting, cols)
        expect(lines * cols * CORE_BYTES_PER_CELL_WORST).toBeLessThan(U32_MAX)
      }
    }
  })

  it('caps the per-pane memory a setting can commit', () => {
    // Every pane is its own WASM instance, so this ceiling is what stops a big
    // setting from multiplying across a window full of sessions.
    for (const cols of [80, 200, 400]) {
      const lines = scrollbackLinesFor(1e9, cols)
      expect(lines * cols * CORE_BYTES_PER_CELL_WORST).toBeLessThanOrEqual(64 * 1024 * 1024)
    }
  })

  it('gives a wider pane fewer lines out of the same ceiling', () => {
    // Lines cost bytes per column, so width and depth trade against each other
    // once the ceiling binds — the documented behaviour, asserted so it can't
    // silently become "same lines at any width" (which would be the ceiling
    // quietly not applying).
    expect(scrollbackLinesFor(1e9, 200)).toBeLessThan(scrollbackLinesFor(1e9, 80))
  })

  it('holds a floor so a small or zero setting still leaves usable history', () => {
    expect(scrollbackLinesFor(0, 80)).toBe(100)
    expect(scrollbackLinesFor(-5, 80)).toBe(100)
  })

  it('never returns a fractional line count', () => {
    // The value is written into the config with setUint32; a fraction would be
    // truncated somewhere less visible than here.
    for (const cols of [37, 80, 133, 200]) {
      for (const setting of [0, 1234.7, 5000, 1e9]) {
        expect(Number.isInteger(scrollbackLinesFor(setting, cols))).toBe(true)
      }
    }
  })
})
