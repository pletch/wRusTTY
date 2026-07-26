import { describe, it, expect } from 'vitest'
import { parseCells, parseShortSgr, parseLongSgr } from './workloads'

const dec = new TextDecoder()
const ESC = String.fromCharCode(27)

/**
 * These three exist to divide ~29 ns/byte between the state machine, the actions
 * it dispatches, and the per-cell work a printable character triggers. The
 * division only holds if each stream is exactly what it claims, so the claims
 * are pinned here: a stray printable byte in an SGR stream, or a truncated final
 * sequence, would quietly turn a decisive result into a meaningless one.
 */
describe('parse-cost probes', () => {
  it('writes one cell per byte in the printable probe', () => {
    const { events, totalBytes } = parseCells.build(80, 24)
    const text = dec.decode(events[0])
    // Every byte is printable or part of a line ending; nothing here is an
    // escape sequence, so the parser's only job is to place cells.
    expect(text).not.toContain(ESC)
    expect(text.startsWith('x'.repeat(80) + '\r\n')).toBe(true)
    expect(totalBytes).toBe(events[0].length)
  })

  it('writes no cells at all in either SGR probe', () => {
    for (const w of [parseShortSgr, parseLongSgr]) {
      const text = dec.decode(w.build(80, 24).events[0])
      // Split on ESC rather than matching it: every piece must be one complete
      // SGR body and nothing else, so there is no printable byte and no line
      // ending anywhere in the stream — parsed in full, buffer untouched.
      const parts = text.split(ESC)
      const bodies = new Set(parts.slice(1))
      expect(parts[0]).toBe('')
      expect(bodies.size).toBe(1)
      expect([...bodies][0]).toMatch(/^\[[\d;]*m$/)
    }
  })

  /**
   * The whole point of the long form. Same single action, materially more bytes
   * through the state machine — that ratio is what separates per-byte cost from
   * per-action cost, so it has to be large enough for the result to be readable.
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
   * Comparable only if they are the same size, and large enough that a few
   * milliseconds of noise cannot swing the ratio between them.
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
