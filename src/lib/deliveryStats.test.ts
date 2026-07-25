import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as ds from './deliveryStats'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

/**
 * The recorder sits on the hot path of every byte the app receives, so the
 * property that matters most is that it is inert until switched on — and after
 * that, that its verdict actually follows from its numbers.
 */
describe('deliveryStats', () => {
  beforeEach(() => {
    ds.stop()
    ds.reset()
  })

  it('still runs the write when disabled, and records nothing', () => {
    let ran = 0
    const out = ds.record(1024, () => {
      ran++
      return 'written'
    })
    expect(out).toBe('written')
    expect(ran).toBe(1)
    expect(ds.snapshot().count).toBe(0)
  })

  it('returns the write\'s value and propagates its errors', () => {
    ds.start()
    expect(ds.record(10, () => 42)).toBe(42)
    // A throwing engine must not be swallowed by instrumentation, and the
    // delivery should still be accounted for.
    expect(() => ds.record(10, () => { throw new Error('engine died') })).toThrow('engine died')
    expect(ds.snapshot().count).toBe(2)
  })

  it('records size distribution across deliveries', () => {
    ds.start()
    for (const n of [1000, 5000, 2000, 9000, 3000]) ds.record(n, () => {})
    const s = ds.snapshot()
    expect(s.count).toBe(5)
    expect(s.bytes).toBe(20000)
    expect(s.minBytes).toBe(1000)
    expect(s.maxBytes).toBe(9000)
    expect(s.medianBytes).toBe(3000)
  })

  it('attributes busy time to the engine and idle time to starvation', () => {
    ds.start()
    // A delivery that takes real time inside the engine.
    ds.record(1000, () => {
      const until = performance.now() + 12
      while (performance.now() < until) { /* busy */ }
    })
    const s = ds.snapshot()
    expect(s.parseMs).toBeGreaterThan(5)
    expect(s.maxParseMs).toBeGreaterThan(5)
  })

  it('reads ENGINE-BOUND when the drain was spent inside the parser', () => {
    const report = ds.formatReport(
      { ...base, count: 100, bytes: 10e6, spanMs: 1000, bytesPerSec: 10e6, parseMs: 900, parseShare: 0.9 },
      { flushes: 100, bytes: 10e6, minBytes: 32768, maxBytes: 65536, spanMs: 1000, bytesPerSec: 10e6 },
    )
    expect(report).toContain('ENGINE-BOUND')
  })

  it('reads UPSTREAM-BOUND when the frontend was mostly idle', () => {
    const report = ds.formatReport(
      { ...base, count: 100, bytes: 10e6, spanMs: 1000, bytesPerSec: 10e6, parseMs: 50, parseShare: 0.05 },
      { flushes: 100, bytes: 10e6, minBytes: 32768, maxBytes: 65536, spanMs: 1000, bytesPerSec: 10e6 },
    )
    expect(report).toContain('UPSTREAM-BOUND')
  })

  it('reads IPC/FRONTEND-BOUND when the backend outran the frontend', () => {
    // Backend pushed 40 MB/s; the frontend only took delivery of 10 MB/s and
    // was not busy parsing — the bytes were stuck in between.
    const report = ds.formatReport(
      { ...base, count: 100, bytes: 10e6, spanMs: 1000, bytesPerSec: 10e6, parseMs: 100, parseShare: 0.1 },
      { flushes: 100, bytes: 40e6, minBytes: 32768, maxBytes: 65536, spanMs: 1000, bytesPerSec: 40e6 },
    )
    expect(report).toContain('IPC/FRONTEND-BOUND')
  })

  it('says so plainly when nothing was recorded', () => {
    expect(ds.formatReport(base, null)).toContain('call start()')
  })

  it('start() clears anything left from a previous run', () => {
    ds.start()
    ds.record(1234, () => {})
    expect(ds.snapshot().count).toBe(1)
    ds.start()
    expect(ds.snapshot().count).toBe(0)
  })
})

const base: ds.DeliverySnapshot = {
  count: 0, bytes: 0, spanMs: 0, bytesPerSec: 0, parseMs: 0, parseShare: 0,
  minBytes: 0, medianBytes: 0, p95Bytes: 0, maxBytes: 0,
  medianParseMs: 0, p95ParseMs: 0, maxParseMs: 0, maxIdleMs: 0,
}
