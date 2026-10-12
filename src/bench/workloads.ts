/**
 * The benchmark workloads (interactive SSH, streaming, a TUI, a large `cat`
 * flood) as deterministic byte streams: seeded, built once, and replayed
 * identically to both engines every round, so only the engine varies. A real
 * capture can be used too (`capturedFlood`).
 */

const enc = new TextEncoder()

/** Small deterministic PRNG (mulberry32), so runs reproduce. */
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
 *  'block'      → one big write, timed for the longest main-thread stall. */
export type WorkloadMode = 'throughput' | 'latency' | 'block'

export interface BuiltWorkload {
  /** Written and allowed to settle before the clock starts. */
  setup?: Uint8Array
  /** The timed units. One element for throughput; many for latency. */
  events: Uint8Array[]
  /** Written after timing, before the terminal is reset. */
  teardown?: Uint8Array
  totalBytes: number
  /**
   * Block workloads only: the coalescer flush threshold to model the feed
   * against, across event-loop turns. `COALESCE_THRESHOLD` measures the stall
   * the app can produce; 0 or absent is one write (the raw worst case).
   * Deliveries are at least this size; see `coalescedDeliveries`.
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
   * Whether this payload scrolls the main screen. The runner proves a round
   * happened by checking the buffer grew (`roundIsDead`); a workload that
   * writes no cells or redraws on the alternate screen opts out. Defaults to
   * true so opting out is deliberate.
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
 * One line of realistic scrollback (colored `ls -l`, plain prose, an
 * SGR-heavy diagnostic, or box drawing with Unicode) in typical proportions,
 * with a leading line number.
 */
function floodLine(rand: () => number, line: number): string {
  const kind = rand()
  let s: string
  if (kind < 0.4) {
    // ls -l style: perms, size, colored name.
    const n = FLOOD_NAMES[(rand() * FLOOD_NAMES.length) | 0]
    const dir = rand() < 0.3
    const color = dir ? 34 : n.includes('.') ? 37 : 32
    s = `${FG(244)}-rw-r--r--${RESET}  ${FG(240)}1 tim staff${RESET} ${((rand() * 99999) | 0).toString().padStart(6)} ${FG(240)}Jul 24 10:${((rand() * 59) | 0).toString().padStart(2, '0')}${RESET} ${FG(color)}${n}${RESET}\r\n`
  } else if (kind < 0.7) {
    // Paragraph text, default colors, long runs.
    const w: string[] = []
    const count = 6 + ((rand() * 12) | 0)
    for (let i = 0; i < count; i++) w.push(FLOOD_WORDS[(rand() * FLOOD_WORDS.length) | 0])
    s = w.join(' ') + '.\r\n'
  } else if (kind < 0.85) {
    // Heavy SGR churn: a colored diagnostic.
    s = `${FG(196)}error${RESET}${FG(240)}[E${((rand() * 999) | 0).toString().padStart(4, '0')}]${RESET}: ${FG(255)}mismatched types${RESET} ${FG(33)}--> ${FLOOD_NAMES[(rand() * FLOOD_NAMES.length) | 0]}:${(rand() * 200) | 0}:${(rand() * 80) | 0}${RESET}\r\n`
  } else {
    // Box drawing with some wide/Unicode glyphs.
    s = `${FG(51)}├─${RESET} ${FLOOD_WORDS[(rand() * FLOOD_WORDS.length) | 0]} ${FG(240)}······${RESET} 世界 ✓\r\n`
  }
  return `${line.toString().padStart(6)} ${s}`
}

/**
 * Builds `targetBytes` of flood content, encoding in ~1 MB batches so memory
 * stays bounded at 100 MB.
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
 * Large `cat`: a few MB of mixed colored output, timed to full presentation
 * (throughput). For stalls at scale, see `largeFlood`.
 */
export const flood: Workload = {
  id: 'flood',
  label: 'Large cat (flood)',
  mode: 'throughput',
  unit: 'MB/s',
  description: '~3 MB of mixed colored output written at once; timed to full presentation.',
  build() {
    const buf = generateFlood(3 * 1024 * 1024, 0x1234)
    return { events: [buf], totalBytes: buf.length }
  },
}

/**
 * Where parse time goes: the byte-level state machine, the actions it
 * dispatches, or the per-cell work a printable character triggers.
 *
 * Three probes, since comparing printable text with `ESC [ 0 m` confounds
 * cells with bytes per action. The long-SGR variant is the same action with
 * five times the bytes:
 *
 *   - long ≈ short (per byte)  → cost tracks bytes; the state machine itself
 *     is slow.
 *   - long >> short (per byte) → cost tracks actions. Printable is 1
 *     byte/action and short SGR 4; if printable is far dearer per action, the
 *     per-cell path is the cost.
 *
 * Plain ASCII only, the cheapest cell, so Unicode can't be blamed.
 */
const PARSE_PROBE_BYTES = 2 * 1024 * 1024

/** Repeats `unit` to at least `targetBytes`, in whole units so the parser
 *  never ends mid-sequence. */
function repeatUnit(unit: string, targetBytes: number): Uint8Array {
  const bytes = enc.encode(unit)
  const count = Math.max(1, Math.floor(targetBytes / bytes.length))
  const out = new Uint8Array(bytes.length * count)
  for (let i = 0; i < count; i++) out.set(bytes, i * bytes.length)
  return out
}

/** Printable ASCII, one cell per byte: the per-cell cost at its cheapest.
 *  80 columns then a wrap. */
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

/** SGR resets: parsed and applied, no cell written. Four bytes per action. */
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

/** One action with ten redundant parameters: five times the bytes for the
 *  same work, separating per-byte from per-action cost. */
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
 * The coalescer's flush threshold (`FLUSH_SIZE_THRESHOLD` in
 * src-tauri/src/coalesce.rs); change them together.
 *
 * A threshold, not a cap: the coalescer flushes once its buffer reaches it,
 * so a delivery is the threshold plus the last read's overshoot. Measured on
 * the real path, flushes had a 257 KB median against 256 KB; the 8 ms
 * `FLUSH_INTERVAL` only flushes lulls. The model omits those small ticker
 * flushes, so its mean runs slightly high.
 */
export const COALESCE_THRESHOLD = 256 * 1024

/**
 * One upstream read before coalescing (SSH channel, serial or PTY). Its range
 * bounds a delivery's overshoot: deliveries are `threshold + (0, MAX_READ]`.
 */
const MIN_READ = 4 * 1024
const MAX_READ = 32 * 1024

/**
 * The delivery sizes `coalesce.rs` would emit for `total` bytes, by running
 * its accumulate-and-flush loop over seeded simulated reads.
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
 * Flood stress at a chosen size, measured for the longest main-thread stall
 * while it drains. Fed through the modeled coalescer, it's the stall the app
 * can produce; `chunkBytes: 0` is one monolithic write, the raw worst case.
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
 * tail -f / verbose build: lines arriving one at a time, timed as latency per
 * line.
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
 * htop-style TUI: the alternate screen redrawn in full from home each frame,
 * with every row changing, the worst case for damage tracking. Timed per
 * frame.
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
          // CPU/mem meter rows.
          const pct = (Math.sin(f / 8 + r) * 0.5 + 0.5)
          const filled = (pct * barWidth) | 0
          const color = pct > 0.8 ? 196 : pct > 0.5 ? 214 : 40
          const bar = `${FG(color)}${'|'.repeat(filled)}${FG(238)}${' '.repeat(barWidth - filled)}${RESET}`
          parts.push(`${FG(45)}${r === 0 ? 'CPU' : r === 1 ? 'Mem' : 'Swp'}${RESET}[${bar}${(pct * 100).toFixed(1).padStart(5)}%]\x1b[K\r\n`)
        } else if (r === 4) {
          parts.push(`${FG(30)}  PID USER      PRI  NI  VIRT   RES   CPU% MEM%   TIME+  Command\x1b[K${RESET}\r\n`)
        } else {
          // Process rows, jittering each frame.
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
 * Interactive SSH: each keystroke echoed as one character and timed on its
 * own (keystroke-to-glyph latency).
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

/** Wraps a captured session dump as a flood-stress workload, fed in
 *  coalescer-sized chunks and measured for its worst stall. */
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
