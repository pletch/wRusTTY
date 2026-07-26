/**
 * The four workloads Phase 7 names — interactive SSH, streaming (tail -f / a
 * verbose build), a TUI (htop), and a large `cat` flood — as deterministic byte
 * streams.
 *
 * Deterministic on purpose: a benchmark that fed each engine different bytes
 * would be comparing the engines *and* the input at once. Every generator is
 * seeded, built once, and the identical buffer is replayed to both engines and
 * across every round, so the only variable left is the engine.
 *
 * A real capture can be dropped in too (see `capturedFlood`) — synthetic
 * streams exercise the same parser and renderer paths, but "on real traffic" is
 * the exit criterion's own wording, so the option to measure an actual session
 * dump is here rather than assumed away.
 */

const enc = new TextEncoder()

/** Small deterministic PRNG (mulberry32) — no Math.random, so runs reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 'throughput' → one big write, timed to full presentation (parse + render).
 *  'latency'    → many small events, each timed input→present individually.
 *  'block'      → one big write, timed for the longest main-thread stall it
 *                 causes (the flood-freeze metric Phase 8 is meant to remove). */
export type WorkloadMode = 'throughput' | 'latency' | 'block'

export interface BuiltWorkload {
  /** Written and allowed to settle before the clock starts (e.g. enter alt screen). */
  setup?: Uint8Array
  /** The timed units. One element for throughput; many for latency. */
  events: Uint8Array[]
  /** Written after timing (e.g. leave alt screen), before the terminal is reset. */
  teardown?: Uint8Array
  totalBytes: number
  /**
   * Block workloads only: the coalescer's flush threshold to model the feed
   * against, across event-loop turns, instead of one monolithic write. Set to
   * `COALESCE_THRESHOLD` to measure the stall the app can actually produce; 0
   * or absent means a single write (the raw-parser / absolute-worst-case
   * number).
   *
   * Deliveries are not this size — they are at least it. See
   * `coalescedDeliveries`, which is what turns this into the actual sequence.
   */
  chunkBytes?: number
}

export interface Workload {
  id: string
  label: string
  mode: WorkloadMode
  /** What the number means, shown in the results table. */
  unit: string
  description: string
  /**
   * Whether this payload is expected to scroll the main screen.
   *
   * The runner proves a round happened by checking the buffer grew (see
   * `roundIsDead`), which a flood of ordinary output always does. A workload
   * that deliberately writes no cells — or one that redraws in place on the
   * alternate screen — would read as unparsed however well it parsed, so it
   * opts out here. Defaults to true: the guard exists because a silent failure
   * cost weeks, and opting out should be a decision, not an omission.
   */
  scrollsMainScreen?: boolean
  build(cols: number, rows: number): BuiltWorkload
}

const RESET = '\x1b[0m'
const FG = (n: number) => `\x1b[38;5;${n}m`

function bytesOf(parts: string[]): Uint8Array {
  return enc.encode(parts.join(''))
}

const FLOOD_NAMES = ['src', 'lib', 'index.ts', 'README.md', 'Cargo.toml', 'main.rs', 'node_modules', '.git', 'target', 'bench.log']
const FLOOD_WORDS = ['deploy', 'commit', 'render', 'buffer', 'context', 'viewport', 'scrollback', 'terminal', 'parser', 'atlas', 'glyph', 'session']

/**
 * One line of the mixed content a real scrollback holds — coloured `ls -l`, a
 * plain paragraph, an SGR-heavy diagnostic, or a box-drawing/Unicode row — in
 * the proportions a flood actually has, not a pathological best or worst case.
 * The parser meets SGR churn, newlines, wide/Unicode glyphs and long runs. The
 * leading line number is included.
 */
function floodLine(rand: () => number, line: number): string {
  const kind = rand()
  let s: string
  if (kind < 0.4) {
    // ls -l style: perms, size, coloured name
    const n = FLOOD_NAMES[(rand() * FLOOD_NAMES.length) | 0]
    const dir = rand() < 0.3
    const color = dir ? 34 : n.includes('.') ? 37 : 32
    s = `${FG(244)}-rw-r--r--${RESET}  ${FG(240)}1 tim staff${RESET} ${((rand() * 99999) | 0).toString().padStart(6)} ${FG(240)}Jul 24 10:${((rand() * 59) | 0).toString().padStart(2, '0')}${RESET} ${FG(color)}${n}${RESET}\r\n`
  } else if (kind < 0.7) {
    // paragraph text, default colours, long runs
    const w: string[] = []
    const count = 6 + ((rand() * 12) | 0)
    for (let i = 0; i < count; i++) w.push(FLOOD_WORDS[(rand() * FLOOD_WORDS.length) | 0])
    s = w.join(' ') + '.\r\n'
  } else if (kind < 0.85) {
    // heavy SGR churn — a coloured build/diagnostic line
    s = `${FG(196)}error${RESET}${FG(240)}[E${((rand() * 999) | 0).toString().padStart(4, '0')}]${RESET}: ${FG(255)}mismatched types${RESET} ${FG(33)}--> ${FLOOD_NAMES[(rand() * FLOOD_NAMES.length) | 0]}:${(rand() * 200) | 0}:${(rand() * 80) | 0}${RESET}\r\n`
  } else {
    // box drawing + a wide/Unicode sprinkle
    s = `${FG(51)}├─${RESET} ${FLOOD_WORDS[(rand() * FLOOD_WORDS.length) | 0]} ${FG(240)}······${RESET} 世界 ✓\r\n`
  }
  return `${line.toString().padStart(6)} ${s}`
}

/**
 * Builds `targetBytes` of flood content as one buffer, encoding in ~1 MB batches
 * so the intermediate string array stays bounded even at 100 MB (a single 100 MB
 * string-join array would balloon memory before it ever reached the parser).
 */
function generateFlood(targetBytes: number, seed: number): Uint8Array {
  const rand = rng(seed)
  const chunks: Uint8Array[] = []
  let parts: string[] = []
  let partsLen = 0
  let produced = 0
  let line = 0
  const flush = () => {
    if (!parts.length) return
    chunks.push(enc.encode(parts.join('')))
    parts = []
    partsLen = 0
  }
  while (produced < targetBytes) {
    const s = floodLine(rand, line++)
    parts.push(s)
    partsLen += s.length
    produced += s.length
    if (partsLen >= 1 << 20) flush()
  }
  flush()
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/**
 * Large `cat`: a few MB of mixed coloured output, timed to full presentation.
 * This is the *throughput* view — how fast each engine drains a modest flood.
 * For the freeze question at scale, see `largeFlood` (mode 'block').
 */
export const flood: Workload = {
  id: 'flood',
  label: 'Large cat (flood)',
  mode: 'throughput',
  unit: 'MB/s',
  description: '~3 MB of mixed coloured output written at once; timed to full presentation.',
  build() {
    const buf = generateFlood(3 * 1024 * 1024, 0x1234)
    return { events: [buf], totalBytes: buf.length }
  },
}

/**
 * Where the parse time actually goes: the byte-level state machine, the actions
 * it dispatches, or the per-cell work a printable character triggers.
 *
 * The question these answer. Ghostty's WASM parses at ~29 ns/byte, which at this
 * clock is 100+ cycles for every byte. A table-driven VT state machine costs a
 * handful of cycles per byte; even a careless one costs tens. And xterm.js — a
 * state machine in JavaScript — is about twice as fast on the same flood.
 * Compiled WASM losing to JIT'd JS is not a codegen story, so the suspicion is
 * that this build does far more work per *cell* than per byte: grapheme
 * segmentation, width, style resolution and PageList bookkeeping on every
 * printable character, with none of the SIMD fast paths that let native Ghostty
 * skip that route for runs of plain ASCII (the vendored binary has no v128 in
 * any signature or local).
 *
 * Why three and not two. Comparing printable text against `ESC [ 0 m` confounds
 * two things: the SGR stream writes no cells, but it also spends four bytes per
 * action against printable text's one, so a 4x result could mean either "cells
 * are expensive" or "actions are expensive and bytes are free". The long-SGR
 * variant separates them — same one action, five times the bytes. Read them as:
 *
 *   - long ≈ short (per byte)  → cost tracks bytes; the state machine itself is
 *     slow, and only native libghostty helps.
 *   - long >> short (per byte) → cost tracks actions, not bytes. Then compare
 *     cost per action: printable is 1 byte/action, short SGR is 4. If printable
 *     is far dearer per action, the per-cell path is the answer and it is the
 *     thing to attack.
 *
 * Deliberately plain ASCII with no wide or combining characters, so a slow
 * result cannot be blamed on Unicode: this is the cheapest cell there is.
 */
const PARSE_PROBE_BYTES = 2 * 1024 * 1024

/** Repeats `unit` until at least `targetBytes`, cut to a whole number of units
 *  so the stream never ends mid-sequence and leaves the parser mid-state. */
function repeatUnit(unit: string, targetBytes: number): Uint8Array {
  const bytes = enc.encode(unit)
  const count = Math.max(1, Math.floor(targetBytes / bytes.length))
  const out = new Uint8Array(bytes.length * count)
  for (let i = 0; i < count; i++) out.set(bytes, i * bytes.length)
  return out
}

/** Printable ASCII, one cell per byte — the per-cell cost, at its cheapest.
 *  80 columns then a wrap, matching the `tr '\0' 'x'` flood a live pane sees. */
export const parseCells: Workload = {
  id: 'parse-cells',
  label: 'Parse: printable (1 cell/byte)',
  mode: 'throughput',
  unit: 'MB/s',
  description: '2 MB of plain ASCII in 80-column lines. One parse action and one cell write per byte.',
  build() {
    const buf = repeatUnit('x'.repeat(80) + '\r\n', PARSE_PROBE_BYTES)
    return { events: [buf], totalBytes: buf.length }
  },
}

/** Well-formed SGR resets: fully parsed, pen state updated, no cell written and
 *  no page grown. Four bytes per action. */
export const parseShortSgr: Workload = {
  id: 'parse-sgr-short',
  label: 'Parse: short SGR (0 cells)',
  mode: 'throughput',
  unit: 'MB/s',
  description: '2 MB of ESC[0m. Fully parsed, one action per 4 bytes, no cell written.',
  scrollsMainScreen: false,
  build() {
    const buf = repeatUnit(RESET, PARSE_PROBE_BYTES)
    return { events: [buf], totalBytes: buf.length }
  },
}

/** The same single action carrying ten redundant parameters — five times the
 *  bytes through the state machine for identical work at the end of it. This is
 *  what separates per-byte cost from per-action cost. */
export const parseLongSgr: Workload = {
  id: 'parse-sgr-long',
  label: 'Parse: long SGR (0 cells)',
  mode: 'throughput',
  unit: 'MB/s',
  description: '2 MB of ESC[0;0;0;0;0;0;0;0;0;0m. Same one action as the short form, 5x the bytes.',
  scrollsMainScreen: false,
  build() {
    const buf = repeatUnit(`\x1b[${'0;'.repeat(9)}0m`, PARSE_PROBE_BYTES)
    return { events: [buf], totalBytes: buf.length }
  },
}

/**
 * The coalescer's flush *threshold* (`FLUSH_SIZE_THRESHOLD` in
 * src-tauri/src/coalesce.rs).
 *
 * Not a cap, which is what this constant was previously documented as. The
 * coalescer appends each upstream read to a buffer and flushes once that
 * buffer *reaches* the threshold:
 *
 *     buf.extend_from_slice(&bytes);
 *     if buf.len() >= FLUSH_SIZE_THRESHOLD { flush(...) }
 *
 * so a delivery is always at least the threshold and routinely larger — by
 * however much the read that crossed the line overshot. Feeding the engines
 * exactly the threshold therefore modelled a best case the app never actually
 * produces, and it mattered: a small delivery parses in well under a frame for
 * either engine, so the stall metric bottomed out at the display's refresh
 * interval and reported the same number no matter how fast the engine was.
 *
 * Mirrors `FLUSH_SIZE_THRESHOLD` in src-tauri/src/coalesce.rs and must be
 * changed with it — a harness modelling a coalescer the app no longer has
 * measures nothing useful. It was raised from 32 KB to 256 KB after measuring
 * the real path: at 32 KB the per-message IPC tax was ~40% on top of engine
 * time, paid once per delivery.
 *
 * Measured against the real path at 256 KB, this model holds up: real flushes
 * came out at a 257 KB median against a 256 KB threshold, which is exactly the
 * `threshold + overshoot` shape produced here. The 8 ms `FLUSH_INTERVAL` does
 * not take over at this size — 256 KB accumulates in ~6 ms at flood rates, so
 * the size branch still wins and only lulls flush on the ticker. What the
 * model does not reproduce is that minority of small ticker flushes, which is
 * why its mean delivery runs a little high.
 */
export const COALESCE_THRESHOLD = 256 * 1024

/**
 * One upstream read, before coalescing — an `ssh2` channel read, a serial
 * read, a PTY read. The coalescer sees a stream of these and batches them.
 *
 * The range is what bounds a delivery's overshoot past the flush threshold,
 * so it is the part of this model worth being explicit about rather than the
 * delivery size itself: deliveries come out as `threshold + (0, MAX_READ]`.
 */
const MIN_READ = 4 * 1024
const MAX_READ = 32 * 1024

/**
 * The delivery sizes `coalesce.rs` would emit for `total` bytes of output,
 * by running its actual accumulate-and-flush loop over simulated reads.
 *
 * Deterministic (seeded) like every other input here, so a run reproduces and
 * both engines are fed the identical sequence. Modelling the algorithm rather
 * than picking a size distribution is deliberate — the shape of the output
 * falls out of the threshold and the read size, which are both real numbers
 * taken from the Rust, instead of a curve invented to look plausible.
 */
export function coalescedDeliveries(total: number, threshold: number, seed = 0xc0a1): number[] {
  const rand = rng(seed)
  const out: number[] = []
  let remaining = total
  let buffered = 0
  while (remaining > 0) {
    const read = Math.min(remaining, MIN_READ + Math.floor(rand() * (MAX_READ - MIN_READ)))
    buffered += read
    remaining -= read
    if (buffered >= threshold) {
      out.push(buffered)
      buffered = 0
    }
  }
  if (buffered > 0) out.push(buffered)
  return out
}

/**
 * Flood stress at a chosen size, measured for the longest single main-thread
 * stall while the flood drains — the freeze a user feels, which is what Phase 8
 * (moving the parser to a Web Worker) would remove.
 *
 * `chunkBytes` decides which stall you measure. Fed the way the app actually
 * delivers output — the coalescer's accumulate-and-flush loop replayed over
 * simulated upstream reads, across event-loop turns — this is the stall
 * production can produce. Fed as one monolithic write (`chunkBytes: 0`), both
 * engines block for the whole parse; that's the raw-parser drain / absolute
 * worst case, not a case the coalescer lets happen.
 */
export function largeFlood(mb: number, chunkBytes = COALESCE_THRESHOLD, seed = 0x1234): Workload {
  const feed = chunkBytes > 0 ? `${(chunkBytes / 1024) | 0} KB+ feed` : 'single write'
  return {
    id: `flood-${mb}-${chunkBytes > 0 ? 'chunked' : 'mono'}`,
    label: `Flood ${mb} MB (${feed})`,
    mode: 'block',
    unit: `ms stall · ${feed}`,
    description: `${mb} MB flood, ${feed}; longest main-thread stall during the drain.`,
    build() {
      const buf = generateFlood(mb * 1024 * 1024, seed)
      return { events: [buf], totalBytes: buf.length, chunkBytes }
    },
  }
}

/** Sizes offered as one-click flood-stress runs. */
export const FLOOD_SIZES = [10, 50, 100]

/**
 * tail -f / verbose build: steady lines arriving one at a time. Timed as
 * latency — the thing that matters for a log you are watching is how long each
 * new line takes to land, not aggregate bytes.
 */
export const streaming: Workload = {
  id: 'streaming',
  label: 'Streaming (tail -f / build)',
  mode: 'latency',
  unit: 'ms/line',
  description: '400 log lines fed one at a time; per-line input→present latency.',
  build() {
    const rand = rng(0x5eed)
    const events: Uint8Array[] = []
    const levels = [`${FG(33)}INFO${RESET}`, `${FG(214)}WARN${RESET}`, `${FG(196)}ERROR${RESET}`, `${FG(40)}OK${RESET}`]
    const msgs = [
      'Compiling wrustty v0.1.0',
      'Fetching git dependency ghostty-web',
      'Running `tsc -b`',
      'bundled 482 modules in 1.4s',
      'GET /api/session 200 3ms',
      'connection established to 10.0.0.4:22',
      'flushing write buffer (16384 bytes)',
    ]
    let total = 0
    for (let i = 0; i < 400; i++) {
      const s = `${FG(240)}[${(1000 + i).toString()}.${((rand() * 999) | 0).toString().padStart(3, '0')}]${RESET} ${levels[(rand() * levels.length) | 0]} ${msgs[(rand() * msgs.length) | 0]}\r\n`
      const b = enc.encode(s)
      events.push(b)
      total += b.length
    }
    return { events, totalBytes: total }
  },
}

/**
 * htop-style TUI: the alternate screen, redrawn in full each frame from the
 * home position, with bars that move every frame so the whole grid is damaged
 * every time — the case that most stresses a "repaint only what changed"
 * renderer, because nothing is unchanged. Timed per frame.
 */
export const tui: Workload = {
  id: 'tui',
  label: 'TUI redraw (htop)',
  mode: 'latency',
  unit: 'ms/frame',
  description: '120 full-screen alternate-buffer redraws; per-frame input→present latency.',
  build(cols, rows) {
    const rand = rng(0xb00c)
    const events: Uint8Array[] = []
    const barWidth = Math.max(10, cols - 20)
    let total = 0
    for (let f = 0; f < 120; f++) {
      const parts: string[] = ['\x1b[H'] // home, no clear — overwrite in place like htop
      for (let r = 0; r < rows; r++) {
        if (r < 4) {
          // CPU/mem meter rows
          const pct = (Math.sin(f / 8 + r) * 0.5 + 0.5)
          const filled = (pct * barWidth) | 0
          const color = pct > 0.8 ? 196 : pct > 0.5 ? 214 : 40
          const bar = `${FG(color)}${'|'.repeat(filled)}${FG(238)}${' '.repeat(barWidth - filled)}${RESET}`
          parts.push(`${FG(45)}${r === 0 ? 'CPU' : r === 1 ? 'Mem' : 'Swp'}${RESET}[${bar}${(pct * 100).toFixed(1).padStart(5)}%]\x1b[K\r\n`)
        } else if (r === 4) {
          parts.push(`${FG(30)}  PID USER      PRI  NI  VIRT   RES   CPU% MEM%   TIME+  Command\x1b[K${RESET}\r\n`)
        } else {
          // process rows, values jittering each frame
          const pid = 100 + r + ((f * 3) % 7)
          const cpu = (rand() * 100).toFixed(1)
          const mem = (rand() * 20).toFixed(1)
          parts.push(`${(pid).toString().padStart(5)} tim        20   0  ${((rand() * 900) | 0)}M  ${((rand() * 90) | 0)}M  ${cpu.padStart(5)} ${mem.padStart(4)}  0:${((rand() * 59) | 0).toString().padStart(2, '0')} ${FG(rand() < 0.5 ? 250 : 40)}process_${r}\x1b[K${RESET}\r\n`)
        }
      }
      const b = bytesOf(parts)
      events.push(b)
      total += b.length
    }
    return {
      setup: enc.encode('\x1b[?1049h\x1b[H'), // enter alternate screen
      events,
      teardown: enc.encode('\x1b[?1049l'), // leave it
      totalBytes: total,
    }
  },
}

/**
 * Interactive SSH: a person typing. Each keystroke is its own event, echoed as
 * a single character (the loopback of a real echo), and timed on its own. This
 * is the keystroke-to-glyph latency that decides whether a session feels live.
 */
export const typing: Workload = {
  id: 'typing',
  label: 'Interactive (keystroke echo)',
  mode: 'latency',
  unit: 'ms/key',
  description: '200 single-character echoes; per-keystroke input→present latency.',
  build() {
    const sample = 'git commit -am "phase 7: measure both engines on windows"\r\nls -la /var/log && tail -f syslog\r\n'
    const events: Uint8Array[] = []
    let total = 0
    for (let i = 0; i < 200; i++) {
      const ch = sample[i % sample.length]
      const b = enc.encode(ch)
      events.push(b)
      total += b.length
    }
    return { events, totalBytes: total }
  },
}

/** Wrap a real captured session dump as a flood-stress workload — the "on real
 *  traffic" case the exit criterion names, fed the way the app delivers it (in
 *  coalescer-sized chunks) and measured for its worst main-thread stall. */
export function capturedFlood(bytes: Uint8Array, name: string, chunkBytes = COALESCE_THRESHOLD): Workload {
  const feed = chunkBytes > 0 ? `${(chunkBytes / 1024) | 0} KB+ feed` : 'single write'
  return {
    id: 'captured',
    label: `Captured: ${name}`,
    mode: 'block',
    unit: `ms stall · ${feed}`,
    description: `${(bytes.length / 1024 / 1024).toFixed(2)} MB real capture, ${feed}; longest main-thread stall during the drain.`,
    build() {
      return { events: [bytes], totalBytes: bytes.length, chunkBytes }
    },
  }
}

export const WORKLOADS: Workload[] = [typing, streaming, tui, flood, parseCells, parseShortSgr, parseLongSgr]
