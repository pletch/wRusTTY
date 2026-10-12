import { describe, it, expect } from 'vitest'
import { parseCells, parseShortSgr, parseLongSgr } from './workloads'

const dec = new TextDecoder()
const ESC = String.fromCharCode(27)

/**
 * The three probes divide parse cost between the state machine, its actions
 * and per-cell work, which only holds if each stream is exactly what it
 * claims; a stray printable byte or truncated sequence would spoil it.
 */
describe('parse-cost probes', () => {
  it('writes one cell per byte in the printable probe', () => {
    const { events, totalBytes } = parseCells.build(80, 24)
    const text = dec.decode(events[0])
    // Printable bytes and line endings only: the parser just places cells.
    expect(text).not.toContain(ESC)
    expect(text.startsWith('x'.repeat(80) + '\r\n')).toBe(true)
    expect(totalBytes).toBe(events[0].length)
  })

  it('writes no cells at all in either SGR probe', () => {
    for (const w of [parseShortSgr, parseLongSgr]) {
      const text = dec.decode(w.build(80, 24).events[0])
      // Each piece must be one complete SGR body: no printable bytes or line
      // endings anywhere.
      const parts = text.split(ESC)
      const bodies = new Set(parts.slice(1))
      expect(parts[0]).toBe('')
      expect(bodies.size).toBe(1)
      expect([...bodies][0]).toMatch(/^\[[\d;]*m$/)
    }
  })

  /**
   * The long form's byte-to-action ratio must be large enough to separate
   * per-byte from per-action cost.
   */
  it('puts several times more bytes behind each action in the long form', () => {
    const short = parseShortSgr.build(80, 24)
    const long = parseLongSgr.build(80, 24)
    const shortActions = short.totalBytes / 4
    const longActions = long.totalBytes / 22
    expect(shortActions / longActions).toBeGreaterThan(4)
  })

  it('never ends mid-sequence, which would leave the parser mid-state', () => {
    for (const w of [parseShortSgr, parseLongSgr]) {
      const buf = w.build(80, 24).events[0]
      expect(buf[buf.length - 1]).toBe('m'.charCodeAt(0))
    }
  })

  /**
   * Equal sizes, large enough that noise can't swing the ratio.
   */
  it('sizes all three alike, within one repeat unit', () => {
    const sizes = [parseCells, parseShortSgr, parseLongSgr].map((w) => w.build(80, 24).totalBytes)
    for (const s of sizes) expect(s).toBeGreaterThan(1024 * 1024)
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(100)
  })

  it('exempts the cell-free probes from the buffer-growth guard, and only those', () => {
    expect(parseShortSgr.scrollsMainScreen).toBe(false)
    expect(parseLongSgr.scrollsMainScreen).toBe(false)
    expect(parseCells.scrollsMainScreen ?? true).toBe(true)
  })
})
