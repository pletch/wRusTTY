/**
 * Reporting half of the delivery recorder: backend correlation, formatting,
 * and the `__wrusttyDelivery` devtools handle. Separate from
 * `deliveryStats.ts` (the hot-path recorder) so release bundles don't carry
 * it; `main.tsx` imports it dynamically behind a build flag. Nothing in
 * `deliveryStats.ts` imports this.
 */
import { invoke } from '@tauri-apps/api/core'
import * as writePhases from './writePhases'
import {
  type BackendDeliveryStats,
  type DeliverySnapshot,
  type IdleGap,
  reset,
  snapshot,
  start,
  stop,
} from './deliveryStats'

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
 * Why the frontend was idle across its longest starved window. With frame
 * gaps under ~2 refreshes the thread was servicing frames and simply had no
 * bytes (an upstream stall); with frames mostly absent, it was blocked.
 */
function idleReading(idleMs: number, frames: number, maxFrameGapMs: number): string {
  if (frames === 0 && idleMs > 33) return 'MAIN THREAD BLOCKED (no frames at all)'
  if (maxFrameGapMs > idleMs * 0.5) return 'MAIN THREAD BLOCKED for most of it'
  if (maxFrameGapMs < 33) return 'thread was FREE — bytes were not delivered'
  return 'mixed — thread stalled for part of the window'
}

/** The same reading in a few characters, for the per-gap list. */
function shortReading(g: IdleGap): string {
  if (g.framesDuring === 0 && g.ms > 33) return 'BLOCKED'
  if (g.maxFrameGapMs > g.ms * 0.5) return 'BLOCKED'
  if (g.maxFrameGapMs < 33) return 'free'
  return 'mixed'
}

/**
 * Both ends of the path as one report, with the verdict spelled out.
 */
export function formatReport(front: DeliverySnapshot, back: BackendDeliveryStats | null): string {
  const lines: string[] = []
  lines.push('=== delivery path ===')
  if (back && back.flushes > 0) {
    lines.push(
      `backend (coalesce.rs)  ${back.flushes} flushes, ${mb(back.bytes)} in ${back.spanMs.toFixed(0)} ms => ${mbs(back.bytesPerSec)}`,
    )
    lines.push(`                       flush size ${kb(back.minBytes)} min / ${kb(back.maxBytes)} max`)
    if (front.warmupMs > 0 && back.spanMs > front.warmupMs) {
      lines.push(
        `                       ${mbs((back.bytes / (back.spanMs - front.warmupMs)) * 1000)} excluding the same warm-up`,
      )
    }
  } else {
    lines.push('backend (coalesce.rs)  no flushes recorded (reset, or not a live session)')
  }
  lines.push(
    `frontend (received)    ${front.count} deliveries, ${mb(front.bytes)} in ${front.spanMs.toFixed(0)} ms => ${mbs(front.bytesPerSec)}`,
  )
  lines.push(
    `                       size ${kb(front.minBytes)} min / ${kb(front.medianBytes)} median / ${kb(front.p95Bytes)} p95 / ${kb(front.maxBytes)} max`,
  )
  if (front.warmupMs > 0) {
    lines.push(
      `active window          ${mb(front.activeBytes)} in ${front.activeSpanMs.toFixed(0)} ms => ${mbs(front.activeBytesPerSec)} (${front.warmupMs.toFixed(0)} ms warm-up excluded)`,
    )
  }
  lines.push(
    `engine (write)         ${front.activeParseMs.toFixed(0)} ms total = ${(front.activeParseShare * 100).toFixed(1)}% of the active window`,
  )
  lines.push(
    `                       per delivery ${front.medianParseMs.toFixed(2)} median / ${front.p95ParseMs.toFixed(2)} p95 / ${front.maxParseMs.toFixed(2)} max ms`,
  )
  lines.push(
    `idle (no bytes in)     longest ${front.maxIdleMs.toFixed(1)} ms; total ${front.totalIdleMs.toFixed(0)} ms = ${(front.idleShare * 100).toFixed(1)}% of the active window`,
  )
  if (front.pacedMs > 0) {
    // Separate: the frontend choosing to wait and the producer having nothing
    // look identical between deliveries.
    const pacedShare = front.activeSpanMs > 0 ? (front.pacedMs / front.activeSpanMs) * 100 : 0
    const starvedShare = front.activeSpanMs > 0 ? (front.starvedMs / front.activeSpanMs) * 100 : 0
    lines.push(
      `                       of which ${front.pacedMs.toFixed(0)} ms (${pacedShare.toFixed(1)}%) was the write scheduler pacing to a frame — deliberate, not starvation`,
      `                       leaving ${front.starvedMs.toFixed(0)} ms (${starvedShare.toFixed(1)}%) genuinely waiting on the producer`,
    )
  }
  // By clock time and byte offset: a periodic pause and one at a fixed point in
  // the stream look alike in a total.
  for (const g of front.topGaps) {
    lines.push(
      `                       ${g.ms.toFixed(1).padStart(8)} ms @ ${(g.atMs / 1000).toFixed(2)} s / ${mb(g.afterBytes)} in (${shortReading(g)})`,
    )
  }
  if (front.maxFrameGapMs > 0) {
    lines.push(
      `main thread (rAF)      worst frame gap ${front.maxFrameGapMs.toFixed(1)} ms over the run`,
    )
    lines.push(
      `                       during the longest idle gap: ${front.framesDuringMaxIdle} frames, worst ${front.maxFrameGapInIdleMs.toFixed(1)} ms => ${idleReading(front.maxIdleMs, front.framesDuringMaxIdle, front.maxFrameGapInIdleMs)}`,
    )
  } else {
    lines.push('main thread (rAF)      not sampled (no animation frames recorded)')
  }

  // Coarse thresholds: a pointer at where to look, not a measurement. The
  // backend's clock starts at the same command echo, so its span has the same
  // warm-up removed before comparing rates.
  const backActiveMs = back ? back.spanMs - front.warmupMs : 0
  const backRate = back && backActiveMs > 0 ? back.bytes / (backActiveMs / 1000) : 0
  // Pacing is removed first; left in, it would lower both the parse share and
  // the delivery rate, so deliberate yielding would read as falling behind.
  const workingMs = Math.max(1, front.activeSpanMs - front.pacedMs)
  const workingParseShare = front.activeParseMs / workingMs
  const workingBytesPerSec = front.activeBytes / (workingMs / 1000)
  let verdict: string
  if (front.count === 0) {
    verdict = 'no deliveries recorded — call start() before the run'
  } else if (workingParseShare > 0.7) {
    verdict = 'ENGINE-BOUND — the frontend spent most of the drain inside the parser'
  } else if (backRate > workingBytesPerSec * 1.25) {
    verdict = 'IPC/FRONTEND-BOUND — the backend sent faster than the frontend took delivery'
  } else {
    verdict = 'UPSTREAM-BOUND — the frontend was mostly idle waiting on transport/coalescer'
  }
  if (front.pacedMs > 0) {
    verdict += ` (judged on the ${workingMs.toFixed(0)} ms it was actually working, pacing excluded)`
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
    // No Tauri backend (a plain browser); the frontend half still stands.
  }
  // The phase breakdown subdivides this report's `engine` line, so both come
  // from one call.
  const text = `${formatReport(snapshot(), back)}\n${writePhases.formatReport()}`
  console.log(text)
  return text
}

/**
 * Arms both ends of the recorder together, as the on-screen instrument and
 * the devtools handle both must: a report from a recording frontend and an
 * idle backend is silently wrong.
 */
export async function startRecording(): Promise<void> {
  start()
  writePhases.start()
  try {
    await resetBackendStats()
  } catch {
    /* no backend in a plain browser context */
  }
}

export function stopRecording(): void {
  stop()
  writePhases.stop()
}

/** Exposes the recorder on `globalThis` for measuring from devtools. */
export function install(): void {
  ;(globalThis as Record<string, unknown>).__wrusttyDelivery = {
    start: async () => {
      await startRecording()
      return 'recording — reproduce the flood, then call __wrusttyDelivery.report()'
    },
    stop: stopRecording,
    reset: () => {
      reset()
      writePhases.reset()
    },
    snapshot,
    phases: writePhases.snapshot,
    backendStats,
    report,
  }
}
