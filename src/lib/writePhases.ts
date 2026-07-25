/**
 * Splits a terminal write into its phases, so "the engine is slow" can be
 * attributed to a part of the engine.
 *
 * The delivery-path recorder (`deliveryStats`) times `engine.write` as one
 * span. That was enough to establish a local flood is engine-bound, and no
 * further: it left a 2.7x gap between what the same Ghostty WASM parses in the
 * benchmark harness (~88 MB/s) and what it manages in a live pane (~31 MB/s),
 * with no way to say which part of the write differed. This times the parts.
 *
 * Off by default and free when off — `time` calls straight through without
 * reading a clock — because these wrap the hottest path in the app.
 */

export const PHASES = ['scan', 'parse', 'drain', 'bufferChange', 'handlers'] as const
export type Phase = (typeof PHASES)[number]

/** What each phase covers, for the report — the names alone are too terse to
 *  act on, and the point of this module is telling someone where to look. */
const PHASE_HELP: Record<Phase, string> = {
  scan: 'scanOsc over every byte, in JS (only when an OSC/bell handler is registered)',
  parse: 'writeBytes into the WASM core — the parser itself',
  drain: 'readResponse loop, replies the core owes the host',
  bufferChange: 'asking the core whether the screen buffer flipped',
  handlers: 'onWriteParsed / OSC / bell callbacks',
}

let enabled = false
let totals = blank()
let calls = blank()
let writes = 0
let bytes = 0
let writeMs = 0

function blank(): Record<Phase, number> {
  return { scan: 0, parse: 0, drain: 0, bufferChange: 0, handlers: 0 }
}

export function start(): void {
  reset()
  enabled = true
}

export function stop(): void {
  enabled = false
}

export function reset(): void {
  totals = blank()
  calls = blank()
  writes = 0
  bytes = 0
  writeMs = 0
}

export function isEnabled(): boolean {
  return enabled
}

/**
 * Runs `fn` — always — attributing its duration to `phase` when recording.
 *
 * Phases nest in one place only: `parse` and `bufferChange` are called from
 * inside the scan-and-dispatch path, and are deliberately *not* wrapped by an
 * enclosing phase there, so each byte of work is counted once.
 */
export function time<T>(phase: Phase, fn: () => T): T {
  if (!enabled) return fn()
  const t0 = performance.now()
  try {
    return fn()
  } finally {
    totals[phase] += performance.now() - t0
    calls[phase]++
  }
}

/** Clock read that costs nothing when recording is off, for callers timing a
 *  whole write around the phases inside it. */
export function now(): number {
  return enabled ? performance.now() : 0
}

export function recordWrite(byteLength: number, ms: number): void {
  if (!enabled) return
  writes++
  bytes += byteLength
  writeMs += ms
}

export interface PhaseSnapshot {
  writes: number
  bytes: number
  /** Total time inside `write`, and the throughput that implies. */
  writeMs: number
  bytesPerSec: number
  /** Per phase: total ms, share of `writeMs`, and how many times it ran. */
  totals: Record<Phase, number>
  shares: Record<Phase, number>
  calls: Record<Phase, number>
  /** Time inside `write` that no phase claimed. A large value means the cost
   *  is somewhere these wrappers do not cover, which is itself a finding. */
  unattributedMs: number
}

export function snapshot(): PhaseSnapshot {
  const shares = blank()
  let claimed = 0
  for (const p of PHASES) {
    claimed += totals[p]
    shares[p] = writeMs > 0 ? totals[p] / writeMs : 0
  }
  return {
    writes,
    bytes,
    writeMs,
    bytesPerSec: writeMs > 0 ? bytes / (writeMs / 1000) : 0,
    totals: { ...totals },
    shares,
    calls: { ...calls },
    unattributedMs: Math.max(0, writeMs - claimed),
  }
}

const mbs = (n: number) => `${(n / 1048576).toFixed(1)} MB/s`

export function formatReport(s: PhaseSnapshot = snapshot()): string {
  const lines: string[] = ['=== write phases ===']
  if (s.writes === 0) {
    lines.push('no writes recorded — call start() before the run')
    return lines.join('\n')
  }
  lines.push(
    `${s.writes} writes, ${(s.bytes / 1048576).toFixed(2)} MB, ${s.writeMs.toFixed(0)} ms inside write => ${mbs(s.bytesPerSec)}`,
  )
  // Ordered by cost, because the first line is the one worth acting on.
  const ranked = [...PHASES].sort((a, b) => s.totals[b] - s.totals[a])
  for (const p of ranked) {
    lines.push(
      `  ${p.padEnd(13)} ${s.totals[p].toFixed(0).padStart(6)} ms  ${(s.shares[p] * 100).toFixed(1).padStart(5)}%  ${String(s.calls[p]).padStart(7)} calls   ${PHASE_HELP[p]}`,
    )
  }
  lines.push(
    `  ${'unattributed'.padEnd(13)} ${s.unattributedMs.toFixed(0).padStart(6)} ms  ${(s.writeMs > 0 ? (s.unattributedMs / s.writeMs) * 100 : 0).toFixed(1).padStart(5)}%`,
  )
  return lines.join('\n')
}
