/**
 * Floods a real pane from inside the page, with no PTY, SSH or IPC: the
 * harness's generator and the coalescer's delivery sizes, one event-loop turn
 * each, straight into `engine.write`. The pane (grid, handlers, renderer, app
 * tree) is real; only the transport is gone, which separates engine cost from
 * transport cost.
 *
 * Diagnostic only; it installs a handle and waits.
 */

import { GhosttyEngine } from './ghostty/GhosttyEngine'
import * as writePhases from './writePhases'

/**
 * One unclamped macrotask (see the same note in the bench runner).
 */
function macrotaskYield(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => {
      ch.port1.close()
      resolve()
    }
    ch.port2.postMessage(null)
  })
}

/**
 * Above this, the run was almost certainly measured with an inspector
 * attached: V8 compiles WebAssembly in a debuggable tier while DevTools is
 * open (Liftoff with debug info, no TurboFan). Measured on one page: 11.14
 * ms/MB closed against 30.65 open. The threshold sits between the two modes,
 * so the report can flag it.
 */
const DEBUG_TIER_MS_PER_MB = 20

export async function run(mb = 100): Promise<string> {
  const engine = GhosttyEngine.activeEngine()
  if (!engine) return 'no live Ghostty pane to flood — open one first'

  // Imported here so the generator stays in the benchmark chunk.
  const { largeFlood, coalescedDeliveries, COALESCE_THRESHOLD } = await import('../bench/workloads')
  const built = largeFlood(mb).build(engine.cols, engine.rows)
  const buf = built.events[0]
  const chunk = built.chunkBytes ?? COALESCE_THRESHOLD

  // From a known state, so scrollback eviction is reached as in a real flood.
  engine.write('\x1bc')
  await macrotaskYield()

  writePhases.start()
  const t0 = performance.now()
  let offset = 0
  for (const size of coalescedDeliveries(buf.length, chunk)) {
    const end = Math.min(offset + size, buf.length)
    engine.write(buf.subarray(offset, end))
    offset = end
    // One delivery per turn, as the coalescer hands them over.
    await macrotaskYield()
  }
  const wallMs = performance.now() - t0
  writePhases.stop()

  const s = writePhases.snapshot()
  const text = formatFloodReport(
    { bytes: buf.length, cols: engine.cols, rows: engine.rows, wallMs },
    s.bytes > 0 ? s.totals.coreWrite / (s.bytes / 1048576) : 0,
    writePhases.formatReport(),
  )
  console.log(text)
  return text
}

export interface FloodRunInfo {
  bytes: number
  cols: number
  rows: number
  wallMs: number
}

/**
 * The report, with the run's sanity check on top. Pure, so the check is
 * testable without a core or pane.
 */
export function formatFloodReport(info: FloodRunInfo, msPerMb: number, phaseReport: string): string {
  const lines = [
    '=== pane flood (no transport) ===',
    `${(info.bytes / 1048576).toFixed(2)} MB into ${info.cols}x${info.rows} (${info.cols * info.rows} cells)`,
    `wall ${(info.wallMs / 1000).toFixed(2)} s including the yields between deliveries`,
    `core ${msPerMb.toFixed(2)} ms/MB`,
  ]
  if (msPerMb > DEBUG_TIER_MS_PER_MB) {
    lines.push(
      `!! ${msPerMb.toFixed(1)} ms/MB is roughly 3x this build's normal parse rate, which means`,
      `!! the WASM ran in V8's debuggable tier. Close DevTools completely and run again.`,
      `!! Every figure below is inflated; the JS phases are not, so their shares are wrong too.`,
    )
  }
  lines.push(phaseReport)
  return lines.join('\n')
}

/** Exposed so a live pane can be flooded from devtools. */
export function install(): void {
  ;(globalThis as Record<string, unknown>).__wrusttyPaneFlood = { run }
}
