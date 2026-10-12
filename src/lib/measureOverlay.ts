/**
 * Runs the measurement tools from the keyboard and shows their output on the
 * page, so a live session can be measured with DevTools closed (an open
 * inspector puts V8's WebAssembly in a slower debuggable tier).
 *
 * Plain DOM rather than React, so it doesn't take part in the app's render
 * work; it's removed before a flood runs.
 */

import { report as deliveryReport, startRecording, stopRecording } from './deliveryReport'
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
 * Backpressure windows to cycle through, in MB, to tell whether residual
 * frontend idle time comes from the window or from the IPC round trip: if
 * idle collapses as the window grows, the window costs throughput.
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
 * Ctrl+Alt+F floods the visible pane; Ctrl+Alt+D arms, then reports the real
 * PTY path; Ctrl+Alt+W cycles the backpressure window. Beside Ctrl+Alt+B
 * (the harness), and matched on `code` so layouts can't change them.
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
