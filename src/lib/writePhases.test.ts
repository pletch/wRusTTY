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
    const claimed = Object.values(s.totals).reduce((a, b) => a + b, 0)
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
