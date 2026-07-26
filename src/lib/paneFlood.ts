/**
 * Floods a real pane from inside the page, with no PTY, no SSH and no IPC.
 *
 * Why this exists. A live pane parses ~2.66x slower than the benchmark harness
 * running the same WASM in the same WebView, with identical page state (one
 * engine, one terminal, comparable linear memory). Content, delivery size,
 * scrollback, backend contention, queue depth and engine accumulation were each
 * measured and cleared. Two candidates were left, and they were confounded:
 * every production measurement came over SSH, and every production pane runs a
 * grid around six times larger than any the harness had ever measured.
 *
 * Separating them needs a pane fed without a transport, and this app cannot
 * open one — the backend speaks SSH, telnet and serial, and there is no local
 * shell to `cat` a file in. So the bytes are injected on this side instead: the
 * harness's own generator, the coalescer's own delivery sizes, one event-loop
 * turn each, straight into `engine.write`. Everything about the pane is real —
 * its grid, its OSC and bell handlers, its renderer, the app tree around it.
 * Only the transport is gone.
 *
 * Read the result against two numbers:
 *   - ~30 ms/MB (what a pane over SSH measures) means the transport is not the
 *     cause, and grid size is the last candidate standing.
 *   - ~11 ms/MB (what the harness measures) means it is, and the timing inside
 *     the SSH runs — 75% of the parse happening after the backend went idle,
 *     with a 7% spread across deliveries — needs explaining.
 *
 * Diagnostic only. Nothing calls it; it installs a handle and waits.
 */

import { GhosttyEngine } from './ghostty/GhosttyEngine'
import * as writePhases from './writePhases'

/**
 * One macrotask, unclamped. `setTimeout(0)` is clamped to 4 ms once nested five
 * deep, which a feed loop is by its sixth turn — that alone would dominate the
 * measurement. See the same note in the bench runner.
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

async function run(mb = 100): Promise<string> {
  const engine = GhosttyEngine.activeEngine()
  if (!engine) return 'no live Ghostty pane to flood — open one first'

  // Imported here so the generator ships in the benchmark chunk it already
  // belongs to rather than in the app bundle.
  const { largeFlood, coalescedDeliveries, COALESCE_THRESHOLD } = await import('../bench/workloads')
  const built = largeFlood(mb).build(engine.cols, engine.rows)
  const buf = built.events[0]
  const chunk = built.chunkBytes ?? COALESCE_THRESHOLD

  // From a known state, so scrollback eviction is reached the same way a real
  // flood reaches it rather than partway through whatever was on screen.
  engine.write('\x1bc')
  await macrotaskYield()

  writePhases.start()
  const t0 = performance.now()
  let offset = 0
  for (const size of coalescedDeliveries(buf.length, chunk)) {
    const end = Math.min(offset + size, buf.length)
    engine.write(buf.subarray(offset, end))
    offset = end
    // One delivery per turn, matching what the coalescer hands over.
    await macrotaskYield()
  }
  const wallMs = performance.now() - t0
  writePhases.stop()

  const text = [
    `=== pane flood (no transport) ===`,
    `${(buf.length / 1048576).toFixed(2)} MB into ${engine.cols}x${engine.rows} (${engine.cols * engine.rows} cells)`,
    `wall ${(wallMs / 1000).toFixed(2)} s including the yields between deliveries`,
    writePhases.formatReport(),
  ].join('\n')
  console.log(text)
  return text
}

/** Exposed so a live pane can be flooded from devtools with no UI. */
export function install(): void {
  ;(globalThis as Record<string, unknown>).__wrusttyPaneFlood = { run }
}
