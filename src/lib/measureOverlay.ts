/**
 * Runs the measurement tools from the keyboard and shows their output on the
 * page, so a live session can be measured with DevTools shut.
 *
 * This exists because of a specific, expensive failure. Both recorders were
 * reachable only from the console — `__wrusttyDelivery.report()` and
 * `__wrusttyPaneFlood.run()` — which meant an inspector was attached to every
 * production measurement ever taken. V8 compiles WebAssembly in a debuggable
 * tier while DevTools is open, and on this build that costs 2.75x: 11.14 ms/MB
 * closed against 30.65 open, one page, nothing else changed. So the instrument
 * could not be used without corrupting the thing it measured, and every number
 * it produced was wrong by a factor nobody suspected. The apparent "live pane
 * is 2.7x slower than the benchmark harness" gap — chased through the workload,
 * the grid, the scrollback, the transport, the backend and the page state —
 * was entirely this.
 *
 * The harness never had the problem because it renders its results on screen.
 * This gives the app the same property.
 *
 * Deliberately plain DOM rather than React: nothing exists until a shortcut is
 * pressed, and the overlay never participates in the app's render work, so it
 * cannot perturb the measurement the way a component subscribed to app state
 * might. It is also removed before a flood runs.
 */

import { report as deliveryReport, startRecording, stopRecording } from './deliveryStats'
import { run as runPaneFlood } from './paneFlood'
import { setInflightWindow } from './connection'

const OVERLAY_ID = 'wrustty-measure-overlay'
const BADGE_ID = 'wrustty-measure-badge'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node.style, style)
  if (text !== undefined) node.textContent = text
  return node
}

function dismiss(id: string): void {
  document.getElementById(id)?.remove()
}

/** A small corner marker while recording, so a session cannot be left armed
 *  without any sign of it — an unnoticed recorder is a slow pane forever. */
function showBadge(text: string): void {
  dismiss(BADGE_ID)
  const badge = el('div', {
    position: 'fixed',
    right: '12px',
    bottom: '12px',
    zIndex: '2147483646',
    padding: '6px 10px',
    borderRadius: '6px',
    background: '#7f1d1d',
    color: '#fecaca',
    font: '12px/1.4 ui-monospace, Consolas, monospace',
    pointerEvents: 'none',
  }, text)
  badge.id = BADGE_ID
  document.body.appendChild(badge)
}

function showReport(title: string, body: string): void {
  dismiss(OVERLAY_ID)
  const overlay = el('div', {
    position: 'fixed',
    inset: '5% 5% 5% 5%',
    zIndex: '2147483647',
    display: 'flex',
    flexDirection: 'column',
    background: '#0b0f14',
    color: '#d7dde5',
    border: '1px solid #2b3440',
    borderRadius: '10px',
    boxShadow: '0 20px 60px rgba(0,0,0,.6)',
    font: '12.5px/1.5 ui-monospace, Consolas, monospace',
  })
  overlay.id = OVERLAY_ID

  const header = el('div', {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
    borderBottom: '1px solid #2b3440',
    flex: '0 0 auto',
  })
  header.appendChild(el('strong', { flex: '1 1 auto' }, title))

  const copy = el('button', {
    padding: '5px 10px',
    borderRadius: '6px',
    border: '1px solid #2b3440',
    background: '#151b23',
    color: '#d7dde5',
    cursor: 'pointer',
    font: 'inherit',
  }, 'Copy')
  copy.onclick = () => {
    navigator.clipboard?.writeText(body).then(
      () => (copy.textContent = 'Copied'),
      () => (copy.textContent = 'Copy failed'),
    )
  }
  header.appendChild(copy)

  const close = el('button', {
    padding: '5px 10px',
    borderRadius: '6px',
    border: '1px solid #2b3440',
    background: '#151b23',
    color: '#d7dde5',
    cursor: 'pointer',
    font: 'inherit',
  }, 'Close (Esc)')
  close.onclick = () => dismiss(OVERLAY_ID)
  header.appendChild(close)

  overlay.appendChild(header)
  overlay.appendChild(
    el('pre', {
      margin: '0',
      padding: '12px',
      overflow: 'auto',
      flex: '1 1 auto',
      whiteSpace: 'pre',
    }, body),
  )
  document.body.appendChild(overlay)
}

let busy = false
let recording = false

/**
 * Backpressure windows to cycle through, in MB.
 *
 * The open question these answer: a 100 MB flood leaves the frontend idle 33%
 * of the active window, of which ~431 ms across 475 deliveries is genuine —
 * about 0.9 ms each. That is either the backpressure window being too tight, or
 * the IPC round trip showing through now that the queue is 4 MB deep instead of
 * 50. Raising the window separates them: if idle collapses, the window costs
 * throughput; if it does not move, 0.9 ms is inherent and 4 MB stands.
 */
const WINDOW_STEPS_MB = [4, 8, 16, 32]
let windowStep = 0

async function cycleInflightWindow(): Promise<void> {
  windowStep = (windowStep + 1) % WINDOW_STEPS_MB.length
  const mb = WINDOW_STEPS_MB[windowStep]
  try {
    const applied = await setInflightWindow(mb * 1024 * 1024)
    showBadge(`backpressure window ${(applied / 1048576).toFixed(0)} MB`)
  } catch (e) {
    showBadge(`window change failed: ${String(e)}`)
  }
  // Left visible briefly rather than pinned: it is a confirmation, not state,
  // and a badge that never clears would sit over a session for good.
  setTimeout(() => dismiss(BADGE_ID), 2500)
}

async function paneFlood(): Promise<void> {
  if (busy) return
  busy = true
  // Removed before the run, not after: the overlay is a large DOM node and the
  // point of this tool is to measure the pane, not the tool.
  dismiss(OVERLAY_ID)
  showBadge('flooding… (this takes a few seconds)')
  try {
    const text = await runPaneFlood(100)
    dismiss(BADGE_ID)
    showReport('Pane flood — no PTY, no SSH, no IPC', text)
  } catch (e) {
    dismiss(BADGE_ID)
    showReport('Pane flood failed', String(e))
  } finally {
    busy = false
  }
}

async function toggleDeliveryRecording(): Promise<void> {
  if (busy) return
  if (!recording) {
    dismiss(OVERLAY_ID)
    await startRecording()
    recording = true
    showBadge('recording delivery path — reproduce the flood, then Ctrl+Alt+D')
    return
  }
  busy = true
  try {
    stopRecording()
    recording = false
    dismiss(BADGE_ID)
    showReport('Delivery path — the real PTY route', await deliveryReport())
  } finally {
    busy = false
  }
}

/**
 * Ctrl+Alt+F floods the visible pane from inside the page; Ctrl+Alt+D arms and
 * then reports the real PTY delivery path; Ctrl+Alt+W cycles the backpressure
 * window. None of them needs the console.
 *
 * Chosen to sit beside Ctrl+Alt+B for the benchmark harness, and checked
 * against `code` rather than `key` so a terminal that has swallowed the keyboard
 * layout cannot change which shortcut fires.
 */
export function install(): void {
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !e.altKey) return
    if (e.code === 'KeyF') {
      e.preventDefault()
      void paneFlood()
    } else if (e.code === 'KeyD') {
      e.preventDefault()
      void toggleDeliveryRecording()
    } else if (e.code === 'KeyW') {
      e.preventDefault()
      void cycleInflightWindow()
    }
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById(OVERLAY_ID)) {
      e.preventDefault()
      dismiss(OVERLAY_ID)
    }
  })
}
