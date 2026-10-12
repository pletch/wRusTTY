import { describe, it, expect } from 'vitest'
import { coalescedDeliveries, COALESCE_THRESHOLD } from './workloads'

/**
 * The delivery model decides what the flood-stress rows measure, so the
 * properties that make it a model of `coalesce.rs` are asserted: the flush
 * threshold is a floor, and each flush carries the overshoot of the read
 * that crossed it.
 */
describe('coalescedDeliveries', () => {
  const TOTAL = 8 * 1024 * 1024

  it('never emits a delivery below the flush threshold, except the last', () => {
    const sizes = coalescedDeliveries(TOTAL, COALESCE_THRESHOLD)
    for (const s of sizes.slice(0, -1)) expect(s).toBeGreaterThanOrEqual(COALESCE_THRESHOLD)
    // The tail is whatever remained at the end (flushed on the tick or close).
    expect(sizes[sizes.length - 1]).toBeGreaterThan(0)
  })

  it('emits deliveries larger than the threshold — the point of the fix', () => {
    const sizes = coalescedDeliveries(TOTAL, COALESCE_THRESHOLD)
    const oversized = sizes.filter((s) => s > COALESCE_THRESHOLD)
    // All-exactly-threshold would be a feed the app never produces.
    expect(oversized.length).toBeGreaterThan(sizes.length * 0.5)
    expect(Math.max(...sizes)).toBeGreaterThan(COALESCE_THRESHOLD)
  })

  it('bounds the overshoot by one upstream read', () => {
    const sizes = coalescedDeliveries(TOTAL, COALESCE_THRESHOLD)
    // A flush exceeds the threshold only by the read that crossed it.
    const MAX_READ = 32 * 1024
    for (const s of sizes) expect(s).toBeLessThanOrEqual(COALESCE_THRESHOLD + MAX_READ)
  })

  it('accounts for every byte exactly once', () => {
    // Dropped or duplicated bytes would feed the engines different content.
    for (const total of [TOTAL, 1, 32 * 1024, 100 * 1024 * 1024]) {
      const sizes = coalescedDeliveries(total, COALESCE_THRESHOLD)
      expect(sizes.reduce((n, s) => n + s, 0)).toBe(total)
    }
  })

  it('is deterministic, so both engines get the identical sequence', () => {
    // Same bytes, boundaries and order for both engines and every round.
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
    // The real coalescer emits meaningfully fewer deliveries than fixed
    // threshold-sized writes would.
    const sizes = coalescedDeliveries(TOTAL, COALESCE_THRESHOLD)
    const oldFixedCount = Math.ceil(TOTAL / COALESCE_THRESHOLD)
    expect(sizes.length).toBeLessThan(oldFixedCount)
    const mean = TOTAL / sizes.length
    expect(mean).toBeGreaterThan(COALESCE_THRESHOLD)
  })
})
