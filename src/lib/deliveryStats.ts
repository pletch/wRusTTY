/**
 * Receive-side instrumentation for the real PTY delivery path.
 *
 * The engine benchmarks in `src/bench` measure a parser against a buffer that
 * is already in the webview. They cannot see the half of a flood that happens
 * before that — transport read, coalescer, IPC hop — so they cannot say whether
 * a slow `cat` is the terminal engine's fault or the pipeline's. This records
 * the frontend end of the real path; `coalesce.rs` records the backend end
 * (`delivery_stats`), and the two together locate the ceiling:
 *
 *   - backend B/s ≈ frontend B/s, parse share high  → the engine is the limit
 *   - backend B/s ≈ frontend B/s, parse share low   → upstream is the limit
 *     (transport or coalescer); the frontend is idle waiting for bytes
 *   - backend B/s  > frontend B/s                   → the IPC hop or the
 *     frontend's own event loop is the limit, and the backend is running ahead
 *
 * Off by default and free when off: `record` runs the callback and returns,
 * touching no clock. Enabling costs two `performance.now()` calls per delivery,
 * of which there are a few thousand across a 100 MB flood.
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
  /** Per-delivery time inside the engine, ms. `maxParseMs` is the closest
   *  thing to a real user-visible stall this records. */
  medianParseMs: number
  p95ParseMs: number
  maxParseMs: number
  /** Longest gap between the end of one delivery and the start of the next.
   *  A large value means the frontend was starved, not busy. */
  maxIdleMs: number
  /** Longest gap between consecutive animation frames over the whole run.
   *  rAF stops firing exactly when the main thread is blocked, so this is the
   *  perceived freeze regardless of what caused it. */
  maxFrameGapMs: number
  /** The same two numbers restricted to the single longest idle gap above.
   *  This is the pair that separates the two reasons the frontend can sit
   *  there with no bytes: if frames kept firing across the window the main
   *  thread was free and the bytes were not delivered (transport/IPC stall);
   *  if frames stopped too, the thread was blocked and could not take
   *  delivery. */
  framesDuringMaxIdle: number
  maxFrameGapInIdleMs: number
  /**
   * The run with its warm-up removed — the numbers to reason from.
   *
   * A flood is started by typing a command, so the first delivery is the
   * shell's echo of it and the bulk arrives only once the producer has spun
   * up. Measured on `yes | head -c 100000000`, that wait was ~1.0 s, and
   * counting it made a local flood read 19.1 MB/s instead of 24.0 and pulled
   * the parse share under the threshold that decides the verdict. It is not
   * app latency and does not belong in either.
   *
   * The window opens at the first delivery of at least half the median size:
   * echo and prompt are tiny next to a coalesced flood delivery, so the split
   * is unambiguous in the case that matters and degrades to "no warm-up" when
   * deliveries are uniform.
   */
  warmupMs: number
  activeSpanMs: number
  activeBytes: number
  activeBytesPerSec: number
  activeParseMs: number
  activeParseShare: number
  /** Every idle window summed, and its share of `spanMs`. `maxIdleMs` alone
   *  cannot distinguish one long stall from a run of medium ones, and the two
   *  imply different causes — so the total is what says how much of the
   *  shortfall is stalls at all, rather than steady per-delivery overhead. */
  totalIdleMs: number
  idleShare: number
  /**
   * Of `totalIdleMs`, how much the frontend spent waiting on purpose.
   *
   * `writeScheduler` holds bytes back once a frame's write budget is spent, so
   * the window can render. Those waits sit between deliveries and are
   * indistinguishable, from here, from a producer with nothing to send — which
   * is how a deliberate pause came to be reported as `idle (starved) …
   * BLOCKED` with the verdict blaming the frontend for a delay it chose. The
   * scheduler reports its own waits so the two can be told apart.
   */
  pacedMs: number
  /** Idle that was not self-imposed — the real wait on the producer. */
  starvedMs: number
  /** The largest gaps, longest first. */
  topGaps: IdleGap[]
}

/**
 * One window where the frontend had no bytes to work on.
 *
 * Located as well as sized, because the two candidate explanations for a long
 * gap predict different locations: a pause that recurs on a timer lands at
 * unrelated byte offsets across runs, while one tripped by a buffer or
 * allocation threshold lands at the same `afterBytes` every time.
 */
export interface IdleGap {
  ms: number
  /** Offset from the first delivery of the run, ms. */
  atMs: number
  /** Bytes already delivered when the gap began. */
  afterBytes: number
  /** rAF activity inside this specific window — the same blocked/free
   *  discrimination as `maxFrameGapInIdleMs`, per gap. */
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
/** Per delivery, aligned with `sizes`: when it started (offset from the first
 *  delivery) and how long the frontend had been idle immediately before it. */
let starts: number[] = []
let idles: number[] = []
let frameTimes: number[] = []
/** Time the write scheduler deliberately waited, so it is not read as
 *  starvation. See recordPaced. */
let pacedTotal = 0
let frameLoopId: number | null = null

/** Bounds memory if instrumentation is left on for a long session: a 100 MB
 *  flood is only a few thousand deliveries, so this is generous, but an
 *  overnight `tail -f` should not accumulate forever. Once full, the arrays
 *  stop growing and the distribution describes the first N deliveries. */
const MAX_SAMPLES = 100_000

/** ~90 minutes at 60 Hz. Frame timestamps are only 8 bytes each, and the loop
 *  stops with `stop()`, so this exists for the same reason as `MAX_SAMPLES`:
 *  an instrument left on overnight must not grow without bound. */
const MAX_FRAMES = 320_000

/**
 * Free-running rAF loop, live only while recording.
 *
 * It records nothing but frame arrival times. That is enough, because the
 * browser cannot deliver a frame while the main thread is busy: a gap in this
 * series *is* a main-thread stall, whatever produced it (parse, GC, layout).
 * Pairing it with the delivery series is what distinguishes "the frontend was
 * blocked" from "the frontend had nothing to do".
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
 * Records a wait the frontend imposed on itself — see `writeScheduler`.
 *
 * Without this the report cannot tell a scheduler holding bytes back from a
 * producer with none to send, and calls both starvation.
 */
export function recordPaced(ms: number): void {
  if (!enabled) return
  pacedTotal += ms
}

/** Injects a frame series without a real rAF loop, so the correlation logic is
 *  testable in a headless run. Timestamps share `performance.now()`'s origin,
 *  as rAF's do. */
export function recordFrameForTest(t: number): void {
  frameTimes.push(t)
}

export function isEnabled(): boolean {
  return enabled
}

/**
 * Runs `write` — always — and times it when instrumentation is on.
 *
 * Shaped as a wrapper rather than a pair of `mark` calls so the caller cannot
 * accidentally time a different span than the one that matters, and so the
 * disabled path is a single branch with no clock reads.
 */
export function record<T>(bytes: number, write: () => T): T {
  if (!enabled) return write()
  const t0 = performance.now()
  if (firstAt === 0) firstAt = t0
  // Gap since the previous delivery finished: time the frontend spent with
  // nothing to do, which is the signature of an upstream bottleneck.
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

/** Largest gap between consecutive frames, over the whole series or over a
 *  window. Frames bounding the window are included so a stall that starts
 *  before `from` and ends after it is still seen. */
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

/** How many gaps the report enumerates. Enough to see whether the idle time is
 *  one event or a pattern, without turning the report into a log. */
const TOP_GAPS = 5

/** The largest idle windows, each located in time and in the byte stream and
 *  annotated with what the main thread was doing across it. */
function topIdleGaps(from: number): IdleGap[] {
  // Bytes delivered before each index, so a gap can be placed in the stream
  // and not just on the clock.
  const before: number[] = []
  let running = 0
  for (const s of sizes) {
    before.push(running)
    running += s
  }
  return idles
    .map((ms, i) => ({ ms, i }))
    // Gaps inside the warm-up are not stalls in the run — leaving them in put
    // the startup wait at the top of the list, where it crowded out the
    // millisecond-scale stalls the list exists to surface.
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
 * Index of the first delivery that is bulk rather than warm-up, and the idle
 * that preceded it.
 *
 * Returns index 0 when nothing qualifies as warm-up, which is the common case
 * for a steady stream and for any synthetic run of uniform deliveries.
 */
function activeStart(medianBytes: number): { index: number; warmupMs: number } {
  const bulk = medianBytes / 2
  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i] >= bulk) {
      // Everything before the window, not just the gap immediately preceding
      // it: a real run opened with an echo, a long wait, *another* small
      // delivery, and then bulk, so charging only the last gap reported 11 ms
      // of warm-up where 2258 ms had been excluded — and understated the
      // backend's rate threefold, since the same figure corrects its span.
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
  // Idle is measured over the active window too — otherwise the warm-up wait
  // dominates the total and the share describes startup, not the flood.
  const idleTotal = idles.slice(from + 1).reduce((n, ms) => n + ms, 0)
  const gaps = topIdleGaps(from)
  const activeBytes = sizes.slice(from).reduce((n, s) => n + s, 0)
  const activeParseMs = parses.slice(from).reduce((n, ms) => n + ms, 0)
  // `starts[from]` already covers the echo delivery and the warm-up gap that
  // followed it, so the active window is simply what remains of the span.
  const activeSpanMs = Math.max(0, spanMs - (starts[from] ?? 0))
  const allFrames = frameGaps()
  // The longest gap and its frame correlation both come from the ranked list,
  // so there is one definition of "worst stall" rather than two that can
  // disagree about whether the warm-up counts.
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
    // Capped at the idle actually observed: the scheduler's clock and this
    // one are the same, but a wait that straddles the warm-up boundary would
    // otherwise report more pacing than there was idle to account for.
    pacedMs: Math.min(pacedTotal, idleTotal),
    starvedMs: Math.max(0, idleTotal - pacedTotal),
    topGaps: gaps,
  }
}
