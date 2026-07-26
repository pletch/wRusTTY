import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { XtermEngine } from './xtermEngine'
import { GhosttyEngine } from '../lib/ghostty/GhosttyEngine'
import { probeGpu, gpuVerdict, type GpuInfo } from './gpuProbe'
import * as writePhases from '../lib/writePhases'
import { WORKLOADS, capturedFlood, largeFlood, FLOOD_SIZES, COALESCE_THRESHOLD, type Workload } from './workloads'
import {
  runWorkload,
  warmup,
  resultsToMarkdown,
  measureFrameInterval,
  fmtDuration,
  type RunnableEngine,
  type WorkloadResult,
} from './runner'
import { PARITY, parityTotals, type ParityStatus } from './parity'
import '@xterm/xterm/css/xterm.css'

const THROUGHPUT_ROUNDS = 7
const BLOCK_ROUNDS = 3

/**
 * Grid sizes a run can be pinned to, rather than always taking whatever the
 * window happens to fit.
 *
 * Two of the renderer's costs scale with cell count and nothing else — the
 * per-cell parse in `updateStaticGrid` and the per-frame viewport buffer — so
 * a baseline measured only at ~80x24 cannot distinguish "this optimisation
 * did nothing" from "this grid was too small for it to matter". 200x60 is
 * about six times the cells, which is also a realistic maximised-window size
 * on a 1440p display.
 *
 * `fit` keeps the old behaviour (whatever the host container measures). Pinned
 * sizes call `resize` without `fit`, so the canvas can exceed its container —
 * the hosts clip, and a benchmark cares about the cell count the renderer
 * processes, not whether all of it is on screen.
 */
const GRID_SIZES = [
  { id: 'fit', label: 'Fit window', cols: 0, rows: 0 },
  { id: 'small', label: '80×24', cols: 80, rows: 24 },
  { id: 'large', label: '200×60', cols: 200, rows: 60 },
] as const

type GridSizeId = (typeof GRID_SIZES)[number]['id']

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()))
}

/** Adapts a concrete engine to the runner's minimal surface. */
function adapt(name: string, engine: XtermEngine | GhosttyEngine): RunnableEngine {
  return {
    name,
    write: (d) => engine.write(d),
    parse: (d) => engine.parse(d),
    onRender: (cb) => engine.onRender(cb),
    get cols() {
      return engine.cols
    },
    get rows() {
      return engine.rows
    },
    // Proof a flood round actually landed, rather than being accepted and
    // dropped — see `roundIsDead` in the runner.
    get scrollbackLength() {
      return engine.scrollbackLength
    },
  }
}

/** Writes a clear and waits for the first resulting paint — the readiness gate
 *  that matters for Ghostty, whose WASM core loads asynchronously. */
function awaitReady(engine: RunnableEngine, timeout = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      sub.dispose()
      clearTimeout(timer)
      resolve(ok)
    }
    const sub = engine.onRender(() => finish(true))
    const timer = setTimeout(() => finish(false), timeout)
    engine.write('\x1b[2J\x1b[H')
  })
}

const statusColor: Record<ParityStatus, string> = {
  parity: '#6ee7b7',
  better: '#7dd3fc',
  gap: '#fca5a5',
}

export function BenchmarkHarness() {
  const xtermHost = useRef<HTMLDivElement>(null)
  const ghosttyHost = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XtermEngine | null>(null)
  const ghosttyRef = useRef<GhosttyEngine | null>(null)
  const abRef = useRef<{ a: RunnableEngine; b: RunnableEngine } | null>(null)
  const initedRef = useRef(false)

  const [gpu, setGpu] = useState<GpuInfo | null>(null)
  const [phase, setPhase] = useState<'booting' | 'ready' | 'running'>('booting')
  const [progress, setProgress] = useState('')
  const [results, setResults] = useState<WorkloadResult[]>([])
  const [captured, setCaptured] = useState<Workload | null>(null)
  const [copied, setCopied] = useState(false)
  const [phaseReport, setPhaseReport] = useState('')
  const [saving, setSaving] = useState(false)
  const [frameMs, setFrameMs] = useState(0)
  // Off = feed floods the way the app does (coalescer-sized deliveries); the
  // realistic stall. On = one monolithic write; the raw-parser worst case.
  const [monolithic, setMonolithic] = useState(false)
  const [gridSize, setGridSize] = useState<GridSizeId>('fit')

  useEffect(() => {
    if (initedRef.current) return
    initedRef.current = true

    setGpu(probeGpu())

    const xterm = new XtermEngine({
      fontFamily: 'Consolas, monospace',
      fontSize: 14,
      scrollback: 5000,
      themeName: '',
      backgroundOpacity: 1,
    })
    const ghostty = new GhosttyEngine()
    xtermRef.current = xterm
    ghosttyRef.current = ghostty

    for (const e of [xterm, ghostty]) {
      e.setTheme('', 1)
      e.setFont('Consolas, monospace', 14)
      e.setScrollback(5000)
    }

    // The app registers a bell handler, which routes every write through
    // parseAndDispatch and its full-buffer scanOsc pass; without one the
    // harness took the shorter parseSegment path and so was not measuring the
    // code the app runs.
    //
    // It also buys a control. scanOsc is pure JS over the same bytes in the
    // same write, so `scan` in the phase report measures this thread's plain
    // JS speed alongside `coreWrite`'s WASM speed. Comparing scan ms/MB here
    // against a live pane separates "the whole thread is slower there" from
    // "the WASM specifically is slower there" — which nothing else has been
    // able to do, since every workload property measured identical in both.
    ghostty.onBell(() => {})

    xterm.mount(xtermHost.current!)
    ghostty.mount(ghosttyHost.current!)
    xterm.fit()
    ghostty.fit(true)

    const a = adapt('xterm', xterm)
    const b = adapt('ghostty', ghostty)
    abRef.current = { a, b }

    let cancelled = false
    ;(async () => {
      await awaitReady(a)
      await awaitReady(b)
      if (cancelled) return
      setProgress('warming up…')
      await warmup(a, b)
      if (cancelled) return
      // The display cadence, sampled once — latency below is frame-quantized,
      // so this is what makes it comparable across refresh rates.
      setFrameMs(await measureFrameInterval())
      if (cancelled) return
      setPhase('ready')
      setProgress('')
    })()

    return () => {
      cancelled = true
      xterm.dispose()
      ghostty.dispose()
    }
  }, [])

  /** Pins both engines to the selected grid before a run. Applied here rather
   *  than in an effect on `gridSize` so it always takes effect immediately
   *  before the measurement it belongs to, and so switching the selector
   *  between runs can't leave the engines mid-resize. */
  async function applyGridSize() {
    const xterm = xtermRef.current
    const ghostty = ghosttyRef.current
    if (!xterm || !ghostty) return
    const size = GRID_SIZES.find((g) => g.id === gridSize)!
    for (const e of [xterm, ghostty]) {
      if (size.cols === 0) e.fit(true)
      else e.resize(size.cols, size.rows)
    }
    // A resize reallocates the instance buffer and the viewport scratch buffer
    // on the Ghostty side and reflows xterm's; letting a few frames pass keeps
    // that cost out of the first round's numbers.
    for (let i = 0; i < 4; i++) await nextFrame()
  }

  async function runList(list: Workload[]) {
    const ab = abRef.current
    if (!ab || phase === 'running') return
    setPhase('running')
    setResults([])
    setProgress('sizing grid…')
    await applyGridSize()
    // The same recorder the live app uses, so the harness's Ghostty number and
    // a production flood are finally the same measurement rather than two that
    // were being compared on the assumption that they were. Only GhosttyEngine
    // reports into it, so this is a Ghostty-only breakdown regardless of which
    // engines run. xterm's figures are unaffected.
    writePhases.start()
    const collected: WorkloadResult[] = []
    for (const w of list) {
      const r = await runWorkload(ab.a, ab.b, w, {
        throughputRounds: THROUGHPUT_ROUNDS,
        blockRounds: BLOCK_ROUNDS,
        onProgress: setProgress,
      })
      collected.push(r)
      setResults([...collected])
    }
    writePhases.stop()
    setPhaseReport(writePhases.formatReport())
    setProgress('')
    setPhase('ready')
  }

  async function onCaptureFile(file: File) {
    const buf = new Uint8Array(await file.arrayBuffer())
    const w = capturedFlood(buf, file.name)
    setCaptured(w)
  }

  function exportMarkdown() {
    const verdict = gpu ? gpuVerdict(gpu) : { ok: false, text: 'GPU not probed' }
    const hz = frameMs > 0 ? ` (~${(1000 / frameMs).toFixed(0)} Hz)` : ''
    // The grid mode is recorded, not just the resulting dimensions: a `fit` run
    // is only reproducible on the same window size, and a diff between two
    // baselines taken at different cell counts is not a diff at all.
    const gridMode = GRID_SIZES.find((g) => g.id === gridSize)!
    const gridNote = gridMode.cols === 0 ? 'fit to window (not reproducible across window sizes)' : `pinned ${gridMode.label}`
    const meta = `Run at DPR ${window.devicePixelRatio}, ${frameMs.toFixed(1)} ms/frame${hz}, grid ${abRef.current?.a.cols}×${abRef.current?.a.rows} (xterm) / ${abRef.current?.b.cols}×${abRef.current?.b.rows} (ghostty) — ${gridNote}, ${THROUGHPUT_ROUNDS} throughput / ${BLOCK_ROUNDS} flood-stress rounds. Throughput = pure parse; latency = input→present; flood stress = worst main-thread stall.`
    // Appended rather than interleaved: it describes the Ghostty engine across
    // the whole run, not any one workload row, and it is the figure to compare
    // against a live session's `__wrusttyDelivery.report()`.
    const md = `${resultsToMarkdown(results, verdict.text, meta, frameMs)}\n\n\`\`\`\n${phaseReport}\n\`\`\`\n`
    navigator.clipboard.writeText(md).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  function downloadJson() {
    const payload = { gpu, results, generatedFrom: 'wrustty bench' }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'phase7-results.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  /**
   * Writes the flood-stress payload to a file so a live pane can be fed the
   * *exact* bytes this harness measures — `cat` it with `__wrusttyDelivery`
   * recording and the two paths become byte-identical.
   *
   * Worth having as a button rather than a shell approximation: the generator
   * is seeded and deterministic, so this is the only way to be certain the two
   * measurements differ in environment and not in input. The harness flood is
   * heavily escape-sequence laden (see floodLine) while a `yes` or `tr` flood
   * is ~100% printable, which is a difference in cells written per byte that
   * no shell one-liner reproduces by accident.
   */
  async function downloadFlood(mb: number) {
    // Generating 100 MB is a second or two of synchronous work that freezes the
    // webview, so the button has to repaint as busy *before* it starts —
    // otherwise the click looks like it did nothing and gets pressed again.
    setSaving(true)
    await nextFrame()
    await nextFrame()
    try {
      writeFloodFile(mb)
    } finally {
      setSaving(false)
    }
  }

  function writeFloodFile(mb: number) {
    const built = largeFlood(mb).build(abRef.current?.b.cols ?? 80, abRef.current?.b.rows ?? 24)
    const blob = new Blob([built.events[0] as BlobPart], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `wrustty-flood-${mb}mb.bin`
    a.click()
    URL.revokeObjectURL(url)
  }

  const verdict = gpu ? gpuVerdict(gpu) : null
  const totals = parityTotals()

  return (
    <div style={S.page}>
      <header style={S.header}>
        <h1 style={S.h1}>wRusTTY — Phase 7 benchmark</h1>
        <p style={S.sub}>
          Interleaved A/B of the xterm.js and Ghostty/WebGL engines, timed to frame presentation.
          Runs in this exact WebView. Do not touch the window while a run is in progress.
        </p>
      </header>

      {verdict && (
        <div style={{ ...S.banner, background: verdict.ok ? '#0f2a1e' : '#2a0f0f', borderColor: verdict.ok ? '#1f5c3f' : '#5c1f1f' }}>
          <strong style={{ color: verdict.ok ? '#6ee7b7' : '#fca5a5' }}>{verdict.ok ? 'GPU' : 'WARNING'}</strong>
          <span style={{ marginLeft: 8 }}>{verdict.text}</span>
          <span style={S.gpuMeta}>
            {gpu?.vendor ? `${gpu.vendor} · ` : ''}
            xterm WebGL: {xtermRef.current?.usingWebgl ? 'yes' : 'no (DOM fallback)'}
            {frameMs > 0 && ` · display ~${(1000 / frameMs).toFixed(0)} Hz (${frameMs.toFixed(1)} ms/frame)`}
          </span>
        </div>
      )}

      <div style={S.controls}>
        <button
          style={{ ...S.btn, ...S.btnPrimary, opacity: phase === 'ready' ? 1 : 0.5 }}
          disabled={phase !== 'ready'}
          onClick={() => runList(WORKLOADS)}
        >
          Run all workloads
        </button>
        {WORKLOADS.map((w) => (
          <button
            key={w.id}
            style={{ ...S.btn, opacity: phase === 'ready' ? 1 : 0.5 }}
            disabled={phase !== 'ready'}
            onClick={() => runList([w])}
            title={w.description}
          >
            {w.label}
          </button>
        ))}
        <span style={S.gridPicker}>
          Grid:
          {GRID_SIZES.map((g) => (
            <button
              key={g.id}
              style={{
                ...S.btn,
                ...(gridSize === g.id ? S.btnActive : null),
                opacity: phase === 'ready' ? 1 : 0.5,
              }}
              disabled={phase !== 'ready'}
              onClick={() => setGridSize(g.id)}
              title={
                g.cols === 0
                  ? 'Whatever the host container measures'
                  : `Pin both engines to ${g.cols}×${g.rows} = ${g.cols * g.rows} cells`
              }
            >
              {g.label}
            </button>
          ))}
        </span>
        <label style={{ ...S.btn, cursor: 'pointer' }}>
          Load capture…
          <input
            type="file"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && onCaptureFile(e.target.files[0])}
          />
        </label>
        {captured && (
          <button
            style={{ ...S.btn, opacity: phase === 'ready' ? 1 : 0.5 }}
            disabled={phase !== 'ready'}
            onClick={() => runList([captured])}
          >
            Run {captured.label}
          </button>
        )}
      </div>

      <div style={S.controls}>
        <span style={S.groupLabel} title="Longest main-thread stall while the flood drains — the freeze a user feels. By default the flood is fed the way the app delivers output (coalescer-sized deliveries across event-loop turns), so the stall is one production can actually produce.">
          Flood stress (max stall):
        </span>
        {FLOOD_SIZES.map((mb) => (
          <button
            key={mb}
            style={{ ...S.btn, opacity: phase === 'ready' ? 1 : 0.5 }}
            disabled={phase !== 'ready'}
            onClick={() => runList([largeFlood(mb, monolithic ? 0 : COALESCE_THRESHOLD)])}
            title={`Drain a ${mb} MB flood and report the worst main-thread stall it causes.`}
          >
            {mb} MB
          </button>
        ))}
        <label style={S.checkLabel} title="One monolithic write instead of coalescer-sized deliveries — the raw-parser worst case the app never actually produces.">
          <input type="checkbox" checked={monolithic} onChange={(e) => setMonolithic(e.target.checked)} />
          single write (worst case)
        </label>
        {/* Lets a live pane be fed the identical bytes, so a harness figure and
            a production one can be compared without the workload differing. */}
        <button
          style={{ ...S.smallBtn, opacity: saving ? 0.5 : 1 }}
          disabled={saving}
          onClick={() => downloadFlood(100)}
          title="Save this harness's exact 100 MB flood payload. `cat` it in a real pane with __wrusttyDelivery recording to compare the same bytes through both paths — a shell flood is ~100% printable, this one is heavily escape-laden."
        >
          {saving ? 'Generating 100 MB…' : 'Save flood bytes'}
        </button>
      </div>

      <div style={S.status}>
        {phase === 'booting' && <span>Booting engines… {progress}</span>}
        {phase === 'running' && <span style={{ color: '#fcd34d' }}>Running — {progress}</span>}
        {phase === 'ready' && results.length === 0 && <span style={{ opacity: 0.6 }}>Ready.</span>}
        {results.length > 0 && (
          <span style={{ display: 'flex', gap: 8 }}>
            <button style={S.smallBtn} onClick={exportMarkdown}>{copied ? 'Copied ✓' : 'Copy Markdown'}</button>
            <button style={S.smallBtn} onClick={downloadJson}>Download JSON</button>
          </span>
        )}
      </div>

      {results.length > 0 && (
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Workload</th>
              <th style={S.th}>Engine</th>
              <th style={S.thNum}>n</th>
              <th style={S.thNum}>mean</th>
              <th style={S.thNum}>p50</th>
              <th style={S.thNum}>p95</th>
              <th style={S.thNum}>p99</th>
              <th style={S.thNum}>max</th>
              <th style={S.thNum}>result</th>
            </tr>
          </thead>
          <tbody>
            {results.map((w) => {
              // Higher MB/s wins throughput; lower p50 latency wins latency.
              // A block row is judged on parse time, not on the worst stall:
              // once a delivery fits inside a frame the stall metric floors at
              // the display's refresh interval and reports the same number for
              // both engines however fast either one is, so picking a winner
              // on it was picking one on rounding noise.
              const better =
                w.mode === 'throughput'
                  ? w.results.reduce((m, r) => ((r.throughputMBs ?? 0) > (m.throughputMBs ?? 0) ? r : m))
                  : w.mode === 'block'
                    ? w.results.reduce((m, r) => ((r.parseMBs ?? 0) > (m.parseMBs ?? 0) ? r : m))
                    : w.results.reduce((m, r) => (r.stats.p50 < m.stats.p50 ? r : m))
              return w.results.map((r, i) => (
                <tr key={w.workloadId + r.engine} style={i === 0 ? S.rowTop : undefined}>
                  {i === 0 && (
                    <td style={S.td} rowSpan={2}>
                      <div style={{ fontWeight: 600 }}>{w.label}</div>
                      <div style={S.unit}>{w.unit}</div>
                    </td>
                  )}
                  <td style={{ ...S.td, fontWeight: r === better ? 700 : 400, color: r === better ? '#6ee7b7' : '#e5e7eb' }}>
                    {r.engine}
                    {r === better && ' ★'}
                    {r.failedTrials > 0 && <span style={S.warn}> ⛔{r.failedTrials}</span>}
                    {r.emptyTrials > 0 && <span style={S.warn}> ⚠{r.emptyTrials}</span>}
                  </td>
                  <td style={S.tdNum}>{r.stats.n}</td>
                  <td style={S.tdNum}>{r.stats.mean.toFixed(2)}</td>
                  <td style={S.tdNum}>{r.stats.p50.toFixed(2)}</td>
                  <td style={S.tdNum}>{r.stats.p95.toFixed(2)}</td>
                  <td style={S.tdNum}>{r.stats.p99.toFixed(2)}</td>
                  <td style={S.tdNum}>{r.stats.max.toFixed(2)}</td>
                  <td style={S.tdNum}>
                    {w.mode === 'throughput'
                      ? r.throughputMBs != null
                        ? `${r.throughputMBs.toFixed(1)} MB/s`
                        : '—'
                      : w.mode === 'block'
                        ? `⏸${frameMs > 0 ? (r.stats.max / frameMs).toFixed(1) : '?'}f · ${fmtDuration(r.parseMeanMs ?? 0)} parse (${(r.parseMBs ?? 0).toFixed(1)} MB/s) · ${fmtDuration(r.drainMeanMs ?? 0)} drain`
                        : frameMs > 0
                          ? `≈${(r.stats.p50 / frameMs).toFixed(1)} f`
                          : '—'}
                  </td>
                </tr>
              ))
            })}
          </tbody>
        </table>
      )}

      {/* The Ghostty engine's own breakdown, from the same recorder a live
          session uses — so the harness figure and a production flood can be
          compared directly instead of assumed comparable. */}
      {phaseReport !== '' && (
        <pre style={S.phases}>{phaseReport}</pre>
      )}

      <div style={S.engines}>
        <div>
          <div style={S.engineLabel}>xterm.js</div>
          <div ref={xtermHost} style={S.host} />
        </div>
        <div>
          <div style={S.engineLabel}>Ghostty / WebGL</div>
          <div ref={ghosttyHost} style={S.host} />
        </div>
      </div>

      <section style={S.parity}>
        <h2 style={S.h2}>
          Feature parity vs xterm.js
          <span style={S.parityTotals}>
            {totals.parity} parity · {totals.better} better ·{' '}
            <span style={{ color: statusColor.gap }}>{totals.gap} gaps ({totals.upstreamGaps} upstream)</span>
          </span>
        </h2>
        <div style={S.parityGrid}>
          {PARITY.map((p, i) => (
            <div key={i} style={S.parityRow}>
              <span style={{ ...S.dot, background: statusColor[p.status] }} />
              <span style={S.parityArea}>{p.area}</span>
              <span style={S.parityItem}>
                {p.item}
                {p.upstream && <span style={S.upstream}> · upstream</span>}
                {p.note && <span style={S.note}> — {p.note}</span>}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

const S: Record<string, CSSProperties> = {
  page: { fontFamily: 'system-ui, sans-serif', background: '#0b0c10', color: '#e5e7eb', minHeight: '100vh', padding: '24px 32px', boxSizing: 'border-box' },
  header: { marginBottom: 16 },
  h1: { fontSize: 22, margin: 0, fontWeight: 700 },
  sub: { fontSize: 13, opacity: 0.6, margin: '6px 0 0', maxWidth: 720, lineHeight: 1.5 },
  banner: { border: '1px solid', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16, display: 'flex', alignItems: 'center', flexWrap: 'wrap' },
  gpuMeta: { marginLeft: 'auto', opacity: 0.6, fontSize: 12 },
  controls: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' },
  groupLabel: { fontSize: 12, opacity: 0.6, marginRight: 2, cursor: 'help' },
  checkLabel: { fontSize: 12, opacity: 0.7, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', marginLeft: 4 },
  btn: { background: '#1a1c24', color: '#e5e7eb', border: '1px solid #2a2d3a', borderRadius: 6, padding: '7px 12px', fontSize: 13, cursor: 'pointer' },
  btnPrimary: { background: '#0ea5e9', borderColor: '#0ea5e9', color: '#04141f', fontWeight: 600 },
  btnActive: { background: '#243044', borderColor: '#3d5273', color: '#bfdbfe' },
  gridPicker: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, opacity: 0.85 },
  smallBtn: { background: '#1a1c24', color: '#93c5fd', border: '1px solid #2a2d3a', borderRadius: 5, padding: '4px 10px', fontSize: 12, cursor: 'pointer' },
  status: { fontSize: 13, minHeight: 30, display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 20 },
  th: { textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid #2a2d3a', color: '#94a3b8', fontWeight: 600 },
  thNum: { textAlign: 'right', padding: '6px 10px', borderBottom: '1px solid #2a2d3a', color: '#94a3b8', fontWeight: 600 },
  td: { padding: '6px 10px', borderBottom: '1px solid #17191f', verticalAlign: 'top' },
  tdNum: { padding: '6px 10px', borderBottom: '1px solid #17191f', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  rowTop: { borderTop: '1px solid #2a2d3a' },
  unit: { fontSize: 11, opacity: 0.5 },
  warn: { color: '#fca5a5' },
  phases: {
    fontSize: 11.5, lineHeight: 1.5, background: '#12141a', border: '1px solid #2a2d3a',
    borderRadius: 6, padding: '10px 12px', marginBottom: 20, overflowX: 'auto',
    color: '#cbd5e1', whiteSpace: 'pre',
  },
  engines: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 },
  engineLabel: { fontSize: 12, opacity: 0.6, marginBottom: 6 },
  host: { width: '100%', height: 320, position: 'relative', background: '#000', borderRadius: 6, overflow: 'hidden' },
  parity: { marginTop: 8 },
  h2: { fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'baseline', gap: 12 },
  parityTotals: { fontSize: 12, opacity: 0.8, fontWeight: 400 },
  parityGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 24px', marginTop: 10 },
  parityRow: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5, padding: '2px 0' },
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0, position: 'relative', top: 1 },
  parityArea: { width: 78, flexShrink: 0, opacity: 0.55 },
  parityItem: { flex: 1 },
  upstream: { color: '#fca5a5', opacity: 0.8 },
  note: { opacity: 0.45 },
}
