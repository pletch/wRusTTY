import { describe, it, expect } from 'vitest'
import { coalescedDeliveries, COALESCE_THRESHOLD } from './workloads'

/**
 * The delivery model decides what the flood-stress rows actually measure, so
 * the properties that make it a model of `coalesce.rs` rather than a guess are
 * asserted here.
 *
 * The bug this replaced: the feed used fixed 32 KB writes, on the belief that
 * 32 KB was the largest buffer the app ever hands over. It is the *smallest*.
 * `coalesce.rs` appends each upstream read to a buffer and flushes once it
 * reaches the threshold, so the flush carries the overshoot too. Feeding exact
 * 32 KB understated every delivery, and since a 32 KB parse fits inside a
 * frame for either engine, the stall metric floored at the refresh interval
 * and stopped being able to tell them apart at all.
 */
describe('coalescedDeliveries', () => {
  const TOTAL = 8 * 1024 * 1024

  it('never emits a delivery below the flush threshold, except the last', () => {
    const sizes = coalescedDeliveries(TOTAL, COALESCE_THRESHOLD)
    for (const s of sizes.slice(0, -1)) expect(s).toBeGreaterThanOrEqual(COALESCE_THRESHOLD)
    // The tail is whatever remained when the stream ended; the Rust flushes it
    // on the interval tick or on close, and it can be any size.
    expect(sizes[sizes.length - 1]).toBeGreaterThan(0)
  })

  it('emits deliveries larger than the threshold — the point of the fix', () => {
    const sizes = coalescedDeliveries(TOTAL, COALESCE_THRESHOLD)
    const oversized = sizes.filter((s) => s > COALESCE_THRESHOLD)
    // If this ever came back all-exactly-32-KB we would be back to measuring
    // a feed the app never produces.
    expect(oversized.length).toBeGreaterThan(sizes.length * 0.5)
    expect(Math.max(...sizes)).toBeGreaterThan(COALESCE_THRESHOLD)
  })

  it('bounds the overshoot by one upstream read', () => {
    const sizes = coalescedDeliveries(TOTAL, COALESCE_THRESHOLD)
    // A flush happens the moment the buffer crosses the line, so it can only
    // exceed it by the read that crossed — not by an unbounded amount.
    const MAX_READ = 32 * 1024
    for (const s of sizes) expect(s).toBeLessThanOrEqual(COALESCE_THRESHOLD + MAX_READ)
  })

  it('accounts for every byte exactly once', () => {
    // Deliveries slice the payload; dropping or duplicating bytes would feed
    // the two engines different content and quietly invalidate the comparison.
    for (const total of [TOTAL, 1, 32 * 1024, 100 * 1024 * 1024]) {
      const sizes = coalescedDeliveries(total, COALESCE_THRESHOLD)
      expect(sizes.reduce((n, s) => n + s, 0)).toBe(total)
    }
  })

  it('is deterministic, so both engines get the identical sequence', () => {
    // The whole benchmark rests on this: same bytes, same boundaries, same
    // order for both engines and across rounds.
    expect(coalescedDeliveries(TOTAL, COALESCE_THRESHOLD)).toEqual(
      coalescedDeliveries(TOTAL, COALESCE_THRESHOLD),
    )
    expect(coalescedDeliveries(TOTAL, COALESCE_THRESHOLD, 1)).not.toEqual(
      coalescedDeliveries(TOTAL, COALESCE_THRESHOLD, 2),
    )
  })

  it('handles a payload smaller than one delivery', () => {
    expect(coalescedDeliveries(500, COALESCE_THRESHOLD)).toEqual([500])
    expect(coalescedDeliveries(0, COALESCE_THRESHOLD)).toEqual([])
  })

  it('produces far fewer, larger deliveries than the old fixed-chunk feed', () => {
    // Documents the size of the correction: the old model wrote TOTAL/32KB
    // writes; the real coalescer emits meaningfully fewer than that.
    const sizes = coalescedDeliveries(TOTAL, COALESCE_THRESHOLD)
    const oldFixedCount = Math.ceil(TOTAL / COALESCE_THRESHOLD)
    expect(sizes.length).toBeLessThan(oldFixedCount)
    const mean = TOTAL / sizes.length
    expect(mean).toBeGreaterThan(COALESCE_THRESHOLD)
  })
})
