import { describe, it, expect } from 'vitest'
import { createWriteScheduler, type SchedulerHooks } from './writeScheduler'

/**
 * The properties that matter here are ordering, latency when idle, and the
 * bound on how long the main thread can be held. A scheduler that reordered
 * bytes would corrupt the screen rather than merely delay it, and one that
 * deferred a lone keystroke would trade a flood-only freeze for latency nobody
 * asked to pay.
 */

/**
 * A controllable clock, frame source and timer, so budgets are exact — and a
 * `write` that costs a realistic 3.5 ms, the measured median delivery.
 */
function harness(costPerWriteMs = 3.5) {
  let clock = 0
  const frames: (() => void)[] = []
  const timers: { cb: () => void; ms: number }[] = []
  const written: number[] = []

  const hooks: SchedulerHooks = {
    now: () => clock,
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: () => frames.splice(0, frames.length),
    setTimer: (cb, ms) => timers.push({ cb, ms }),
    clearTimer: () => timers.splice(0, timers.length),
  }

  const write = (bytes: Uint8Array) => {
    written.push(bytes.length)
    clock += costPerWriteMs
  }

  return {
    hooks,
    write,
    written,
    advance: (ms: number) => (clock += ms),
    /** Fires the pending animation frame, as a browser would. */
    frame: () => {
      const cb = frames.shift()
      timers.splice(0, timers.length)
      cb?.()
    },
    /** Fires the fallback timer instead, as an occluded window would. */
    timeout: () => {
      const t = timers.shift()
      frames.splice(0, frames.length)
      t?.cb()
    },
    frameCount: () => frames.length,
    timerMs: () => timers[0]?.ms,
  }
}

const chunk = (n: number) => new Uint8Array(n)

describe('writeScheduler', () => {
  /**
   * The latency guarantee. An idle terminal echoing a keystroke must not pay
   * for a mechanism that exists to bound floods, so a delivery arriving into an
   * unspent budget is written synchronously inside `push`.
   */
  it('writes a lone delivery immediately, so interactive echo is unchanged', () => {
    const h = harness()
    const s = createWriteScheduler(h.write, 10, h.hooks)
    s.push(chunk(8))
    expect(h.written).toEqual([8])
    expect(s.pending).toBe(0)
    // Nothing deferred means nothing scheduled: no frame was waited on.
    expect(h.frameCount()).toBe(0)
  })

  it('keeps writing inline while the frame has budget left', () => {
    const h = harness(3.5)
    const s = createWriteScheduler(h.write, 10, h.hooks)
    s.push(chunk(1))
    s.push(chunk(2))
    // 7 ms spent, still under 10 — both went straight through.
    expect(h.written).toEqual([1, 2])
    expect(s.pending).toBe(0)
  })

  /**
   * The measured failure: deliveries arriving faster than they can be written
   * used to run back to back for 106 ms. The budget is what bounds that.
   */
  it('stops writing once the frame budget is spent', () => {
    const h = harness(3.5)
    const s = createWriteScheduler(h.write, 10, h.hooks)
    for (let i = 1; i <= 10; i++) s.push(chunk(i))
    // 3 writes = 10.5 ms, which crosses the 10 ms budget; the rest waits.
    expect(h.written).toEqual([1, 2, 3])
    expect(s.pending).toBe(7)
    expect(h.frameCount()).toBe(1)
  })

  it('resumes on the next frame, and only then', () => {
    const h = harness()
    const s = createWriteScheduler(h.write, 10, h.hooks)
    for (let i = 1; i <= 6; i++) s.push(chunk(i))
    expect(h.written).toEqual([1, 2, 3])
    h.frame()
    expect(h.written).toEqual([1, 2, 3, 4, 5, 6])
    expect(s.pending).toBe(0)
  })

  it('never reorders, however the budget falls', () => {
    const h = harness()
    const s = createWriteScheduler(h.write, 10, h.hooks)
    for (let i = 1; i <= 12; i++) s.push(chunk(i))
    while (s.pending > 0) h.frame()
    expect(h.written).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  /**
   * WebView2 stops firing frames when the window is occluded. Holding the queue
   * for a frame that will never come would stall the session outright, and
   * there is no freeze to protect against when nothing is rendering.
   */
  it('drains without a budget when no frame arrives', () => {
    const h = harness()
    const s = createWriteScheduler(h.write, 10, h.hooks)
    for (let i = 1; i <= 12; i++) s.push(chunk(i))
    expect(s.pending).toBe(9)
    h.timeout()
    expect(s.pending).toBe(0)
    expect(h.written).toHaveLength(12)
  })

  it('waits about two frames before deciding none are coming', () => {
    const h = harness()
    const s = createWriteScheduler(h.write, 10, h.hooks)
    for (let i = 1; i <= 6; i++) s.push(chunk(i))
    expect(h.timerMs()).toBe(32)
  })

  it('drops its queue and its callbacks on dispose', () => {
    const h = harness()
    const s = createWriteScheduler(h.write, 10, h.hooks)
    const written = h.written
    for (let i = 1; i <= 12; i++) s.push(chunk(i))
    const before = written.length
    s.dispose()
    expect(s.pending).toBe(0)
    h.frame()
    // A disposed session must not write into a freed core.
    expect(written).toHaveLength(before)
    s.push(chunk(99))
    expect(written).toHaveLength(before)
  })

  it('ignores a frame budget it has already spent when new bytes arrive mid-wait', () => {
    const h = harness()
    const s = createWriteScheduler(h.write, 10, h.hooks)
    for (let i = 1; i <= 6; i++) s.push(chunk(i))
    expect(h.written).toHaveLength(3)
    // Arriving while a frame is pending must not jump the queue or the budget.
    s.push(chunk(99))
    expect(h.written).toHaveLength(3)
    expect(s.pending).toBe(4)
  })
})
