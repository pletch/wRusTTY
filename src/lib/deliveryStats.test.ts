import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

  // The correlation tests replace `performance.now`; nothing else may inherit it.
  afterEach(() => {
    ds.stop()
    vi.restoreAllMocks()
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
      { ...base, count: 100, bytes: 10e6, spanMs: 1000, bytesPerSec: 10e6, parseMs: 900, parseShare: 0.9,
        activeSpanMs: 1000, activeBytes: 10e6, activeBytesPerSec: 10e6, activeParseMs: 900, activeParseShare: 0.9 },
      { flushes: 100, bytes: 10e6, minBytes: 32768, maxBytes: 65536, spanMs: 1000, bytesPerSec: 10e6 },
    )
    expect(report).toContain('ENGINE-BOUND')
  })

  it('reads UPSTREAM-BOUND when the frontend was mostly idle', () => {
    const report = ds.formatReport(
      { ...base, count: 100, bytes: 10e6, spanMs: 1000, bytesPerSec: 10e6, parseMs: 50, parseShare: 0.05,
        activeSpanMs: 1000, activeBytes: 10e6, activeBytesPerSec: 10e6, activeParseMs: 50, activeParseShare: 0.05 },
      { flushes: 100, bytes: 10e6, minBytes: 32768, maxBytes: 65536, spanMs: 1000, bytesPerSec: 10e6 },
    )
    expect(report).toContain('UPSTREAM-BOUND')
  })

  it('reads IPC/FRONTEND-BOUND when the backend outran the frontend', () => {
    // Backend pushed 40 MB/s; the frontend only took delivery of 10 MB/s and
    // was not busy parsing — the bytes were stuck in between.
    const report = ds.formatReport(
      { ...base, count: 100, bytes: 10e6, spanMs: 1000, bytesPerSec: 10e6, parseMs: 100, parseShare: 0.1,
        activeSpanMs: 1000, activeBytes: 10e6, activeBytesPerSec: 10e6, activeParseMs: 100, activeParseShare: 0.1 },
      { flushes: 100, bytes: 40e6, minBytes: 32768, maxBytes: 65536, spanMs: 1000, bytesPerSec: 40e6 },
    )
    expect(report).toContain('IPC/FRONTEND-BOUND')
  })

  /**
   * The reason the rAF series exists: an idle frontend and a blocked frontend
   * look identical in the delivery numbers alone. These two cases differ only
   * in whether frames kept arriving across the starved window.
   */
  describe('main-thread correlation across the longest idle gap', () => {
    /** Drives `record` against a controlled clock so a 2.4 s gap can be
     *  reproduced without waiting 2.4 s. */
    function floodWithGap(framesDuringGap: boolean) {
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      ds.start()

      now = 1000
      ds.record(36000, () => { now += 1 })   // ends at 1001

      // Frames before the gap, in both cases.
      for (let t = 900; t <= 1000; t += 16) ds.recordFrameForTest(t)
      if (framesDuringGap) {
        for (let t = 1016; t < 3401; t += 16) ds.recordFrameForTest(t)
      }
      // Frames resume after it, in both cases.
      for (let t = 3402; t < 3500; t += 16) ds.recordFrameForTest(t)

      now = 3401
      ds.record(36000, () => { now += 1 })   // 2400 ms after the previous end
      return ds.snapshot()
    }

    it('reads a free thread when frames kept arriving through the gap', () => {
      const s = floodWithGap(true)
      expect(s.maxIdleMs).toBeCloseTo(2400)
      expect(s.framesDuringMaxIdle).toBeGreaterThan(100)
      expect(s.maxFrameGapInIdleMs).toBeLessThan(33)
      expect(ds.formatReport(s, null)).toContain('thread was FREE')
    })

    it('reads a blocked thread when frames stopped for the gap', () => {
      const s = floodWithGap(false)
      expect(s.maxIdleMs).toBeCloseTo(2400)
      expect(s.framesDuringMaxIdle).toBe(0)
      // The stall is visible as one enormous gap spanning the whole window.
      expect(s.maxFrameGapMs).toBeGreaterThan(2000)
      expect(ds.formatReport(s, null)).toContain('MAIN THREAD BLOCKED')
    })
  })

  /**
   * `maxIdleMs` alone cannot tell one long stall from a run of medium ones,
   * and the two point at different causes — so the total and the located
   * top-N are what the report actually reasons from.
   */
  describe('idle distribution', () => {
    /** Deliveries at a controlled clock, each preceded by a chosen idle gap. */
    function floodWithGaps(gaps: number[], bytesEach = 100_000) {
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      ds.start()
      now = 1000
      ds.record(bytesEach, () => { now += 5 })
      for (const gap of gaps) {
        now += gap
        ds.record(bytesEach, () => { now += 5 })
      }
      return ds.snapshot()
    }

    it('sums every gap, not just the largest', () => {
      const s = floodWithGaps([300, 50, 400, 20])
      expect(s.maxIdleMs).toBe(400)
      expect(s.totalIdleMs).toBe(770)
      // Span is 4 deliveries of 5 ms plus the gaps, measured start to start.
      expect(s.idleShare).toBeGreaterThan(0.9)
    })

    it('locates each gap in the clock and in the byte stream', () => {
      const s = floodWithGaps([300, 900], 100_000)
      const [worst] = s.topGaps
      expect(worst.ms).toBe(900)
      // Two deliveries had landed before it began: 5 ms, +300 gap, +5 ms.
      expect(worst.afterBytes).toBe(200_000)
      expect(worst.atMs).toBeCloseTo(310)
    })

    it('ranks gaps longest first and keeps at most five', () => {
      const s = floodWithGaps([10, 500, 20, 300, 40, 200, 60])
      expect(s.topGaps).toHaveLength(5)
      expect(s.topGaps.map((g) => g.ms)).toEqual([500, 300, 200, 60, 40])
    })

    it('reads each gap independently against the frame series', () => {
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      ds.start()
      now = 1000
      ds.record(1000, () => { now += 1 })          // ends 1001
      // First gap: frames throughout, so the thread was free.
      for (let t = 1002; t < 1500; t += 16) ds.recordFrameForTest(t)
      now = 1501
      ds.record(1000, () => { now += 1 })          // ends 1502, gap of 500
      // Second gap: no frames at all, so the thread was blocked.
      now = 2502
      ds.record(1000, () => { now += 1 })          // gap of 1000

      const report = ds.formatReport(ds.snapshot(), null)
      expect(report).toMatch(/1000\.0 ms @ .* \(BLOCKED\)/)
      expect(report).toMatch(/500\.0 ms @ .* \(free\)/)
    })
  })

  /**
   * A flood is started by typing a command, so the recording opens with the
   * shell's echo and then waits for the producer to spin up. Counting that
   * wait understated a real 100 MB local flood by 20% and flipped its verdict.
   */
  describe('warm-up exclusion', () => {
    /** The shape of a real flood: a tiny echo, a long wait, then bulk. */
    function floodAfterWarmup(warmup: number) {
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      ds.start()
      now = 1000
      ds.record(30, () => { now += 1 })            // the echoed command
      now += warmup
      for (let i = 0; i < 10; i++) {
        ds.record(262144, () => { now += 8 })      // bulk, 8 ms each
        now += 2                                   // inter-delivery IPC gap
      }
      return ds.snapshot()
    }

    it('excludes the wait before the first bulk delivery', () => {
      const s = floodAfterWarmup(1000)
      // Everything before the window: the 1 ms echo write plus the 1000 ms
      // wait. It must equal what activeSpanMs left out, since the same figure
      // is used to correct the backend's span.
      expect(s.warmupMs).toBe(1001)
      expect(s.spanMs - s.activeSpanMs).toBe(s.warmupMs)
      // 10 deliveries of 8 ms plus 9 inter-delivery gaps of 2 ms.
      expect(s.activeSpanMs).toBe(98)
      expect(s.activeBytes).toBe(2621440)
    })

    /**
     * The shape a real run actually had: echo, the long wait, *another* small
     * delivery, then bulk. Charging only the gap immediately before the window
     * reported 11 ms of warm-up where 2258 ms had been excluded.
     */
    it('counts the whole warm-up when more than one small delivery precedes it', () => {
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      ds.start()
      now = 1000
      ds.record(30, () => { now += 1 })     // echoed command
      now += 2000                            // the producer spinning up
      ds.record(60, () => { now += 1 })     // a second scrap of prompt output
      now += 11                              // ordinary IPC gap
      for (let i = 0; i < 10; i++) {
        ds.record(262144, () => { now += 8 })
        now += 2
      }
      const s = ds.snapshot()
      expect(s.warmupMs).toBe(2013)
      expect(s.spanMs - s.activeSpanMs).toBe(s.warmupMs)
      expect(s.activeSpanMs).toBe(98)
      // The startup wait must not sit at the top of the stall list, nor be
      // counted as idle time inside the run.
      expect(s.maxIdleMs).toBe(2)
      expect(s.totalIdleMs).toBe(18)
      expect(s.topGaps.every((g) => g.ms < 100)).toBe(true)
    })

    it('reports a rate the warm-up would otherwise have dragged down', () => {
      const s = floodAfterWarmup(1000)
      expect(s.activeBytesPerSec).toBeGreaterThan(s.bytesPerSec * 5)
    })

    it('reads ENGINE-BOUND on work the raw span would have called IPC-bound', () => {
      const s = floodAfterWarmup(1000)
      // Raw: 800 ms of parse in a 1099 ms span is 73%, but the warm-up is
      // most of what remains. Active: 800 of 98... the bulk is 80% either way,
      // so assert the two shares differ and the verdict follows the active one.
      expect(s.activeParseShare).toBeGreaterThan(s.parseShare)
      expect(s.activeParseShare).toBeCloseTo(80 / 98, 2)
      expect(ds.formatReport(s, { flushes: 11, bytes: 2621470, minBytes: 30,
        maxBytes: 262144, spanMs: 1099, bytesPerSec: 2385000 })).toContain('ENGINE-BOUND')
    })

    it('reports no warm-up when deliveries are uniform', () => {
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      ds.start()
      now = 1000
      for (let i = 0; i < 5; i++) {
        ds.record(262144, () => { now += 8 })
        now += 2
      }
      const s = ds.snapshot()
      expect(s.warmupMs).toBe(0)
      expect(s.activeSpanMs).toBe(s.spanMs)
      expect(s.activeBytes).toBe(s.bytes)
    })
  })

  it('says the thread was not sampled when no frames were recorded', () => {
    ds.start()
    ds.record(1000, () => {})
    expect(ds.formatReport(ds.snapshot(), null)).toContain('not sampled')
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
  maxFrameGapMs: 0, framesDuringMaxIdle: 0, maxFrameGapInIdleMs: 0,
  totalIdleMs: 0, idleShare: 0, topGaps: [],
  warmupMs: 0, activeSpanMs: 0, activeBytes: 0, activeBytesPerSec: 0,
  activeParseMs: 0, activeParseShare: 0,
}
