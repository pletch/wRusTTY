/**
 * The A/B/A/B trial runner.
 *
 * Two rules from Phase 7 shape this:
 *   - Stop the clock at presentation (delegated to measurePresent).
 *   - Interleave the engines so slow drift — thermal throttling, a background
 *     task waking up, WebView2 housekeeping — lands on both roughly equally
 *     instead of biasing whichever ran in one contiguous block.
 *
 * Interleaving is per unit of work, and the order within each pair is flipped
 * every step so neither engine permanently owns the first-mover slot (the first
 * of a back-to-back pair tends to run against a slightly cooler cache).
 *
 * Throughput workloads interleave by round (one big write each, reset between).
 * Latency workloads interleave by event, both engines threaded through the same
 * event stream in lockstep, so a TUI stays in its alternate screen and a typed
 * line accumulates identically on both.
 */

import { measurePresent, nextFrame, type Paintable } from './presentClock'
import { summarize, type Stats } from './stats'
import { coalescedDeliveries, type Workload } from './workloads'

/**
 * Hands control back to the event loop for one macrotask, without the delay
 * `setTimeout` would impose.
 *
 * `setTimeout(…, 0)` is the obvious way to do this and it silently wrecked the
 * measurement it was used for. Per the HTML spec a timer nested more than five
 * deep is clamped to a 4 ms minimum, and a feed loop that awaits a timer is
 * nested by definition from its sixth turn on. At 100 MB that was 400 yields —
 * 1.6 s of the reported drain spent asleep, against ~1.2 s of actual parsing,
 * which buried the difference between two engines under a constant both of
 * them paid equally.
 *
 * A `MessageChannel` message is also a macrotask (so the compositor still gets
 * its turn, which is the point of yielding at all) but carries no clamp. One
 * channel is shared and resolvers are queued, rather than building a channel
 * per yield — at hundreds of yields per round that would be its own cost.
 */
let yieldPort: MessagePort | null = null
const yieldWaiters: (() => void)[] = []

function macrotaskYield(): Promise<void> {
  if (!yieldPort) {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => yieldWaiters.shift()?.()
    channel.port1.start()
    yieldPort = channel.port2
  }
  return new Promise((resolve) => {
    yieldWaiters.push(resolve)
    yieldPort!.postMessage(null)
  })
}

export interface RunnableEngine extends Paintable {
  name: string
  write(data: Uint8Array | string): void
  /** Resolves when the parser has fully consumed the data. See engine `parse`. */
  parse(data: Uint8Array | string): Promise<void>
  readonly cols: number
  readonly rows: number
}

export interface EngineResult {
  engine: string
  /** Latency: present latency (ms). Throughput: parse time (ms). Block: the
   *  distribution of worst-stall-per-round (ms) — `stats.max` is the freeze. */
  stats: Stats
  /** MB/s for throughput and block workloads; undefined for latency ones. */
  throughputMBs?: number
  /** Mean wall-clock to fully drain the payload (ms). Block workloads only.
   *  Includes the yields between deliveries, so it is a property of the feed
   *  as much as of the engine — compare `parseMeanMs` to isolate the engine. */
  drainMeanMs?: number
  /** Mean time actually spent inside the engine during a drain (ms), summed
   *  across deliveries. Block workloads only. This is the engine's share of
   *  the drain, and the figure that can tell two engines apart. */
  parseMeanMs?: number
  /** MB/s implied by `parseMeanMs` — throughput with the harness's own feed
   *  overhead removed. Block workloads only. */
  parseMBs?: number
  /** How many deliveries the payload was fed as. Block workloads only. */
  deliveries?: number
  /** Trials that produced no paint at all — measurement was invalid. */
  emptyTrials: number
  /** Trials that hit the wall-clock ceiling before settling. */
  failedTrials: number
}

export interface WorkloadResult {
  workloadId: string
  label: string
  unit: string
  mode: Workload['mode']
  /** Block workloads: true if fed in coalescer-sized chunks (the app-realistic
   *  stall), false if fed as one monolithic write (the worst-case stall). */
  chunkedFeed?: boolean
  results: EngineResult[]
}

export interface RunOptions {
  /** Rounds per engine for throughput workloads. */
  throughputRounds: number
  /** Rounds per engine for block (flood-stress) workloads. Fewer, since each is
   *  a full large-flood drain. Defaults to 3. */
  blockRounds?: number
  onProgress?: (msg: string) => void
}

const RESET_SEQ = '\x1bc' // RIS — full terminal reset between trials

/**
 * Times a pure parse of the whole payload — the "parser win" the flood is meant
 * to measure. Fair across the engines *only* because each is asked when its own
 * parser is done: Ghostty synchronously, xterm via its parse-complete callback.
 * An earlier version fed both a rate-limited stream and timed presentation,
 * which silently throttled the synchronous engine (its parse counted against
 * the per-frame budget) while the async one enqueued and escaped — inverting the
 * result. Feed pacing has no place in a parser measurement.
 */
async function measureParse(
  engine: RunnableEngine,
  buf: Uint8Array,
  timeoutMs = 20000,
): Promise<{ ms: number; timedOut: boolean }> {
  await nextFrame()
  const t0 = performance.now()
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<'timeout'>((res) => {
    timer = setTimeout(() => res('timeout'), timeoutMs)
  })
  const done = engine.parse(buf).then(() => 'done' as const)
  const outcome = await Promise.race([done, timeout])
  clearTimeout(timer!)
  return { ms: performance.now() - t0, timedOut: outcome === 'timeout' }
}

/** Consecutive paint-free frames that count a chunked drain as finished. */
const BLOCK_SETTLE_FRAMES = 3

/**
 * Times a flood drain while watching for the longest single main-thread stall —
 * the freeze Phase 8 (WASM in a Web Worker) would remove.
 *
 * A free-running rAF loop records the gap between consecutive frames. Whenever
 * the main thread is blocked, rAF stops firing, so the largest gap *is* the
 * perceived freeze. The trailing frames catch a render stall that lands last.
 *
 * `chunkBytes` chooses the feed:
 *   - 0: one monolithic write. Both engines parse it uninterrupted, so the stall
 *     ≈ the whole parse — the raw-parser / absolute-worst-case number.
 *   - >0: the payload is written in chunkBytes pieces across event-loop turns,
 *     modelling the Rust coalescer, whose flush threshold is the *floor* on a
 *     real delivery rather than a cap (see COALESCE_THRESHOLD). This
 *     is the stall the app can actually produce. Writes are fire-and-forget
 *     (like `onData`), so the drain is considered done only once paints settle —
 *     xterm parses its queue off the write call.
 */
async function measureBlock(
  engine: RunnableEngine,
  buf: Uint8Array,
  chunkBytes = 0,
  timeoutMs = 120000,
): Promise<{ drainMs: number; parseMs: number; maxStallMs: number; deliveries: number; timedOut: boolean }> {
  let maxStall = 0
  let last = 0
  let painted = false
  let running = true
  const loop = (t: number) => {
    if (!running) return
    if (last > 0) {
      const gap = t - last
      if (gap > maxStall) maxStall = gap
    }
    last = t
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  const sub = engine.onRender(() => (painted = true))
  await nextFrame()
  await nextFrame() // settle to a steady cadence, then discard warm-up gaps
  maxStall = 0

  const t0 = performance.now()
  const overCeiling = () => performance.now() - t0 > timeoutMs
  let timedOut = false
  // Time actually spent inside the engine, accumulated across deliveries and
  // reported separately from the wall clock. Wall clock includes the yields
  // between deliveries, which belong to the harness and not to the engine —
  // conflating the two is what made the drain figure incomparable.
  let parseMs = 0
  let deliveries = 0

  if (chunkBytes > 0) {
    // The sizes the coalescer would actually emit for this payload — at least
    // the flush threshold, larger by however much a read overshot it.
    const sizes = coalescedDeliveries(buf.length, chunkBytes)
    deliveries = sizes.length
    let offset = 0
    for (const size of sizes) {
      const end = Math.min(offset + size, buf.length)
      const w0 = performance.now()
      engine.write(buf.subarray(offset, end))
      parseMs += performance.now() - w0
      offset = end
      // Yield after every delivery, not every eighth. A delivery is exactly
      // the unit the app hands over in one event-loop turn, so batching eight
      // of them measured a stall the app cannot produce and hid the
      // per-delivery one it can.
      await macrotaskYield()
      if (overCeiling()) {
        timedOut = true
        break
      }
    }
    let idle = 0
    while (!timedOut && idle < BLOCK_SETTLE_FRAMES) {
      await nextFrame()
      if (overCeiling()) {
        timedOut = true
        break
      }
      if (painted) {
        painted = false
        idle = 0
      } else {
        idle++
      }
    }
  } else {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<'timeout'>((res) => {
      timer = setTimeout(() => res('timeout'), timeoutMs)
    })
    const w0 = performance.now()
    const done = engine.parse(buf).then(() => 'done' as const)
    timedOut = (await Promise.race([done, timeout])) === 'timeout'
    parseMs = performance.now() - w0
    deliveries = 1
    clearTimeout(timer!)
  }

  const drainMs = performance.now() - t0
  await nextFrame()
  await nextFrame()
  await nextFrame()
  running = false
  sub.dispose()
  return { drainMs, parseMs, maxStallMs: maxStall, deliveries, timedOut }
}

/** Median interval between animation frames — the display's real cadence, so
 *  latency (which is frame-quantized) can be reported refresh-independently. */
export async function measureFrameInterval(samples = 60): Promise<number> {
  const deltas: number[] = []
  let last = await nextFrame()
  for (let i = 0; i < samples; i++) {
    const t = await nextFrame()
    deltas.push(t - last)
    last = t
  }
  deltas.sort((a, b) => a - b)
  return deltas[deltas.length >> 1] || 16.7
}

/** Waits until neither an active paint burst nor damage remains, or the cap. */
async function quiesce(engine: RunnableEngine, frames = 4, maxFrames = 240): Promise<void> {
  let painted = false
  const sub = engine.onRender(() => (painted = true))
  try {
    let idle = 0
    let total = 0
    while (idle < frames && total < maxFrames) {
      await nextFrame()
      total++
      if (painted) {
        painted = false
        idle = 0
      } else {
        idle++
      }
    }
  } finally {
    sub.dispose()
  }
}

async function reset(engine: RunnableEngine): Promise<void> {
  engine.write(RESET_SEQ)
  await quiesce(engine)
}

async function runThroughput(
  a: RunnableEngine,
  b: RunnableEngine,
  workload: Workload,
  opts: RunOptions,
): Promise<WorkloadResult> {
  const built = workload.build(a.cols, a.rows)
  const buf = built.events[0]
  const samples: Record<string, number[]> = { [a.name]: [], [b.name]: [] }
  const failed: Record<string, number> = { [a.name]: 0, [b.name]: 0 }

  for (let round = 0; round < opts.throughputRounds; round++) {
    // Flip order each round so neither engine always runs first.
    const order = round % 2 === 0 ? [a, b] : [b, a]
    for (const engine of order) {
      await reset(engine)
      opts.onProgress?.(`${workload.label}: ${engine.name} round ${round + 1}/${opts.throughputRounds}`)
      const r = await measureParse(engine, buf)
      if (r.timedOut) failed[engine.name]++
      else samples[engine.name].push(r.ms)
    }
  }

  return {
    workloadId: workload.id,
    label: workload.label,
    unit: workload.unit,
    mode: workload.mode,
    results: [a, b].map((e) => {
      const stats = summarize(samples[e.name])
      const mb = built.totalBytes / (1024 * 1024)
      return {
        engine: e.name,
        stats,
        throughputMBs: stats.mean > 0 ? mb / (stats.mean / 1000) : 0,
        emptyTrials: 0,
        failedTrials: failed[e.name],
      }
    }),
  }
}

/**
 * Runs a flood-stress workload: the same interleaved, order-flipped rounds as
 * throughput, but each round measures the worst main-thread stall the drain
 * caused (via `measureBlock`) rather than a settle. `stats` is the distribution
 * of those worst stalls across rounds — `stats.max` is the freeze to quote —
 * and `drainMeanMs` is the wall-clock to fully drain. No MB/s here: under a
 * chunked feed the wall-clock is dominated by inter-delivery yields, not parse,
 * so a "rate" would mislead; the pure-parse rate is the throughput workload's job.
 */
async function runBlock(
  a: RunnableEngine,
  b: RunnableEngine,
  workload: Workload,
  opts: RunOptions,
): Promise<WorkloadResult> {
  const built = workload.build(a.cols, a.rows)
  const buf = built.events[0]
  const chunkBytes = built.chunkBytes ?? 0
  const rounds = opts.blockRounds ?? 3
  const stalls: Record<string, number[]> = { [a.name]: [], [b.name]: [] }
  const drains: Record<string, number[]> = { [a.name]: [], [b.name]: [] }
  const parses: Record<string, number[]> = { [a.name]: [], [b.name]: [] }
  const failed: Record<string, number> = { [a.name]: 0, [b.name]: 0 }
  let deliveries = 0

  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? [a, b] : [b, a]
    for (const engine of order) {
      await reset(engine)
      opts.onProgress?.(`${workload.label}: ${engine.name} round ${round + 1}/${rounds}`)
      const r = await measureBlock(engine, buf, chunkBytes)
      if (r.timedOut) {
        failed[engine.name]++
      } else {
        stalls[engine.name].push(r.maxStallMs)
        drains[engine.name].push(r.drainMs)
        parses[engine.name].push(r.parseMs)
        deliveries = r.deliveries
      }
    }
  }

  return {
    workloadId: workload.id,
    label: workload.label,
    unit: workload.unit,
    mode: workload.mode,
    chunkedFeed: chunkBytes > 0,
    results: [a, b].map((e) => {
      const parseMean = summarize(parses[e.name]).mean
      const mb = built.totalBytes / (1024 * 1024)
      return {
        engine: e.name,
        stats: summarize(stalls[e.name]),
        drainMeanMs: summarize(drains[e.name]).mean,
        parseMeanMs: parseMean,
        parseMBs: parseMean > 0 ? mb / (parseMean / 1000) : 0,
        deliveries,
        emptyTrials: 0,
        failedTrials: failed[e.name],
      }
    }),
  }
}

async function runLatency(
  a: RunnableEngine,
  b: RunnableEngine,
  workload: Workload,
  opts: RunOptions,
): Promise<WorkloadResult> {
  const builtA = workload.build(a.cols, a.rows)
  const builtB = workload.build(b.cols, b.rows)
  const samples: Record<string, number[]> = { [a.name]: [], [b.name]: [] }
  const empty: Record<string, number> = { [a.name]: 0, [b.name]: 0 }
  const failed: Record<string, number> = { [a.name]: 0, [b.name]: 0 }

  await reset(a)
  await reset(b)
  const setupA = builtA.setup
  const setupB = builtB.setup
  if (setupA && setupB) {
    a.write(setupA)
    b.write(setupB)
    await quiesce(a)
    await quiesce(b)
  }

  const n = builtA.events.length
  for (let i = 0; i < n; i++) {
    const pair: [RunnableEngine, Uint8Array][] =
      i % 2 === 0
        ? [[a, builtA.events[i]], [b, builtB.events[i]]]
        : [[b, builtB.events[i]], [a, builtA.events[i]]]
    for (const [engine, ev] of pair) {
      const r = await measurePresent(engine, () => engine.write(ev), { timeoutMs: 2000 })
      if (r.timedOut) failed[engine.name]++
      else if (r.paints === 0) empty[engine.name]++
      else samples[engine.name].push(r.elapsed)
    }
    if (i % 25 === 0) opts.onProgress?.(`${workload.label}: event ${i + 1}/${n}`)
  }

  const teardownA = builtA.teardown
  const teardownB = builtB.teardown
  if (teardownA && teardownB) {
    a.write(teardownA)
    b.write(teardownB)
  }

  return {
    workloadId: workload.id,
    label: workload.label,
    unit: workload.unit,
    mode: workload.mode,
    results: [a, b].map((e) => ({
      engine: e.name,
      stats: summarize(samples[e.name]),
      emptyTrials: empty[e.name],
      failedTrials: failed[e.name],
    })),
  }
}

/** Feeds both engines a chunk of real-shaped output to warm JIT, atlas and font. */
export async function warmup(a: RunnableEngine, b: RunnableEngine): Promise<void> {
  const chunk = new TextEncoder().encode(
    Array.from({ length: 200 }, (_, i) => `\x1b[38;5;${(i % 255) + 1}mwarmup line ${i} — the quick brown fox 世界\x1b[0m\r\n`).join(''),
  )
  for (const e of [a, b]) {
    e.write(chunk)
    await quiesce(e)
    await reset(e)
  }
}

export async function runWorkload(
  a: RunnableEngine,
  b: RunnableEngine,
  workload: Workload,
  opts: RunOptions,
): Promise<WorkloadResult> {
  if (workload.mode === 'throughput') return runThroughput(a, b, workload, opts)
  if (workload.mode === 'block') return runBlock(a, b, workload, opts)
  return runLatency(a, b, workload, opts)
}

/** Compact ms/s for a drain duration — `840ms`, `1.3s`. */
export function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`
}

/** Renders a completed run as a Markdown block for pasting into Phase 7 notes.
 *  `frameMs` is the measured display cadence, so latency can be shown in frames
 *  — the refresh-independent form, since presentation is frame-quantized. */
export function resultsToMarkdown(
  results: WorkloadResult[],
  gpuLine: string,
  meta: string,
  frameMs: number,
): string {
  const lines: string[] = []
  lines.push('# wRusTTY Phase 7 — engine A/B', '')
  lines.push(meta, '', gpuLine, '')
  lines.push(
    '',
    '> Latency is frame-quantized: the last column shows p50 in whole display frames, which is the comparable figure across refresh rates. Throughput is a pure-parse measurement (each engine timed to its own parser completion). Flood-stress rows (`ms stall`) report the longest single main-thread stall during the drain — the freeze a user feels, with `max` the worst across rounds; the last column is that worst stall in frames, then **parse** (time actually inside the engine, and the MB/s it implies) and **drain** (wall clock). Compare engines on *parse*: drain includes the yields between deliveries, which both engines pay equally, so it dilutes the difference. A `KB+ feed` row replays the coalescer\'s own accumulate-and-flush loop (deliveries of at least the 32 KB threshold, larger by however much a read overshot), one event-loop turn each, so its stall is one the app can produce; a `single write` row is the monolithic worst case the coalescer never allows.',
    '',
  )
  for (const w of results) {
    lines.push(`## ${w.label}  \`(${w.unit})\``, '')
    const lastCol =
      w.mode === 'throughput' ? 'parse' : w.mode === 'block' ? 'worst stall · parse · drain' : 'p50 frames'
    lines.push(`| engine | n | mean | p50 | p95 | p99 | max | ${lastCol} |`)
    lines.push('|---|---|---|---|---|---|---|---|')
    for (const r of w.results) {
      const s = r.stats
      const last =
        w.mode === 'throughput'
          ? r.throughputMBs != null
            ? `${r.throughputMBs.toFixed(1)} MB/s`
            : '—'
          : w.mode === 'block'
            ? `⏸${frameMs > 0 ? (s.max / frameMs).toFixed(1) : '?'}f · ${fmtDuration(r.parseMeanMs ?? 0)} parse (${(r.parseMBs ?? 0).toFixed(1)} MB/s) · ${fmtDuration(r.drainMeanMs ?? 0)} drain`
            : frameMs > 0
              ? `≈${(s.p50 / frameMs).toFixed(1)} f`
              : '—'
      const flags =
        (r.failedTrials ? ` ⛔${r.failedTrials} timeout` : '') + (r.emptyTrials ? ` ⚠️${r.emptyTrials} empty` : '')
      lines.push(
        `| ${r.engine}${flags} | ${s.n} | ${s.mean.toFixed(2)} | ${s.p50.toFixed(2)} | ${s.p95.toFixed(2)} | ${s.p99.toFixed(2)} | ${s.max.toFixed(2)} | ${last} |`,
      )
    }
    lines.push('')
  }
  lines.push(...FINDINGS)
  return lines.join('\n')
}

/**
 * The written conclusions the numbers above support — folded into the export so
 * the notes stand on their own. These explain the two results most likely to be
 * misread: the parser coming out even (not the expected Ghostty SIMD win), and
 * the flood not freezing either engine.
 */
const FINDINGS: string[] = [
  '## Findings',
  '',
  '**Parser throughput is at parity (~80–90 MB/s), not a Ghostty win — and that is expected here.**',
  '',
  "- The vendored `ghostty-web@0.4.0` WASM is **scalar**: inspecting the binary shows zero `v128` types in any function signature and zero `v128` locals. Ghostty's native SIMD parser paths are not compiled into this build (the library's own pitch is *correctness* — grapheme handling, XTPUSHSGR/XTPOPSGR — not throughput).",
  '- Even with `+simd128` enabled, WASM SIMD is fixed **128-bit**, versus native **AVX2 (256-bit)** / AVX-512, plus bounds-checked linear-memory loads and JS↔WASM boundary cost. Native multi-GB/s parse throughput structurally cannot transfer to a `.wasm`.',
  "- xterm.js's parser is a table-driven state machine over typed arrays — already fast — so ~87 MB/s is a high bar, and a scalar WASM parser landing at ~80 MB/s being roughly equal is the expected outcome.",
  '- The synthetic flood (short lines, dense SGR) also under-exercises SIMD\'s sweet spot (long printable runs). The native SIMD advantage is real, but it is a **Placement 3** prize (native `libghostty` in the Rust backend), unreachable from WASM.',
  '',
  '**A flood is bounded by memory, not by parse time — and that is what actually broke.** The stall numbers below were always right and always beside the point: at 100 MB the Ghostty pane wedged outright, reproducibly on the third round. The cause was retention, not throughput. `scrollbackLimit` is a **line count**, which the core multiplies by its per-line page cost in 32-bit `usize`; this side was passing a *byte* budget, so a normal 5000-line setting arrived as ~8,000,000, overflowed, and hit the core\'s `catch maxInt(usize)` fallback — meaning unlimited. Scrollback was uncapped: 100 MB retained all ~1.15 M rows and grew the WASM heap ~25x the input (~51x at 200 columns) to ~2 GB, until an allocation was refused. Every refusal was then swallowed — `writeBytes` and the renderer\'s buffer helpers both returned on a null pointer — so the pane stopped writing and stopped painting with nothing logged, which is the "wedge". Fixed on this side (`scrollbackLinesFor`, pinned by `scrollbackLimit.test.ts`); the vendored WASM was correct all along and is unchanged. 100 MB x 3 rounds now drains with the heap flat at ~9 MB (~17 MB at 200x60). Allocation failure is now raised and reported instead of ignored.',
  '',
  '**Neither engine freezes on a flood in this app.** The Rust coalescer (`src-tauri/src/coalesce.rs`) caps every delivery at 32 KB across separate event-loop turns; a 32 KB parse is ~0.4 ms for either engine. Fed that way, the worst main-thread stall is ~1 frame at 10/50/100 MB for both. A monolithic write blocks ~1.2 s (100 MB) for both — but the coalescer never produces one. Parsing is not the bottleneck, so neither Phase 8 (parser → Web Worker) nor Placement 3 is justified by responsiveness; Placement 3 remains justified only by its features (native SIMD throughput, IPC-volume decoupling, persistent backend scrollback / reattach / search).',
  '',
  '**The case for defaulting to Ghostty is the renderer, not the parser:** it presents one display frame sooner than the xterm.js WebGL path across typing / streaming / TUI, reaches true background transparency the xterm path could not, and is at feature parity (four remaining gaps are upstream `ghostty-web@0.4.0` ABI limits, not renderer bugs).',
  '',
]
