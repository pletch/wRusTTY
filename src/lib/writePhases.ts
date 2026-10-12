/**
 * Splits a terminal write into phases, so "the engine is slow" can be
 * attributed to a part of it. `deliveryStats` times `engine.write` as one
 * span; this times the parts, with sub-phases inside `writeBytes`.
 *
 * Off by default and free when off (`time` calls straight through without a
 * clock read), since it wraps the hottest path in the app.
 */

/** Phases of `write`. These partition it, so they reconcile against the whole. */
export const PHASES = ['scan', 'parse', 'drain', 'bufferChange', 'handlers'] as const
/** Phases within `parse` (`writeBytes`), counted as a subdivision of it. */
export const SUBPHASES = ['alloc', 'copy', 'coreWrite', 'free'] as const

export type Phase = (typeof PHASES)[number]
export type Subphase = (typeof SUBPHASES)[number]
export type AnyPhase = Phase | Subphase

/** What each phase covers, for the report. */
const HELP: Record<AnyPhase, string> = {
  scan: 'scanOsc over every byte, in JS (only when an OSC/bell handler is registered)',
  parse: 'writeBytes into the WASM core — the parser itself',
  drain: 'readResponse loop, replies the core owes the host',
  bufferChange: 'asking the core whether the screen buffer flipped',
  handlers: 'onWriteParsed / OSC / bell callbacks',
  alloc: 'ghostty_wasm_alloc_u8_array for the delivery',
  copy: 'copying the bytes into WASM linear memory',
  coreWrite: 'ghostty_terminal_write — the parse proper',
  free: 'ghostty_wasm_free_u8_array',
}

const ALL: AnyPhase[] = [...PHASES, ...SUBPHASES]

let enabled = false
let totals = blank()
let calls = blank()
let writes = 0
let bytes = 0
let writeMs = 0
let unparsedBytes = 0

function blank(): Record<AnyPhase, number> {
  return {
    scan: 0, parse: 0, drain: 0, bufferChange: 0, handlers: 0,
    alloc: 0, copy: 0, coreWrite: 0, free: 0,
  }
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
  unparsedBytes = 0
}

export function isEnabled(): boolean {
  return enabled
}

/**
 * An optional line of page state printed beside the throughput (registered by
 * GhosttyEngine). A hook, so this instrument needn't know about engines and
 * both `deliveryStats` and the benchmark harness can share it. The same WASM
 * has parsed at very different rates in different page sessions, so a
 * throughput figure should carry the state that produced it.
 */
let context: (() => string) | null = null

export function setContext(fn: (() => string) | null): void {
  context = fn
}

/**
 * Runs `fn`, attributing its duration to `phase` when recording. Top-level
 * phases partition `write`; sub-phases partition `parse`. `parse` and
 * `bufferChange` aren't wrapped by an enclosing phase, so work is counted
 * once per level.
 */
export function time<T>(phase: AnyPhase, fn: () => T): T {
  if (!enabled) return fn()
  const t0 = performance.now()
  try {
    return fn()
  } finally {
    totals[phase] += performance.now() - t0
    calls[phase]++
  }
}

/** A clock read that costs nothing when recording is off. */
export function now(): number {
  return enabled ? performance.now() : 0
}

export function recordWrite(byteLength: number, ms: number): void {
  if (!enabled) return
  writes++
  bytes += byteLength
  writeMs += ms
}

/**
 * Bytes `write` accepted but buffered (the core hadn't loaded), which enter no
 * phase. Counted so the report says so instead of dividing them by time
 * nobody spent.
 */
export function recordUnparsed(byteLength: number): void {
  if (!enabled) return
  unparsedBytes += byteLength
}

export interface PhaseSnapshot {
  writes: number
  bytes: number
  /** Total time inside `write`, and the throughput that implies. */
  writeMs: number
  bytesPerSec: number
  /** Per phase and sub-phase: total ms and how many times it ran. */
  totals: Record<AnyPhase, number>
  calls: Record<AnyPhase, number>
  /** Top-level phases as a share of `writeMs`; sub-phases as a share of
   *  `parse`. */
  shares: Record<AnyPhase, number>
  /** Time no top-level phase claimed within `write`, and no sub-phase within
   *  `parse`. A large value is itself a finding. */
  unattributedMs: number
  parseUnattributedMs: number
  /** Of `bytes`, how many were buffered rather than parsed. Above zero, the
   *  rate is invalid. */
  unparsedBytes: number
}

export function snapshot(): PhaseSnapshot {
  const shares = blank()
  let claimed = 0
  for (const p of PHASES) {
    claimed += totals[p]
    shares[p] = writeMs > 0 ? totals[p] / writeMs : 0
  }
  let subClaimed = 0
  for (const p of SUBPHASES) {
    subClaimed += totals[p]
    shares[p] = totals.parse > 0 ? totals[p] / totals.parse : 0
  }
  return {
    writes,
    bytes,
    writeMs,
    bytesPerSec: writeMs > 0 ? bytes / (writeMs / 1000) : 0,
    totals: { ...totals },
    calls: { ...calls },
    shares,
    unattributedMs: Math.max(0, writeMs - claimed),
    parseUnattributedMs: Math.max(0, totals.parse - subClaimed),
    unparsedBytes,
  }
}

const mbs = (n: number) => `${(n / 1048576).toFixed(1)} MB/s`

function row(label: string, ms: number, share: number, callCount: number | null, help: string, indent = ''): string {
  const callText = callCount === null ? '' : `${String(callCount).padStart(7)} calls`
  return `${indent}  ${label.padEnd(13 - indent.length)} ${ms.toFixed(0).padStart(6)} ms  ${(share * 100).toFixed(1).padStart(5)}%  ${callText}   ${help}`
}

export function formatReport(s: PhaseSnapshot = snapshot()): string {
  const lines: string[] = ['=== write phases ===']
  if (s.writes === 0) {
    lines.push('no writes recorded — call start() before the run')
    return lines.join('\n')
  }
  lines.push(
    `${s.writes} writes, ${(s.bytes / 1048576).toFixed(2)} MB, ${s.writeMs.toFixed(0)} ms inside write => ${mbs(s.bytesPerSec)}`,
  )
  // First, since the throughput above is what people quote.
  if (s.unparsedBytes > 0) {
    const share = s.bytes > 0 ? (s.unparsedBytes / s.bytes) * 100 : 100
    lines.push(
      `!! INVALID: ${(s.unparsedBytes / 1048576).toFixed(2)} MB (${share.toFixed(1)}%) was buffered, never parsed —`,
      `!! the core was still loading. The rate above divides all the bytes by the time`,
      `!! spent parsing only some of them, so it overstates by roughly ${(100 / Math.max(1, 100 - share)).toFixed(1)}x. Discard this run.`,
    )
  }
  // Beside the rate, for comparison across sessions.
  const ctx = context?.()
  if (ctx) lines.push(ctx)
  // By cost, so the first line is the one worth acting on.
  const ranked = [...PHASES].sort((a, b) => s.totals[b] - s.totals[a])
  for (const p of ranked) {
    lines.push(row(p, s.totals[p], s.shares[p], s.calls[p], HELP[p]))
    // Sub-phases follow the phase they subdivide.
    if (p === 'parse' && s.totals.parse > 0) {
      const sub = [...SUBPHASES].sort((a, b) => s.totals[b] - s.totals[a])
      for (const q of sub) {
        lines.push(row(q, s.totals[q], s.shares[q], s.calls[q], HELP[q], '  '))
      }
      lines.push(
        row('unattributed', s.parseUnattributedMs, s.totals.parse > 0 ? s.parseUnattributedMs / s.totals.parse : 0, null, 'inside writeBytes, outside the calls above', '  '),
      )
    }
  }
  lines.push(
    row('unattributed', s.unattributedMs, s.writeMs > 0 ? s.unattributedMs / s.writeMs : 0, null, 'inside write, outside the phases above'),
  )
  return lines.join('\n')
}

/** Every phase name, for callers that enumerate them. */
export const ALL_PHASES: readonly AnyPhase[] = ALL
