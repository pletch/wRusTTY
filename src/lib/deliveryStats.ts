import { invoke } from '@tauri-apps/api/core'

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
let maxIdle = 0
let parseTotal = 0

/** Bounds memory if instrumentation is left on for a long session: a 100 MB
 *  flood is only a few thousand deliveries, so this is generous, but an
 *  overnight `tail -f` should not accumulate forever. Once full, the arrays
 *  stop growing and the distribution describes the first N deliveries. */
const MAX_SAMPLES = 100_000

export function start(): void {
  reset()
  enabled = true
}

export function stop(): void {
  enabled = false
}

export function reset(): void {
  sizes = []
  parses = []
  firstAt = 0
  lastEndAt = 0
  lastAt = 0
  maxIdle = 0
  parseTotal = 0
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
  if (lastEndAt > 0) {
    const idle = t0 - lastEndAt
    if (idle > maxIdle) maxIdle = idle
  }
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
    }
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))
  return sorted[i]
}

export function snapshot(): DeliverySnapshot {
  const bySize = [...sizes].sort((a, b) => a - b)
  const byParse = [...parses].sort((a, b) => a - b)
  const spanMs = lastAt > firstAt ? lastAt - firstAt : 0
  const bytes = sizes.reduce((n, s) => n + s, 0)
  return {
    count: sizes.length,
    bytes,
    spanMs,
    bytesPerSec: spanMs > 0 ? bytes / (spanMs / 1000) : 0,
    parseMs: parseTotal,
    parseShare: spanMs > 0 ? parseTotal / spanMs : 0,
    minBytes: bySize[0] ?? 0,
    medianBytes: quantile(bySize, 0.5),
    p95Bytes: quantile(bySize, 0.95),
    maxBytes: bySize[bySize.length - 1] ?? 0,
    medianParseMs: quantile(byParse, 0.5),
    p95ParseMs: quantile(byParse, 0.95),
    maxParseMs: byParse[byParse.length - 1] ?? 0,
    maxIdleMs: maxIdle,
  }
}

export function backendStats(): Promise<BackendDeliveryStats> {
  return invoke<BackendDeliveryStats>('delivery_stats')
}

export function resetBackendStats(): Promise<void> {
  return invoke<void>('reset_delivery_stats')
}

const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`
const mbs = (n: number) => `${(n / 1048576).toFixed(1)} MB/s`
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`

/**
 * Both ends of the path as one report, with the verdict spelled out rather
 * than left to be inferred from six numbers.
 */
export function formatReport(front: DeliverySnapshot, back: BackendDeliveryStats | null): string {
  const lines: string[] = []
  lines.push('=== delivery path ===')
  if (back && back.flushes > 0) {
    lines.push(
      `backend (coalesce.rs)  ${back.flushes} flushes, ${mb(back.bytes)} in ${back.spanMs.toFixed(0)} ms => ${mbs(back.bytesPerSec)}`,
    )
    lines.push(`                       flush size ${kb(back.minBytes)} min / ${kb(back.maxBytes)} max`)
  } else {
    lines.push('backend (coalesce.rs)  no flushes recorded (reset, or not a live session)')
  }
  lines.push(
    `frontend (received)    ${front.count} deliveries, ${mb(front.bytes)} in ${front.spanMs.toFixed(0)} ms => ${mbs(front.bytesPerSec)}`,
  )
  lines.push(
    `                       size ${kb(front.minBytes)} min / ${kb(front.medianBytes)} median / ${kb(front.p95Bytes)} p95 / ${kb(front.maxBytes)} max`,
  )
  lines.push(
    `engine (write)         ${front.parseMs.toFixed(0)} ms total = ${(front.parseShare * 100).toFixed(1)}% of wall time`,
  )
  lines.push(
    `                       per delivery ${front.medianParseMs.toFixed(2)} median / ${front.p95ParseMs.toFixed(2)} p95 / ${front.maxParseMs.toFixed(2)} max ms`,
  )
  lines.push(`idle (starved)         longest gap between deliveries ${front.maxIdleMs.toFixed(1)} ms`)

  // The reading, stated. These thresholds are deliberately coarse: this is a
  // pointer at where to look next, not a measurement in its own right.
  let verdict: string
  if (front.count === 0) {
    verdict = 'no deliveries recorded — call start() before the run'
  } else if (front.parseShare > 0.7) {
    verdict = 'ENGINE-BOUND — the frontend spent most of the drain inside the parser'
  } else if (back && back.bytesPerSec > front.bytesPerSec * 1.25) {
    verdict = 'IPC/FRONTEND-BOUND — the backend sent faster than the frontend took delivery'
  } else {
    verdict = 'UPSTREAM-BOUND — the frontend was mostly idle waiting on transport/coalescer'
  }
  lines.push(`verdict                ${verdict}`)
  return lines.join('\n')
}

/**
 * One call to run from devtools during a real session:
 * `await __wrusttyDelivery.start()`, produce a flood, then
 * `await __wrusttyDelivery.report()`.
 */
export async function report(): Promise<string> {
  let back: BackendDeliveryStats | null = null
  try {
    back = await backendStats()
  } catch {
    // Browser/dev-server context with no Tauri backend — the frontend half is
    // still worth having on its own.
  }
  const text = formatReport(snapshot(), back)
  console.log(text)
  return text
}

/** Exposed so a live session can be measured from devtools without a UI. */
export function install(): void {
  ;(globalThis as Record<string, unknown>).__wrusttyDelivery = {
    start: async () => {
      start()
      try {
        await resetBackendStats()
      } catch {
        /* no backend in a plain browser context */
      }
      return 'recording — reproduce the flood, then call __wrusttyDelivery.report()'
    },
    stop,
    reset,
    snapshot,
    backendStats,
    report,
  }
}
