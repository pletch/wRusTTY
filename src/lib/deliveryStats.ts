/**
 * Receive-side instrumentation for the real PTY delivery path, paired with the
 * backend's `delivery_stats` (`coalesce.rs`) to locate a throughput ceiling:
 *
 *   - backend B/s ≈ frontend B/s, parse share high  → the engine is the limit
 *   - backend B/s ≈ frontend B/s, parse share low   → upstream is the limit
 *     (transport or coalescer); the frontend waits for bytes
 *   - backend B/s  > frontend B/s                   → the IPC hop or the
 *     frontend's event loop is the limit
 *
 * Off by default and free when off; on, it costs two `performance.now()` calls
 * per delivery.
 */

export interface DeliverySnapshot {
  /** Deliveries seen (one `dataChannel` message each). */
  count: number
  bytes: number
  /** Wall time from the first delivery to the last, ms. */
  spanMs: number
  /** Bytes/sec across that span — what the frontend actually received. */
  bytesPerSec: number
  /** Total ms spent inside `engine.write`, and its share of `spanMs`. */
  parseMs: number
  parseShare: number
  /** Delivery sizes, bytes. */
  minBytes: number
  medianBytes: number
  p95Bytes: number
  maxBytes: number
  /** Per-delivery time inside the engine, ms; `maxParseMs` approximates a
   *  user-visible stall. */
  medianParseMs: number
  p95ParseMs: number
  maxParseMs: number
  /** Longest gap between deliveries; large means starved, not busy. */
  maxIdleMs: number
  /** Longest gap between animation frames (rAF stops while the main thread is
   *  blocked), i.e. the perceived freeze. */
  maxFrameGapMs: number
  /** Frame activity during the longest idle gap: frames firing means bytes
   *  weren't delivered (transport/IPC stall); frames stopping means the thread
   *  was blocked. */
  framesDuringMaxIdle: number
  maxFrameGapInIdleMs: number
  /**
   * The run with its warm-up (the shell echoing the command, the producer
   * spinning up) removed: the numbers to reason from. The active window starts
   * at the first delivery of at least half the median size.
   */
  warmupMs: number
  activeSpanMs: number
  activeBytes: number
  activeBytesPerSec: number
  activeParseMs: number
  activeParseShare: number
  /** All idle windows summed, and their share of the active span; distinguishes
   *  one long stall from many medium ones. */
  totalIdleMs: number
  idleShare: number
  /**
   * Of `totalIdleMs`, the time `writeScheduler` deliberately held bytes back so
   * the window could render, which would otherwise look like starvation.
   */
  pacedMs: number
  /** Idle that wasn't self-imposed: waiting on the producer. */
  starvedMs: number
  /** The largest gaps, longest first. */
  topGaps: IdleGap[]
}

/**
 * One window where the frontend had no bytes. Located in time and in the byte
 * stream: a timer-driven pause lands at different offsets across runs, while a
 * buffer threshold lands at the same `afterBytes`.
 */
export interface IdleGap {
  ms: number
  /** Offset from the first delivery of the run, ms. */
  atMs: number
  /** Bytes already delivered when the gap began. */
  afterBytes: number
  /** rAF activity inside this window (blocked vs free). */
  framesDuring: number
  maxFrameGapMs: number
}

/** Backend counters, mirroring `DeliveryStats` in src-tauri/src/coalesce.rs. */
export interface BackendDeliveryStats {
  flushes: number
  bytes: number
  minBytes: number
  maxBytes: number
  spanMs: number
  bytesPerSec: number
}

let enabled = false
let sizes: number[] = []
let parses: number[] = []
let firstAt = 0
let lastEndAt = 0
let lastAt = 0
let parseTotal = 0
/** Per delivery: start offset and the idle time before it. */
let starts: number[] = []
let idles: number[] = []
let frameTimes: number[] = []
/** Time the write scheduler deliberately waited; see recordPaced. */
let pacedTotal = 0
let frameLoopId: number | null = null

/** Bounds memory if left on (an overnight `tail -f`); past this the arrays stop
 *  growing. */
const MAX_SAMPLES = 100_000

/** ~90 minutes of frames at 60 Hz; bounded for the same reason. */
const MAX_FRAMES = 320_000

/**
 * Free-running rAF loop while recording, logging frame times only; a gap in
 * frames is a main-thread stall, whatever caused it.
 */
function startFrameLoop(): void {
  if (typeof requestAnimationFrame !== 'function' || frameLoopId !== null) return
  const loop = (t: number) => {
    if (frameTimes.length < MAX_FRAMES) frameTimes.push(t)
    frameLoopId = requestAnimationFrame(loop)
  }
  frameLoopId = requestAnimationFrame(loop)
}

function stopFrameLoop(): void {
  if (frameLoopId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(frameLoopId)
  }
  frameLoopId = null
}

export function start(): void {
  reset()
  enabled = true
  startFrameLoop()
}

export function stop(): void {
  enabled = false
  stopFrameLoop()
}

export function reset(): void {
  sizes = []
  parses = []
  firstAt = 0
  lastEndAt = 0
  lastAt = 0
  parseTotal = 0
  starts = []
  idles = []
  frameTimes = []
  pacedTotal = 0
}

/**
 * Records a wait the frontend imposed on itself (see `writeScheduler`).
 */
export function recordPaced(ms: number): void {
  if (!enabled) return
  pacedTotal += ms
}

/** Injects frame times for headless tests (same origin as `performance.now()`). */
export function recordFrameForTest(t: number): void {
  frameTimes.push(t)
}

export function isEnabled(): boolean {
  return enabled
}

/**
 * Runs `write` and times it when instrumentation is on. A wrapper so the timed
 * span can't be wrong and the disabled path has no clock reads.
 */
export function record<T>(bytes: number, write: () => T): T {
  if (!enabled) return write()
  const t0 = performance.now()
  if (firstAt === 0) firstAt = t0
  // Time since the previous delivery finished: idle.
  const idle = lastEndAt > 0 ? t0 - lastEndAt : 0
  try {
    return write()
  } finally {
    const t1 = performance.now()
    lastEndAt = t1
    lastAt = t1
    parseTotal += t1 - t0
    if (sizes.length < MAX_SAMPLES) {
      sizes.push(bytes)
      parses.push(t1 - t0)
      starts.push(t0 - firstAt)
      idles.push(idle)
    }
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))
  return sorted[i]
}

/** Largest gap between consecutive frames, overall or within a window
 *  (boundary frames included). */
function frameGaps(from = -Infinity, to = Infinity): { count: number; maxGapMs: number } {
  let count = 0
  let maxGap = 0
  let prev = 0
  for (const t of frameTimes) {
    if (prev > 0 && t > from && prev < to) {
      const gap = t - prev
      if (gap > maxGap) maxGap = gap
    }
    if (t >= from && t <= to) count++
    prev = t
  }
  return { count, maxGapMs: maxGap }
}

/** How many gaps the report lists. */
const TOP_GAPS = 5

/** The largest idle windows, located and annotated with main-thread activity. */
function topIdleGaps(from: number): IdleGap[] {
  // Bytes delivered before each index.
  const before: number[] = []
  let running = 0
  for (const s of sizes) {
    before.push(running)
    running += s
  }
  return idles
    .map((ms, i) => ({ ms, i }))
    // Warm-up gaps aren't stalls in the run.
    .filter((g) => g.ms > 0 && g.i > from)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, TOP_GAPS)
    .map(({ ms, i }) => {
      const atMs = starts[i] - ms
      const frames = frameGaps(firstAt + atMs, firstAt + starts[i])
      return {
        ms,
        atMs,
        afterBytes: before[i],
        framesDuring: frames.count,
        maxFrameGapMs: frames.maxGapMs,
      }
    })
}

/**
 * Index of the first bulk (non-warm-up) delivery and the warm-up time before
 * it; 0 when nothing qualifies.
 */
function activeStart(medianBytes: number): { index: number; warmupMs: number } {
  const bulk = medianBytes / 2
  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i] >= bulk) {
      // All time before the window, not just the last gap (a run may start with
      // echo, a wait, another small delivery, then bulk).
      return { index: i, warmupMs: starts[i] }
    }
  }
  return { index: 0, warmupMs: 0 }
}

export function snapshot(): DeliverySnapshot {
  const bySize = [...sizes].sort((a, b) => a - b)
  const byParse = [...parses].sort((a, b) => a - b)
  const spanMs = lastAt > firstAt ? lastAt - firstAt : 0
  const bytes = sizes.reduce((n, s) => n + s, 0)
  const medianBytes = quantile(bySize, 0.5)
  const { index: from, warmupMs } = activeStart(medianBytes)
  // Idle over the active window only.
  const idleTotal = idles.slice(from + 1).reduce((n, ms) => n + ms, 0)
  const gaps = topIdleGaps(from)
  const activeBytes = sizes.slice(from).reduce((n, s) => n + s, 0)
  const activeParseMs = parses.slice(from).reduce((n, ms) => n + ms, 0)
  // `starts[from]` covers the warm-up.
  const activeSpanMs = Math.max(0, spanMs - (starts[from] ?? 0))
  const allFrames = frameGaps()
  // One definition of "worst stall", from the ranked list.
  const worst = gaps[0]
  return {
    count: sizes.length,
    bytes,
    spanMs,
    bytesPerSec: spanMs > 0 ? bytes / (spanMs / 1000) : 0,
    parseMs: parseTotal,
    parseShare: spanMs > 0 ? parseTotal / spanMs : 0,
    warmupMs,
    activeSpanMs,
    activeBytes,
    activeBytesPerSec: activeSpanMs > 0 ? activeBytes / (activeSpanMs / 1000) : 0,
    activeParseMs,
    activeParseShare: activeSpanMs > 0 ? activeParseMs / activeSpanMs : 0,
    minBytes: bySize[0] ?? 0,
    medianBytes,
    p95Bytes: quantile(bySize, 0.95),
    maxBytes: bySize[bySize.length - 1] ?? 0,
    medianParseMs: quantile(byParse, 0.5),
    p95ParseMs: quantile(byParse, 0.95),
    maxParseMs: byParse[byParse.length - 1] ?? 0,
    maxIdleMs: worst?.ms ?? 0,
    maxFrameGapMs: allFrames.maxGapMs,
    framesDuringMaxIdle: worst?.framesDuring ?? 0,
    maxFrameGapInIdleMs: worst?.maxFrameGapMs ?? 0,
    totalIdleMs: idleTotal,
    idleShare: activeSpanMs > 0 ? idleTotal / activeSpanMs : 0,
    // Capped at observed idle (a wait straddling the warm-up boundary).
    pacedMs: Math.min(pacedTotal, idleTotal),
    starvedMs: Math.max(0, idleTotal - pacedTotal),
    topGaps: gaps,
  }
}
