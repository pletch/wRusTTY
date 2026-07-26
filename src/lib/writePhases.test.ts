import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as phases from './writePhases'

/**
 * This wraps the hottest path in the app, so the properties that matter are
 * that it is inert when off, transparent to the work it wraps, and that its
 * shares actually add up — a breakdown whose parts do not reconcile with the
 * whole would send someone looking in the wrong place.
 */
describe('writePhases', () => {
  beforeEach(() => {
    phases.stop()
    phases.reset()
  })

  afterEach(() => {
    phases.stop()
    vi.restoreAllMocks()
  })

  it('runs the work and records nothing when disabled', () => {
    let ran = 0
    expect(phases.time('parse', () => { ran++; return 'done' })).toBe('done')
    expect(ran).toBe(1)
    expect(phases.snapshot().writes).toBe(0)
    expect(phases.snapshot().totals.parse).toBe(0)
  })

  it('returns values and propagates throws while still accounting for the time', () => {
    phases.start()
    expect(phases.time('parse', () => 42)).toBe(42)
    expect(() => phases.time('parse', () => { throw new Error('core died') })).toThrow('core died')
    expect(phases.snapshot().calls.parse).toBe(2)
  })

  it('attributes each phase separately and counts its calls', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    phases.start()
    phases.time('scan', () => { now += 5 })
    phases.time('parse', () => { now += 3 })
    phases.time('parse', () => { now += 2 })
    phases.time('drain', () => { now += 1 })
    const s = phases.snapshot()
    expect(s.totals.scan).toBe(5)
    expect(s.totals.parse).toBe(5)
    expect(s.totals.drain).toBe(1)
    expect(s.calls.parse).toBe(2)
    expect(s.calls.handlers).toBe(0)
  })

  /**
   * Sub-phases subdivide `parse` rather than sitting alongside it. If they
   * were summed with the top-level phases the total would exceed the write and
   * every share would be wrong, so this pins which group each belongs to.
   */
  it('subdivides parse without double-counting against the write', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    phases.start()
    const started = phases.now()
    phases.time('parse', () => {
      phases.time('alloc', () => { now += 1 })
      phases.time('copy', () => { now += 2 })
      phases.time('coreWrite', () => { now += 6 })
      phases.time('free', () => { now += 1 })
    })
    phases.recordWrite(262144, phases.now() - started)

    const s = phases.snapshot()
    expect(s.writeMs).toBe(10)
    expect(s.totals.parse).toBe(10)
    // parse is 100% of the write; coreWrite is 60% *of parse*, not of the write.
    expect(s.shares.parse).toBeCloseTo(1)
    expect(s.shares.coreWrite).toBeCloseTo(0.6)
    expect(s.unattributedMs).toBe(0)
    expect(s.parseUnattributedMs).toBe(0)
  })

  it('surfaces time inside writeBytes that no sub-phase covers', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    phases.start()
    phases.time('parse', () => {
      phases.time('coreWrite', () => { now += 7 })
      now += 3 // work inside writeBytes that no sub-phase wraps
    })
    expect(phases.snapshot().parseUnattributedMs).toBe(3)
  })

  it('states each phase as a share of the whole write, and reconciles', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    phases.start()
    const started = phases.now()
    phases.time('scan', () => { now += 6 })
    phases.time('parse', () => { now += 3 })
    now += 1 // work inside write that no phase wraps
    phases.recordWrite(262144, phases.now() - started)

    const s = phases.snapshot()
    expect(s.writeMs).toBe(10)
    expect(s.shares.scan).toBeCloseTo(0.6)
    expect(s.shares.parse).toBeCloseTo(0.3)
    // The gap is surfaced rather than absorbed into a phase.
    expect(s.unattributedMs).toBe(1)
    const claimed = phases.PHASES.reduce((a, p) => a + s.totals[p], 0)
    expect(claimed + s.unattributedMs).toBeCloseTo(s.writeMs)
  })

  it('reports throughput from time actually spent inside write', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    phases.start()
    const started = phases.now()
    phases.time('parse', () => { now += 1000 })
    phases.recordWrite(10 * 1048576, phases.now() - started)
    expect(phases.snapshot().bytesPerSec).toBeCloseTo(10 * 1048576)
  })

  it('ranks the report by cost, so the line to act on is first', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    phases.start()
    const started = phases.now()
    phases.time('parse', () => { now += 2 })
    phases.time('scan', () => { now += 8 })
    phases.recordWrite(1000, phases.now() - started)

    const report = phases.formatReport()
    expect(report.indexOf('scan')).toBeLessThan(report.indexOf('parse'))
    expect(report).toContain('80.0%')
  })

  /**
   * A buffered write enters no phase at all, so the throughput line divides
   * bytes that arrived by time nobody spent parsing them. That is how a figure
   * roughly 3x too fast reached the published findings, and the report has to
   * say so before anyone reads the rate.
   */
  describe('bytes that were never parsed', () => {
    it('stays silent when every byte reached the parser', () => {
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      phases.start()
      const started = phases.now()
      phases.time('parse', () => { now += 10 })
      phases.recordWrite(1048576, phases.now() - started)
      expect(phases.snapshot().unparsedBytes).toBe(0)
      expect(phases.formatReport()).not.toContain('INVALID')
    })

    it('disqualifies the run above the breakdown, not below it', () => {
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      phases.start()
      const started = phases.now()
      phases.recordUnparsed(3 * 1048576)
      phases.time('parse', () => { now += 10 })
      phases.recordWrite(4 * 1048576, phases.now() - started)

      const report = phases.formatReport()
      expect(phases.snapshot().unparsedBytes).toBe(3 * 1048576)
      expect(report).toContain('INVALID')
      expect(report).toContain('75.0%')
      // Ahead of the phase rows, so the rate is never read on its own.
      expect(report.indexOf('INVALID')).toBeLessThan(report.indexOf('parse'))
    })

    it('records nothing when disabled', () => {
      phases.recordUnparsed(1048576)
      expect(phases.snapshot().unparsedBytes).toBe(0)
    })

    it('clears on start, so a good run cannot inherit a bad one\'s flag', () => {
      phases.start()
      phases.recordUnparsed(1048576)
      phases.start()
      expect(phases.snapshot().unparsedBytes).toBe(0)
    })
  })

  /**
   * A throughput figure with no record of the state that produced it is what
   * let a 2.6x page-session difference go unnoticed. The context line is only
   * useful if it sits beside the rate and cannot be lost.
   */
  describe('page context', () => {
    afterEach(() => phases.setContext(null))

    it('prints the supplied state next to the throughput, above the phases', () => {
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      phases.setContext(() => 'page: 3 live engine(s), 3 terminal(s), 48.0 MB WASM linear memory')
      phases.start()
      const started = phases.now()
      phases.time('parse', () => { now += 10 })
      phases.recordWrite(1048576, phases.now() - started)

      const report = phases.formatReport()
      expect(report).toContain('3 live engine(s)')
      expect(report.indexOf('live engine')).toBeLessThan(report.indexOf('parse'))
    })

    it('omits the line entirely when nobody supplies one', () => {
      phases.start()
      phases.recordWrite(1024, 1)
      expect(phases.formatReport()).not.toContain('page:')
    })

    it('survives start(), which clears counters and not the supplier', () => {
      phases.setContext(() => 'page: still here')
      phases.start()
      phases.recordWrite(1024, 1)
      expect(phases.formatReport()).toContain('still here')
    })
  })

  it('says so plainly when nothing was recorded', () => {
    expect(phases.formatReport()).toContain('call start()')
  })

  it('start() clears anything left from a previous run', () => {
    phases.start()
    phases.time('parse', () => {})
    expect(phases.snapshot().calls.parse).toBe(1)
    phases.start()
    expect(phases.snapshot().calls.parse).toBe(0)
  })
})
