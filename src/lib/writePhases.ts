/**
 * Splits a terminal write into its phases, so "the engine is slow" can be
 * attributed to a part of the engine.
 *
 * The delivery-path recorder (`deliveryStats`) times `engine.write` as one
 * span. That was enough to establish a local flood is engine-bound, and no
 * further: it left a 2.7x gap between what the same Ghostty WASM parses in the
 * benchmark harness (~88 MB/s) and what it manages in a live pane (~33 MB/s),
 * with no way to say which part of the write differed. This times the parts.
 *
 * The first split narrowed it to `writeBytes` (93%), ruling out the JS OSC
 * scan, response draining and callbacks. The sub-phases go inside that call,
 * since the cost proved invariant to content shape, grid geometry and
 * scrollback — none of which the buffer handoff touches.
 *
 * Off by default and free when off — `time` calls straight through without
 * reading a clock — because these wrap the hottest path in the app.
 */

/** Phases of `write`. These partition it, so they reconcile against the whole. */
export const PHASES = ['scan', 'parse', 'drain', 'bufferChange', 'handlers'] as const
/** Phases *within* `parse` (i.e. within `writeBytes`). Counted separately so
 *  they subdivide `parse` rather than being added alongside it. */
export const SUBPHASES = ['alloc', 'copy', 'coreWrite', 'free'] as const

export type Phase = (typeof PHASES)[number]
export type Subphase = (typeof SUBPHASES)[number]
export type AnyPhase = Phase | Subphase

/** What each phase covers, for the report — the names alone are too terse to
 *  act on, and the point of this module is telling someone where to look. */
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
 * Runs `fn` — always — attributing its duration to `phase` when recording.
 *
 * Top-level phases partition `write`; sub-phases partition `parse`. Nothing
 * else nests: `parse` and `bufferChange` are called from inside the
 * scan-and-dispatch path and are deliberately *not* wrapped by an enclosing
 * phase there, so each byte of work is counted once at each level.
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

/**
 * Bytes `write` accepted but never handed to the parser — buffered because the
 * core had not loaded.
 *
 * Recorded because this module cannot otherwise tell the difference. It times
 * phases, and a buffered write enters none of them: the throughput line divides
 * bytes that arrived by time nobody spent, and reports the fastest parse ever
 * seen. That is how a Ghostty figure roughly 3x too fast reached the published
 * findings. Counting them makes the report say so instead.
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
   *  `parse`, which is what they subdivide. */
  shares: Record<AnyPhase, number>
  /** Time inside `write` that no top-level phase claimed, and time inside
   *  `parse` that no sub-phase claimed. A large value means the cost is
   *  somewhere these wrappers do not cover, which is itself a finding. */
  unattributedMs: number
  parseUnattributedMs: number
  /** Of `bytes`, how many were buffered rather than parsed. Anything above zero
   *  invalidates `bytesPerSec`, which divides all of `bytes` by the time spent
   *  parsing only some of them. */
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

function row(label: string, ms: number, share: number, calls: number | null, help: string, indent = ''): string {
  const callText = calls === null ? '' : `${String(calls).padStart(7)} calls`
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
  // Before the breakdown, not after: the throughput above is the number people
  // read and quote, and if it is nonsense they have to learn that first.
  if (s.unparsedBytes > 0) {
    const share = s.bytes > 0 ? (s.unparsedBytes / s.bytes) * 100 : 100
    lines.push(
      `!! INVALID: ${(s.unparsedBytes / 1048576).toFixed(2)} MB (${share.toFixed(1)}%) was buffered, never parsed —`,
      `!! the core was still loading. The rate above divides all the bytes by the time`,
      `!! spent parsing only some of them, so it overstates by roughly ${(100 / Math.max(1, 100 - share)).toFixed(1)}x. Discard this run.`,
    )
  }
  // Ordered by cost, because the first line is the one worth acting on.
  const ranked = [...PHASES].sort((a, b) => s.totals[b] - s.totals[a])
  for (const p of ranked) {
    lines.push(row(p, s.totals[p], s.shares[p], s.calls[p], HELP[p]))
    // Sub-phases follow the phase they subdivide, as shares of it.
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
