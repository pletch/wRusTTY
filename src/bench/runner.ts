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
  /** Total rows the engine is holding — viewport plus retained scrollback. Read
   *  before and after a flood to prove the payload actually landed somewhere;
   *  see `deadTrials`. Optional so a test double need not model a buffer. */
  readonly scrollbackLength?: number
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
  /** Trials the engine accepted the payload for without parsing it. Excluded
   *  from `stats` and every mean, because averaging them in understates the
   *  cost by exactly the fraction of rounds that died. Block workloads only. */
  deadTrials: number
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
 * Whether a flood round actually happened, judged by what the terminal gained
 * rather than by how long it claimed to take.
 *
 * This exists because the harness published a Ghostty parse figure roughly 3x
 * too fast for weeks. The engine can enter a state where it accepts writes and
 * parses none of them: bytes go in, no error is raised, and the round completes
 * in milliseconds — so the round is averaged in as though it were the fastest
 * result ever recorded, and every mean it touches is pulled down by the share
 * of rounds that died. A run with two of three rounds dead reported ~82 MB/s
 * against a true ~31, which is the whole reason a live pane appeared to be 2.7x
 * slower than this harness. Both were always the same speed.
 *
 * Timing cannot catch it: a dead round's headline is "impossibly fast", but
 * xterm legitimately reports impossible rates here because its `write` is
 * asynchronous and returns before parsing, so a rate ceiling would flag every
 * honest xterm round instead. What cannot be faked is the buffer. Any payload
 * of a megabyte or more must push at least a screenful of lines off the top of
 * a grid this size, whatever its content — even a single unbroken line wraps.
 * So "gained fewer rows than it has" means the bytes went nowhere.
 */
const MIN_FLOOD_BYTES = 1024 * 1024

export function roundIsDead(payloadBytes: number, rowsAdded: number, rows: number): boolean {
  if (payloadBytes < MIN_FLOOD_BYTES) return false
  return rowsAdded < rows
}

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
): Promise<{
  drainMs: number
  parseMs: number
  maxStallMs: number
  deliveries: number
  timedOut: boolean
  rowsAdded: number
}> {
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

  const rowsBefore = engine.scrollbackLength ?? 0
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
  // Sampled here rather than at `drainMs`, so an engine that parses off the
  // write call (xterm) has finished its queue before it is asked.
  const rowsAdded = (engine.scrollbackLength ?? 0) - rowsBefore
  return { drainMs, parseMs, maxStallMs: maxStall, deliveries, timedOut, rowsAdded }
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
        deadTrials: 0,
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
  const dead: Record<string, number> = { [a.name]: 0, [b.name]: 0 }
  let deliveries = 0

  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? [a, b] : [b, a]
    for (const engine of order) {
      await reset(engine)
      opts.onProgress?.(`${workload.label}: ${engine.name} round ${round + 1}/${rounds}`)
      const r = await measureBlock(engine, buf, chunkBytes)
      if (r.timedOut) {
        failed[engine.name]++
      } else if (roundIsDead(built.totalBytes, r.rowsAdded, engine.rows)) {
        dead[engine.name]++
        console.warn(
          `[bench] ${engine.name} ${workload.id} round ${round + 1}: accepted ${(built.totalBytes / 1048576).toFixed(0)} MB ` +
            `in ${r.parseMs.toFixed(0)} ms but the buffer gained ${r.rowsAdded} rows — nothing was parsed. Round discarded.`,
        )
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
        deadTrials: dead[e.name],
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
      deadTrials: 0,
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

  // A per-row flag is too easy to miss in an exported table that someone reads
  // weeks later, and quoting a figure from a run with dead rounds is precisely
  // the mistake this is here to prevent. Say it once, at the top, in the way a
  // reader cannot skip.
  const deadTotal = results.reduce((n, w) => n + w.results.reduce((m, r) => m + (r.deadTrials ?? 0), 0), 0)
  if (deadTotal > 0) {
    lines.push(
      '',
      `> ☠️ **This run is not quotable.** ${deadTotal} flood round${deadTotal === 1 ? '' : 's'} accepted the payload without parsing it, and ` +
        'were discarded rather than averaged in. Every figure below rests on fewer rounds than it claims to, and the affected engine may ' +
        'have been in a degraded state for the rounds that did count. Restart the app and run it again.',
      '',
    )
  }
  lines.push(
    '',
    '> Latency is frame-quantized: the last column shows p50 in whole display frames, which is the comparable figure across refresh rates. Throughput is a pure-parse measurement (each engine timed to its own parser completion). Flood-stress rows (`ms stall`) report the longest single main-thread stall during the drain — the freeze a user feels, with `max` the worst across rounds; the last column is that worst stall in frames, then **parse** (time actually inside the engine, and the MB/s it implies) and **drain** (wall clock). Compare engines on *parse*: drain includes the yields between deliveries, which both engines pay equally, so it dilutes the difference — and at the current delivery size the stall column is floored by the frame interval and cannot separate them at all. Where parse and drain disagree sharply, the difference is per-delivery work outside the parser and is worth more attention than either column alone. A `KB+ feed` row replays the coalescer\'s own accumulate-and-flush loop (deliveries of at least the flush threshold, larger by however much a read overshot), one event-loop turn each, so its stall is one the app can produce; a `single write` row is the monolithic worst case the coalescer never allows.',
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
        (r.failedTrials ? ` ⛔${r.failedTrials} timeout` : '') +
        (r.emptyTrials ? ` ⚠️${r.emptyTrials} empty` : '') +
        (r.deadTrials ? ` ☠️${r.deadTrials} unparsed` : '')
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
  '**Ghostty parses faster than xterm.js — but drains slower, and the gap between those two facts is the thing worth chasing.** On the large flood Ghostty parses at ~82 MB/s against xterm.js at ~60 MB/s (a ~37% win, earned by the `ReleaseFast` rebuild), yet its wall-clock drain is ~37 MB/s against xterm.js\'s ~51. Roughly 55% of Ghostty\'s drain time is outside the parser, against ~15% for xterm.js. Parse throughput is no longer the interesting number for this engine; whatever it does per delivery around the parse is. **Read the parse figures against the payload the phase block below reports** — this row is a few MB per round, and a live 100 MB flood measures very differently (see the fourth bullet).',
  '',
  "- The vendored `ghostty-web@0.4.0` WASM is **scalar**: inspecting the binary shows zero `v128` types in any function signature and zero `v128` locals. Ghostty's native SIMD parser paths are not compiled into this build (the library's own pitch is *correctness* — grapheme handling, XTPUSHSGR/XTPOPSGR — not throughput).",
  '- Even with `+simd128` enabled, WASM SIMD is fixed **128-bit**, versus native **AVX2 (256-bit)** / AVX-512, plus bounds-checked linear-memory loads and JS↔WASM boundary cost. Native multi-GB/s parse throughput structurally cannot transfer to a `.wasm`. Measured, `+simd128` moved this build by 0.5–2%, i.e. noise.',
  '- So ~88 MB/s from a scalar WASM parser against a table-driven state machine over typed arrays is already a good result, and the remaining parser headroom is small. The **Placement 3** prize (native `libghostty` in the Rust backend) is real but unreachable from WASM.',
  '- **A live pane does not see that ~82 MB/s, and the difference is inside `ghostty_terminal_write`.** Both figures now come from the same recorder (`src/lib/writePhases.ts`, reported below): this harness measures **82.2 MB/s**, a live pane on a 100 MB flood measures **32.5 MB/s**. Nothing around the call accounts for it. Of the harness write, `coreWrite` is 98.8% and the whole buffer handoff — alloc, copy into linear memory, free — is 1.2%. In the pane, `writeBytes` is 93% of the write and the JS `scanOsc` pass the app takes and the harness does not is 6% (~495 MB/s); draining, buffer-change checks and callbacks are ~0.',
  '- Four candidate explanations for that gap are measured and dead: **content shape** (newline-dense vs long-line: 32.5 vs 31.3 MB/s), **grid geometry** (~80 vs ~200 columns, i.e. 2.5x the rows for the same bytes: 31.9 vs 33.2), **scrollback depth** (10000 vs 1000 retained rows: 32.5 vs 32.5), and everything wrapping the call. Parse cost is invariant to every piece of terminal state, at ~28 ns/byte.',
  '- What remains untested is **sustained volume**. The phase line below reports the payload it measured: this harness runs ~3 MB per round with a reset between rounds, against 96 MB delivered continuously into one terminal in the live test — a 30x difference that no run so far has controlled for. The flood-stress rows at 10 / 50 / 100 MB answer it directly: if their parse column falls off with size, throughput degrades with sustained output and the pane is not doing anything wrong.',
  '',
  '**A flood is bounded by memory, not by parse time — and that is what actually broke.** The stall numbers below were always right and always beside the point: at 100 MB the Ghostty pane wedged outright, reproducibly on the third round. The cause was retention, not throughput. `scrollbackLimit` is a **line count**, which the core multiplies by its per-line page cost in 32-bit `usize`; this side was passing a *byte* budget, so a normal 5000-line setting arrived as ~8,000,000, overflowed, and hit the core\'s `catch maxInt(usize)` fallback — meaning unlimited. Scrollback was uncapped: 100 MB retained all ~1.15 M rows and grew the WASM heap ~25x the input (~51x at 200 columns) to ~2 GB, until an allocation was refused. Every refusal was then swallowed — `writeBytes` and the renderer\'s buffer helpers both returned on a null pointer — so the pane stopped writing and stopped painting with nothing logged, which is the "wedge". Fixed on this side (`scrollbackLinesFor`, pinned by `scrollbackLimit.test.ts`); the vendored WASM was correct all along and is unchanged. 100 MB x 3 rounds now drains with the heap flat at ~9 MB (~17 MB at 200x60). Allocation failure is now raised and reported instead of ignored.',
  '',
  '**Neither engine freezes outright on a flood, but the stall rows understate the truth and should not be read as an all-clear.** The coalescer\'s `FLUSH_SIZE_THRESHOLD` is a **floor**, not a cap: a delivery is at least the threshold and larger by however much the read that crossed it overshot. It was 32 KB; measuring the real path showed the per-message IPC cost at ~40% on top of engine time, so it is now **256 KB**, worth 15.1 -> 19.7 MB/s on a 100 MB local flood. At that size a delivery is ~8 ms of parse — about one frame — so the stall metric still bottoms out near the refresh interval and cannot discriminate between engines. **Compare the parse column, not the stall column.** Measured in a live session, the worst main-thread block during a flood is ~110 ms, recurring several times per 100 MB.',
  '',
  '**Where a flood actually spends its time now (100 MB, live local session, measured both ends of the real path):** ~83% inside `engine.write`, ~12% in per-delivery IPC (~1 ms each), ~5% in a handful of 30–65 ms main-thread blocks. That is **engine-bound**, which reverses the earlier reading here that parsing was not the bottleneck — that conclusion came from stall rows that were floored by the frame interval. Phase 8 (parser → Web Worker) is therefore justified on throughput as well as on the blocks it would move off the main thread; it was previously dismissed on both counts. One caveat before acting on it: a Worker moves the parse off the main thread, which fixes the ~110 ms blocks, but it does not make a 33 MB/s parse faster — and the gap between that and the ~88 MB/s the same WASM reaches here is unexplained, so the cheaper win may still be ahead of it. Over SSH none of this applies at all: a remote flood measured 3.3 MB/s, link-bound, with the frontend idle 77% of the time.',
  '',
  '**Content shape barely moves either engine.** A newline-dense flood (~1.22 M line breaks across 96 MB) and a long-line flood measured 25.5 vs 25.6 MB/s end to end, with per-delivery engine time of 7.9 vs 8.2 ms. The scroll/eviction path is not the cost, so `PageList` is the wrong target. Both are plain ASCII, so this says nothing about escape-sequence handling.',
  '',
  '**The case for defaulting to Ghostty is the renderer, not the parser:** it presents one display frame sooner than the xterm.js WebGL path across typing / streaming / TUI, reaches true background transparency the xterm path could not, and is at feature parity (four remaining gaps are upstream `ghostty-web@0.4.0` ABI limits, not renderer bugs). The parser is now a Ghostty win too, but a smaller one than the drain figures suggest.',
  '',
]
