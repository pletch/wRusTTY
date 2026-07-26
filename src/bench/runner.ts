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
  /**
   * Checked between trials. Returning a reason aborts the run by throwing
   * `RunAborted` rather than returning what has been collected so far.
   *
   * Throwing is the point. A latency distribution that stopped early is
   * indistinguishable from a complete one once it reaches a table — the same
   * failure mode as the empty-trial flag this exists to replace (see
   * hostVisibility.ts). A caller that wants the partial data can catch and keep
   * it; a caller that forgets gets nothing, which is the safer default.
   */
  shouldAbort?: () => string | null
}

/** A run stopped because a precondition of the measurement stopped holding. */
export class RunAborted extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'RunAborted'
  }
}

function checkAbort(opts: RunOptions): void {
  const reason = opts.shouldAbort?.()
  if (reason != null) throw new RunAborted(reason)
}

/** Empty trials tolerated in one latency workload before the run is abandoned.
 *  Small: an engine that is not painting does not recover on its own, and the
 *  point is to stop while the fact is still legible rather than to survive it. */
const MAX_EMPTY_TRIALS = 3

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
): Promise<{ ms: number; timedOut: boolean; rowsAdded: number }> {
  await nextFrame()
  const rowsBefore = engine.scrollbackLength ?? 0
  const t0 = performance.now()
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<'timeout'>((res) => {
    timer = setTimeout(() => res('timeout'), timeoutMs)
  })
  const done = engine.parse(buf).then(() => 'done' as const)
  const outcome = await Promise.race([done, timeout])
  const ms = performance.now() - t0
  clearTimeout(timer!)
  // Both engines are awaited to parser completion here, so the buffer is
  // settled by now for either of them.
  return { ms, timedOut: outcome === 'timeout', rowsAdded: (engine.scrollbackLength ?? 0) - rowsBefore }
}

/** Consecutive paint-free frames that count a chunked drain as finished. */
const BLOCK_SETTLE_FRAMES = 3

/**
 * Whether a round actually happened, judged by what the terminal gained rather
 * than by how long it claimed to take. Applied to throughput and flood-stress
 * rounds alike.
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
 *
 * The assumption that carries all of it: **the payload scrolls the main screen**.
 * Every workload judged today does, being a flood of ordinary output. A
 * workload that spends its bytes redrawing in place would break this — most
 * obviously one that switches to the alternate screen, which has no scrollback
 * at all and would read as dead however well it parsed. If such a workload is
 * ever added at a megabyte or more, give it a way to opt out rather than
 * loosening the threshold, which would let the real failure back through.
 */
const MIN_FLOOD_BYTES = 1024 * 1024

export function roundIsDead(payloadBytes: number, rowsAdded: number, rows: number, scrolls = true): boolean {
  if (!scrolls) return false
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
  const dead: Record<string, number> = { [a.name]: 0, [b.name]: 0 }

  for (let round = 0; round < opts.throughputRounds; round++) {
    // Flip order each round so neither engine always runs first.
    const order = round % 2 === 0 ? [a, b] : [b, a]
    for (const engine of order) {
      checkAbort(opts)
      await reset(engine)
      opts.onProgress?.(`${workload.label}: ${engine.name} round ${round + 1}/${opts.throughputRounds}`)
      const r = await measureParse(engine, buf)
      if (r.timedOut) failed[engine.name]++
      else if (roundIsDead(built.totalBytes, r.rowsAdded, engine.rows, workload.scrollsMainScreen)) {
        dead[engine.name]++
        console.warn(
          `[bench] ${engine.name} ${workload.id} round ${round + 1}: accepted ${(built.totalBytes / 1048576).toFixed(1)} MB ` +
            `in ${r.ms.toFixed(0)} ms but the buffer gained ${r.rowsAdded} rows — nothing was parsed. Round discarded.`,
        )
      } else samples[engine.name].push(r.ms)
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
        deadTrials: dead[e.name],
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
      checkAbort(opts)
      await reset(engine)
      opts.onProgress?.(`${workload.label}: ${engine.name} round ${round + 1}/${rounds}`)
      const r = await measureBlock(engine, buf, chunkBytes)
      if (r.timedOut) {
        failed[engine.name]++
      } else if (roundIsDead(built.totalBytes, r.rowsAdded, engine.rows, workload.scrollsMainScreen)) {
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
      // Before the trial, not after: a host that has already scrolled away
      // would otherwise contribute one more empty sample on the way out.
      checkAbort(opts)
      const r = await measurePresent(engine, () => engine.write(ev), { timeoutMs: 2000 })
      if (r.timedOut) failed[engine.name]++
      else if (r.paints === 0) {
        empty[engine.name]++
        // Ground truth, and the backstop for the visibility guard in the
        // harness. That guard infers a paused renderer from geometry, which has
        // now been wrong in both directions — it fired on the harness's own
        // resize, and it missed the results tables pushing the hosts down the
        // page. An empty trial is not an inference: the engine was asked to
        // paint and did not. A handful can be a genuine no-op frame, so this
        // tolerates a few and then stops rather than filling a table with a
        // distribution sampled from whichever trials happened to render.
        if (empty[engine.name] > MAX_EMPTY_TRIALS) {
          throw new RunAborted(
            `${engine.name} produced no paint on ${empty[engine.name]} trials of ${workload.label}. ` +
              'Its renderer is not painting — most often because its host has left the viewport, which ' +
              'stops xterm.js rendering entirely. Run aborted rather than reported from the trials that ' +
              'did render.',
          )
        }
      } else samples[engine.name].push(r.elapsed)
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
      `> ☠️ **This run is not quotable.** ${deadTotal} round${deadTotal === 1 ? '' : 's'} accepted the payload without parsing it, and ` +
        'were discarded rather than averaged in. Every figure below rests on fewer rounds than it claims to, and the affected engine may ' +
        'have been in a degraded state for the rounds that did count. Restart the app and run it again.',
      '',
    )
  }
  lines.push(
    '',
    '> Latency is frame-quantized: the last column shows p50 in whole display frames, which is the comparable figure across refresh rates. Throughput is a pure-parse measurement (each engine timed to its own parser completion). Flood-stress rows (`ms stall`) report the longest single main-thread stall during the drain — the freeze a user feels, with `max` the worst across rounds; the last column is that worst stall in frames, then **parse** and **drain** (wall clock). A `KB+ feed` row replays the coalescer\'s own accumulate-and-flush loop (deliveries of at least the flush threshold, larger by however much a read overshot), one event-loop turn each, so its stall is one the app can produce; a `single write` row is the monolithic worst case the coalescer never allows.',
    '',
    '> **On a `KB+ feed` row, compare the engines on _drain_, not on parse.** Parse is measured around `write`, and xterm\'s `write` enqueues and returns before parsing any of it, so its parse column is enqueue time — which is why it reports rates in the thousands of MB/s. Only Ghostty parses synchronously inside the call, so only its parse figure is engine time. Both engines pay the same inter-delivery yields, so drain is the honest cross-engine comparison here; on a `single write` row both are timed to parser completion and parse is comparable. The stall column is floored by the frame interval at the current delivery size and cannot separate them at all.',
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
 * the notes stand on their own.
 *
 * The first paragraph is a measurement protocol rather than a result, and it
 * belongs there. Every figure in this file was wrong by ~2.75x for a while
 * because the only way to reach the recorders was to type into the console,
 * which attaches an inspector, which puts V8's WebAssembly into a debuggable
 * tier. Days went into chasing the resulting discrepancy through the workload,
 * the grid, the scrollback, the transport, the backend and the page state. A
 * reader who takes one thing from this section should take that.
 *
 * Corrections are kept in the text rather than quietly deleted. Two claims
 * published here were retracted and then un-retracted, and anyone holding a
 * stale copy needs to be able to tell which version they have.
 */
const FINDINGS: string[] = [
  '## Findings',
  '',
  '**Read this before quoting any number here: measure with DevTools closed.** V8 compiles WebAssembly in a debuggable tier whenever an inspector is attached — Liftoff with debug info, TurboFan off — because a breakpoint could be set at any moment. On this build that costs **2.75x**: the same 100 MB flood, in one page session, changing nothing else, measured 11.14 ms/MB with DevTools closed and 30.65 with it open, while the pure-JS pass over the same bytes moved 16%. Both live recorders used to be reachable only from the console, so every production figure taken during this investigation was measured in that tier. The apparent "a live pane parses 2.7x slower than this harness" gap was entirely this artifact, and it was chased through content shape, grid geometry, scrollback depth, sustained volume, backend contention, IPC queue depth, engine accumulation and the network before the instrument itself came under suspicion. Use `Ctrl+Alt+F` (pane flood), `Ctrl+Alt+D` (delivery path) and `Ctrl+Alt+W` (backpressure window) in the app, all of which render on screen; the flood report flags itself above 20 ms/MB. Figures marked *(open)* predate the discovery: their ratios hold, their absolute values are roughly 2.75x too slow.',
  '',
  '**Ghostty parses faster than xterm.js, and the win is in the cell path.** On the large flood Ghostty parses at **~77–80 MB/s** against xterm.js at ~61–72 (xterm is the noisy one). The three parse probes separate the byte-level state machine from the actions it dispatches from the per-cell work a printable character triggers. Two independent sessions, each at a pinned 80x24:',
  '',
  '| | Ghostty | xterm.js | |',
  '|---|---|---|---|',
  '| per printed cell | **11.2 / 10.8 ns** | 15.6 / 16.1 ns | Ghostty 1.4–1.5x faster |',
  '| per SGR dispatch | 54.1 / 70.3 ns | 33.2 / 35.4 ns | xterm.js 1.6–2.0x faster |',
  '| per SGR parameter | 16.6 / 14.3 ns | 11.8 / 10.8 ns | xterm.js 1.3–1.4x faster |',
  '',
  "- **The directions are solid; the digits are not.** An earlier revision of this table claimed the decomposition reproduced 'to within 1%', on one run. A second session moved Ghostty's SGR dispatch by 30% (54.1 -> 70.3 ns) while xterm's moved 7%, and per-parameter — derived by subtracting the short-SGR probe from the long one, so it carries both probes' noise — moved 10–14%. Only the per-cell figure held to a few percent. Quote the ordering and the rough magnitudes; re-measure before quoting a number, and treat any single-run three-significant-figure claim here as unsupported. This is the second time that specific mistake has reached these findings.",
  '- Ghostty is **faster where it matters and slower where it does not**. Real terminal output is overwhelmingly printable text, so a mixed flood goes its way; a stream of nothing but escape sequences would go the other way. A single CSI parameter costs Ghostty more than a whole cell write — the expense in this build is escape-sequence handling, not the per-cell path that grapheme and width correctness would suggest.',
  "- The vendored `ghostty-web@0.4.0` WASM is **scalar**: inspecting the binary shows zero `v128` types in any function signature and zero `v128` locals. Ghostty's native SIMD parser paths are not compiled into this build.",
  '- Even with `+simd128` enabled, WASM SIMD is fixed **128-bit** against native **AVX2** / AVX-512, plus bounds-checked linear-memory loads and JS↔WASM boundary cost. Measured, `+simd128` moved this build 0.5–2%, i.e. noise. **Placement 3** (native `libghostty` in the Rust backend) remains the only path to a materially faster parser — but it is no longer a rescue, since the parser already wins, and it would move terminal state out of WASM linear memory where the renderer reads it directly at zero cost.',
  '',
  '**A live pane and this harness measure the same, once both are measured the same way.** With DevTools closed the parser runs at **~12 ms/MB (~85 MB/s)** in both, varying about 7% between sessions and about 1% within one. The first matched pair was harness 11.14 against pane 11.61. Of the write, `coreWrite` is ~99% of the parse and the whole buffer handoff — alloc, copy into linear memory, free — is well under 1%.',
  '',
  '- Parse cost is **largely invariant to terminal state**, with one real exception. Measured and dead: **scrollback depth** (10,000 vs 1,000 retained rows), **backend contention** *(open)* (starving the producer to 69% idle changed nothing), **IPC queue depth**, and **engine or heap accumulation** (one engine, one terminal, ~8–10 MB linear memory at 80x24, ~19 MB at 200x60, stable in every state observed).',
  "- **Grid geometry does move the cell path, by about 11%.** This previously read 'invariant', on a live-pane flood where 1,161 vs 6,612 cells moved the total 1%. The probes separate it properly, because two of them write no cells at all — pinning 80x24 against 200x60 (1,920 vs 12,000 cells):",
  '',
  '| probe | Ghostty | xterm.js | writes cells |',
  '|---|---|---|---|',
  '| printable | 90.4 -> **79.1** MB/s (-12%) | 60.7 -> **53.9** (-11%) | yes |',
  '| short SGR | 54.3 -> 55.6 (+2%) | 107.7 -> 108.6 (+1%) | no |',
  '| long SGR | 105.5 -> 106.3 (+1%) | 158.6 -> 159.3 (0%) | no |',
  '| large flood | 77.4 -> 73.1 (-6%) | 61.3 -> 56.4 (-8%) | mixed |',
  '',
  '- Exactly the shape the decomposition predicts: escape-only probes flat, cell-writing probes down ~11–12%, a mixed flood between them. Both engines pay it about equally, so it changes no comparison — but a flood figure is only comparable against another at the same grid, and the live-pane measurement was diluted rather than invariant. `coreWrite` moved 10.9 -> 11.5 ms/MB across the same pair.',
  '- **The transport is not involved.** A pane fed from inside the page with no PTY, no SSH and no IPC measured 31.03 ms/MB against 30.26 over SSH *(both open)* — identical. This matters because this app has no local shell: the backend speaks SSH, telnet and serial, so every production measurement is a network one and the transport can only be controlled for from inside the page (`Ctrl+Alt+F`).',
  '- A separate real bug was found while chasing this: the engine can accept writes and parse none of them, reporting the fastest rate ever recorded. It is caught now — see `roundIsDead` here and the pre-ready buffer bound in `GhosttyEngine` — but it was **not** the cause of the gap above, despite arithmetic that appeared to fit. Two of three rounds dying would have produced almost exactly the observed ratio, and that coincidence was briefly published as the explanation.',
  '',
  '**A flood is bounded by memory, not by parse time — and that is what actually broke.** At 100 MB the Ghostty pane wedged outright, reproducibly on the third round. The cause was retention. `scrollbackLimit` is a **line count**, which the core multiplies by its per-line page cost in 32-bit `usize`; this side was passing a *byte* budget, so a normal 5000-line setting arrived as ~8,000,000, overflowed, and hit the core\'s `catch maxInt(usize)` fallback — meaning unlimited. 100 MB then retained all ~1.15 M rows and grew the WASM heap to ~2 GB until an allocation was refused, and every refusal was swallowed on a null pointer, so the pane stopped writing and stopped painting with nothing logged. Fixed here (`scrollbackLinesFor`, pinned by `scrollbackLimit.test.ts`); the vendored WASM was correct throughout. 100 MB x 3 rounds now drains with the heap flat at ~9 MB.',
  '',
  '**Where a flood spends its time now (100 MB into a live pane over LAN SSH, DevTools closed):** of the active window, **71% is inside `engine.write`**, 24% is the write scheduler pacing to a frame on purpose, and **4% is genuinely waiting on the producer**. Inside the write: `coreWrite` ~85%, the JS OSC scan ~11%, handlers ~3%. End to end that is ~48 MB/s delivered against a parser that alone sustains ~85.',
  '',
  '**The freezes were a scheduling problem, and fixing that was worth more than moving the parser off-thread.** The worst main-thread block was **106 ms** while a single delivery cost 3.5 ms — roughly thirty deliveries running back to back, because `onData` wrote synchronously the moment IPC handed bytes over and IPC had a queue behind it. Writes are now metered against the frame (`writeScheduler`): bytes go in immediately while the frame has budget, and once ~10 ms of a ~16.7 ms frame has gone on writing the rest waits for the next one. **106 ms -> 25 ms**, about 1.6 frames, for a few dozen lines. Interactive echo is untouched — a keystroke is one small delivery into an unspent budget and still goes in synchronously.',
  '',
  '- The cost is real and deliberate: time spent waiting for frames is time not spent parsing, so end-to-end throughput fell ~11%. Floods are the corner case and responsiveness is the point. `FRAME_BUDGET_MS` is the single knob, and it trades the two against each other directly.',
  '- **This largely supersedes Phase 8.** A Worker would remove the residual ~25 ms and recover the pacing cost, but that residual is partly paint, which a Worker does not touch. And it is expensive for *this* engine specifically: the renderer reads cells straight out of WASM linear memory (`GhosttyEngine.ts`, `updateStaticGrid`), so moving the parser off-thread moves terminal state with it and needs either `SharedArrayBuffer` — meaning a `ghostty-web` rebuilt with threads, which the vendored binary is not — or per-frame snapshots across the worker boundary. Same architectural cost as Placement 3, for a much smaller prize than when the parse looked slow.',
  '- The freeze measured 25.1 ms at every backpressure window tried, which is the scheduler bounding it independently of anything upstream.',
  '',
  '**The IPC queue was unbounded, and that was a crash rather than a slowdown.** `CONNECTION_EVENT_CHANNEL_BOUND` had bounded the forwarder\'s input for a long time and could never engage: `Channel::send` is fire-and-forget, so the forwarder always drained `rx` at full speed and the transport was never pushed back on. The growth was downstream, in the webview\'s own message queue — measured at ~50 MB resident on a 100 MB flood, and a function of how long the producer runs rather than of anything the frontend controls, so `yes` or `cat /dev/urandom` grows it until the process is killed. IPC offers the sender no signal (a successful send means queued, not read), so the frontend now reports what it has written and the forwarder waits when too much is outstanding; not draining `rx` lets it fill, which blocks the transport read loop, which for SSH closes the channel window and slows the remote host. The window was then **tuned rather than guessed** — the first value, 4 MB, starved the frontend for a fifth of the run:',
  '',
  '| window | genuinely starved | active window | worst freeze |',
  '|---|---|---|---|',
  '| 4 MB | 448 ms (19.2%) | 44.3 MB/s | 25.2 ms |',
  '| **16 MB** | **93 ms (4.3%)** | **47.6 MB/s** | 25.1 ms |',
  '| 32 MB | 54 ms (2.5%) | 48.8 MB/s | 25.1 ms |',
  '',
  '- Engine work was identical across those three runs (1553/1551/1543 ms inside write), so every difference is the window. Starvation collapses by 16 MB and then flattens; throughput moved only 10% because the scheduler took up the slack as starvation fell (pacing 328 -> 529 ms). **Past 16 MB the constraint is `FRAME_BUDGET_MS`, not the window.** Note it is per session, so N flooding panes hold N times this.',
  '',
  '**The JS OSC scan was the second-largest cost in the write, and is now flat across content shapes.** `scanOsc` exists only because `ghostty-web@0.4.0` surfaces neither OSC dispatch nor the bell, so they are recovered by scanning the stream — every delivered byte, in JS, at 2.38 ms/MB against the parser\'s ~12. Two rounds fixed it. The first replaced per-byte stepping with native `indexOf` jumps between `ESC` and `BEL`, which helped text (2.222 -> 0.431 ms/MB) far more than escapes (2.657 -> 1.563) — and escape-dense is what real traffic is, so the case that mattered barely moved.',
  '',
  '- **The second round hunts `]`, not `ESC`, which is what closed the gap.** An OSC can only open at `ESC ]`, so both find the same sequences, but escape-dense output recurs an ESC every few bytes while containing no `]` at all: hunting the ESC cost an `indexOf` call per escape to reject it, hunting the `]` costs one memchr that returns -1. Measured over 8 MB per shape: SGR-dense **1.522 -> 0.435** ms/MB (3.50x), typical SGR **1.077 -> 0.458** (2.35x), plain text 0.438 -> 0.444 (flat, already optimal). Against a live pane\'s 1.675 ms/MB and a parser at ~11.85, that is **~8-10% of the write** — roughly three-quarters of what deleting the scanner outright would buy, without touching the core.',
  '- **The trade is bracket-dense content, and it was measured rather than assumed.** Hunting `]` makes brackets the byte that stops the scan, and ordinary output is full of them. A `scan.indexOf(ESC) >= 0` probe bounds it: no ESC in the buffer means no OSC can open however many brackets there are, so JSON-shaped text skips the hunt entirely (0.426 -> 0.441, flat). Brackets *with* escapes still improved, 1.087 -> 0.789, because rejecting a bracket is rarer work than rejecting an escape. Only OSC-title-dense output got worse, 1.195 -> 1.237 (~3.5%), from the added ESC probe. Pinned by tests for a bracket at offset 0, brackets inside a payload, and a bell ordered ahead of a bracketed sequence.',
  "- **The share it costs tracked escape density before this; it no longer does.** A live LAN flood put the scan at ~11% of the write, a full harness suite at **15.6%** over 64 MB, a TUI-only run at **17.2%** over 0.24 MB — all because htop-shaped output is about as escape-dense as a terminal gets. With the scan flat at ~0.44 ms/MB regardless of shape, that spread should collapse; the figures above predate the change and need re-taking.",
  '- **The remaining ~3% is deletable, upstream.** Ghostty 1.3\'s C API exposes `ghostty_terminal_set()` callback slots including `BELL` and `TITLE_CHANGED`, and `coder/ghostty-web#169` demonstrates the WAT trampoline plumbing for that mechanism (it wires `WRITE_PTY`, `COLOR_*`, `SIZE`, kitty) — but leaves those two slots unused, still detecting the bell with `data.includes(0x07)`. That is both slower and wrong: it fires on the BEL that *terminates* an OSC, so a standard title sequence rings the bell, and its OSC handling is gated behind `typeof data === "string"` so it would never fire for the byte deliveries this app feeds. Those two slots also do not cover OSC 133/633, which this app registers, so deleting `scanOsc` needs a new OSC-event export as well — and now buys ~3% rather than ~11%.',
  '',
  '**Ghostty\'s escape cost is decomposed, and almost none of it is the SGR handler.** The shipping WASM carries a name section and full DWARF, so it profiles directly under `node --prof` — and reproduces the browser to within noise (54.3 MB/s short SGR against the browser\'s 54.3). The sampling profile is useless on its own: **95% of ticks land on one symbol**, `terminal.stream.Stream.nextNonUtf8`, because LLVM inlines the whole CSI parser into it. Differential probes (`tools/parse-probes/`) split the 71 ns of `ESC[0m` instead:',
  '',
  '| component | cost | evidence |',
  '| --- | --- | --- |',
  '| ESC + CSI state machine and dispatch | ~34 ns | `ESC7` 34.1, `ESC[H` 37.1 (0 params) |',
  '| leaving the no-parameter fast path | ~27 ns | CUP 37.1 -> 64.5, SGR 44.2 -> 71.2, both +27 |',
  '| SGR handler vs a trivial one | ~7 ns | `ESC[0m` 71.0 vs `ESC[0G` 63.9, identical envelope |',
  '| style table, when the pen ends non-default | +22 ns | `ESC[1m` 93.7 vs `ESC[0m` 71.9 |',
  '',
  '- **Additional parameters are cheap; the first one is not.** Each extra parameter costs 12–16 ns and each extra digit 2.7 ns, so accumulation is not the cost (the source confirms it: saturating mul/add, no allocation). The 27 ns is the one-time cost of leaving the zero-parameter shortcut and running `terminal.sgr.Parser`, which the name section shows is a real, non-inlined function.',
  '- **The style cost is a confirmed mechanism, not an inference.** The name section contains `terminal.Screen.manualStyleUpdate` and a `RefCountedSet(Style,u16,u16)` with `hash`, `insert`, `lookupContext`. Repeating `ESC[1m` when the pen is *already bold* still pays the full +22 ns, so there is no unchanged-style early-out; alternating bold/reset costs the average of the two, confirming the cost tracks "is the result non-default", not "did it change". A short-circuit is the only plausible local patch here, and it helps only when consecutive styles repeat.',
  '- **Escapes are purely additive — they do not damage the printable bulk path.** At one escape per 8 cells, summing the parts predicts 149.8 ns/unit and the measured figure is **150.2**. That density costs 97.0 -> 76.2 MB/s, so **21% is the entire prize** on escape-dense traffic, and only ~31% of a single SGR is plausibly removable. The other two components live inside Ghostty\'s `Stream`/`Parser` and are upstream restructuring, not a downstream patch.',
  '- Two probes had to be discarded: `ESC[0;0G` fires a parser warning through `env.log` 349,525 times per 2 MB — once per unit — so it measures a wasm->JS boundary crossing, not parsing. Any probe of an unhandled sequence needs a log counter to stay honest.',
  '',
  '**Upgrading the Ghostty core costs 2.9-4.1x on cell extraction, measured against a real build.** The premise that we are behind a release is wrong: `libghostty-vt` at tag **v1.3.1 has no terminal API and no render state at all** — it ships only `result`, `allocator`, `osc`, `sgr`, `key`, `paste`, `wasm`. `render.h`, `terminal.h` and `grid_ref.h` exist only on **main**. So every `ghostty_terminal_*` and `ghostty_render_state_*` export we use is ghostty-web\'s own 1738-line patch invention, not a stock API we are lagging on, and "upgrading" means tracking unreleased upstream. Main also needs **Zig 0.16.0**, against 0.15.2 for the current vendored build.',
  '',
  '- Built main for `wasm32-freestanding` (187 exports vs our 79) and drove its row/cell iterator directly (`tools/parse-probes/iter.mjs`), against today\'s single batched `get_viewport`:',
  '',
  '| grid | cells | iterate only | + 4x get | + get_multi | today | vs today |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| 80x24 | 1,920 | 6.8 us | 53.9 us | 40.0 us | 13.3 us | 4.1x / 3.0x |',
  '| 200x60 | 12,000 | 38.5 us | 336.5 us | 248.6 us | 85.4 us | 3.9x / 2.9x |',
  '',
  '- **The iteration is not the problem; the per-cell fetches are.** Stepping 12,000 cells costs 38.5 us — *cheaper* than today\'s batched read at 85.4 us. Everything above that is `row_cells_get` at ~6.2 ns a time, 48,000 of them for four attributes per cell. `get_multi` recovers ~26% by collapsing four boundary crossings into one, and that is all it does: `render.zig`\'s `get_multi` literally loops calling `get`, so it saves crossings and no work.',
  '- **Real but not a wall.** At 200x60 cell extraction goes from ~1% of a 120 Hz frame to ~3-4%. The earlier 3.0x-11.3x projection from call shapes alone was right at its optimistic end. Two caveats: this omits the JS-side readback of the fetched values (roughly +39 us at 200x60, so call it ~3.4x), and `DIRTY_PARTIAL` confines the full-grid case to floods and scrolls.',
  '- Also lost in the move, and not priced above: `has_response`/`read_response` are gone (replaced by a `WRITE_PTY` callback, and we drain synchronously at write time deliberately), and `is_row_wrapped` / scrollback line / scrollback grapheme / hyperlink URIs move behind `grid_ref`, which upstream has not wired up. Roughly 17 of our ~29 used exports change shape.',
  '',
  '**The coalescer flushes on a floor, not a cap.** `FLUSH_SIZE_THRESHOLD` means a delivery is *at least* that size and larger by however much the read that crossed it overshot. It was 32 KB; measuring the real path showed per-message IPC cost at ~40% on top of engine time, so it is now **256 KB**, worth 15.1 -> 19.7 MB/s on a 100 MB flood *(open — the direction holds, both sides were measured the same way, but the absolutes need re-taking)*. At that size the stall column in the tables above is floored by the frame interval and cannot discriminate between engines: **compare drain, not stall, and not parse** (parse is enqueue time for xterm — see the note above the tables). Over SSH from outside the LAN none of this applies: a remote flood measured 3.3 MB/s, link-bound, with the frontend idle 77% of the time.',
  '',
  '**Content shape does not move the parser, but it moves everything around it.** A newline-dense flood and a long-line flood measured 25.5 vs 25.6 MB/s end to end *(open)*, so the scroll and eviction path is not the cost and `PageList` is the wrong target. That test said nothing about escape sequences, though, because both payloads were plain ASCII — and the thing this build is slowest at is exactly escape handling (54–70 ns per SGR dispatch against xterm\'s 33–35). The OSC scan used to belong in this sentence too, at 3.6x more per byte on escape-dense input than on text; it is now flat across shapes and no longer a content-shape effect. Real traffic here is escape-dense. Any future content-shape claim should say which of these it is about.',
  '',
  "**The latency rows measure a fixed pipeline delay, not the workload.** Ghostty presents one display frame sooner than the xterm.js WebGL path — but read what the three rows actually say. At 120 Hz, xterm's p50 is 24.70 ms on keystroke echo, 24.70 on streaming and 24.70 on a full-screen TUI redraw; Ghostty's is 16.40 / 16.40 / 16.50. Those are exactly 3 and 2 frames, and the whole distribution of each row spans under 1 ms across 200, 400 and 120 trials. **A single echoed keystroke and a full htop repaint measure identically**, so these rows are not sensitive to the work at all: neither engine comes close to filling an 8.3 ms frame, and what is being measured is how many frames of pipeline each engine has between a write and a presented paint. Repeating the whole suite at 200x60 changed none of the six figures by more than 0.2 ms.",
  '',
  '- That is a real property and a real user-facing difference — one frame of lag, consistently — but it is a **constant, not a latency curve**. The three workloads are one number measured three times, not three independent confirmations, and the underlying difference in work is bounded somewhere between just over one frame and just under two rather than measured at 8.3 ms. At 60 Hz the same two engines may well land on the same frame count and show no difference.',
  "- Part of xterm's extra frame is its **write queue, not its renderer**. `term.write()` enqueues and returns, so parsing happens in a later macrotask and the render cannot start in the frame the bytes arrived; Ghostty parses synchronously inside the call. That difference is real and a user feels it, so it belongs in the number — but it is not evidence about the two renderers, and this section previously implied it was.",
  "- **The grid does not move them either.** An earlier revision of this section proposed that a larger grid would make these rows discriminate, 'the same reason 200x60 exists in the grid picker'. Run at 200x60 — 6.25x the cells — xterm reads 24.60 / 24.70 / 24.80 and Ghostty 16.40 / 16.40 / 16.50: unmoved, still exactly 3 and 2 frames. The pipeline constant dominates at every grid this harness offers, so the remedy proposed there does not work. Discriminating on work would need a payload deliberately sized to exceed a frame, not a bigger grid.",
  '- The honest claim these rows support is **"one frame of pipeline, invariant to workload and to grid"**. That is worth stating and worth keeping; it is not a throughput result and should never be quoted as one.',
  '',
  "- **Every latency row taken before the visibility guard (`8ba7459`) is suspect.** xterm.js stops rendering entirely when its host scrolls out of the viewport, latching `_needsFullRefresh` instead of painting, so `onRender` never fires and the trial is recorded as empty — while Ghostty's own rAF loop keeps painting. The TUI row ran at n=18 of 120 for exactly that reason, and nothing distinguished it from a complete run but a flag that was easy to read past. Runs now scroll both hosts into view, refuse to start if either is off screen, and abort if either leaves (see `hostVisibility.ts`). An `n` below the workload's trial count on an older export means the run was partly measured against a paused renderer.",
  '',
  '**The case for defaulting to Ghostty is the renderer, and the parser no longer argues against it:** it presents one display frame sooner than the xterm.js WebGL path — the same one frame on every latency workload, with the caveats above — reaches true background transparency the xterm path could not, and is at feature parity (four remaining gaps are upstream `ghostty-web@0.4.0` ABI limits, not renderer bugs — some of which the 1.3 core above would close). On top of that it parses a realistic flood 10–25% faster. The trade only inverts for a workload that is mostly escape sequences rather than text.',
  '',
  '**Net effect of this round, same flood, same session type, DevTools closed throughout:**',
  '',
  '| | before | after |',
  '|---|---|---|',
  '| worst main-thread freeze | 106.4 ms | **25.1 ms** |',
  '| peak webview backlog | ~50 MB, unbounded | **16 MB, bounded** |',
  '| JS OSC scan | 2.38 ms/MB | **1.675 ms/MB** |',
  '| whole write | 15.06 ms/MB | 14.1–15.0 ms/MB |',
  '| end-to-end delivery | 53.5 MB/s | 47.6 MB/s |',
  '| parser (`coreWrite`) | ~12 ms/MB | ~12 ms/MB, untouched |',
  '',
  '- The throughput is the price of the freeze, paid deliberately in the frame budget, and the parser was never the thing that changed.',
  '',
]
