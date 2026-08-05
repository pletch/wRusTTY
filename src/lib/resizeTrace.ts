/**
 * A trace of everything that can move a pane's row count, plus what the remote
 * says immediately afterwards.
 *
 * Exists for one open question: apt's fancy progress bar drifts up a row each
 * time you switch tabs and come back, leaving a fossil of the previous bar
 * behind. The bar is pinned to the last row with DECSTBM, so it only strands
 * like that if the region's bottom moves — either because the row count
 * genuinely changed, or because the region was reset out from under the program
 * while output was still scrolling. Both were reproduced headlessly, against
 * *both* ghostty builds, so the core is not the variable; what is missing is
 * which of them the live app does, and when.
 *
 * The status bar cannot answer it. `reportDimensions` goes through React state,
 * so a 37 corrected to 38 inside one frame batches into a single render at 38 —
 * the transient is real and invisible. Hence a trace with its own clock.
 *
 * Off by default and free when off: every hook is one boolean read, and the
 * byte capture below is armed only in the window after a resize.
 *
 * ## Turning it on
 *
 * In the dev build (`npm run tauri:dev`), from the devtools console:
 *
 *     localStorage.setItem('wrustty.resizeTrace', '1')   // then reload
 *     __resizeTrace.dump()                               // print what happened
 *     copy(__resizeTrace.text())                         // ...or copy it out
 *
 * In a packaged build, set `VITE_WRUSTTY_RESIZE_TRACE=1` at build time.
 *
 * `__resizeTrace.on()` / `.off()` toggle it live without a reload, for when the
 * interesting thing is already on screen.
 */

const KEY = 'wrustty.resizeTrace'
/** Enough for a few minutes of tab switching; oldest entries fall off. */
const MAX_ENTRIES = 2000
/** Inbound bytes captured after a resize, per arming. Bounded because a flood
 *  during an apt run would otherwise bury the sequences worth reading. */
const CAPTURE_BYTES = 320

let enabled = false
let entries: string[] = []
let t0 = 0
/** Bytes still to capture from the inbound stream; 0 means disarmed. */
let armed = 0

function readFlag(): boolean {
  if (import.meta.env?.VITE_WRUSTTY_RESIZE_TRACE === '1') return true
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    // A webview with storage disabled is not a reason to fail at import time.
    return false
  }
}

export function isEnabled(): boolean {
  return enabled
}

export function on(): void {
  enabled = true
  t0 = performance.now()
  entries = []
  try {
    localStorage.setItem(KEY, '1')
  } catch { /* not fatal — the flag is a convenience, the flag variable is the truth */ }
}

export function off(): void {
  enabled = false
  try {
    localStorage.removeItem(KEY)
  } catch { /* as above */ }
}

/**
 * One line of trace.
 *
 * Fields are rendered rather than kept as objects so the buffer holds strings a
 * human can page through, and so a caller cannot accidentally retain a DOM node
 * or a wasm view by putting it in the record.
 */
export function log(tag: string, fields: Record<string, unknown> = {}): void {
  if (!enabled) return
  const at = (performance.now() - t0).toFixed(1).padStart(9)
  const rest = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? round(v) : String(v)}`)
    .join(' ')
  push(`${at}ms ${tag.padEnd(14)} ${rest}`)
}

/** Two decimals, but only when they say something — row counts are integers and
 *  container heights are not. */
function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3)
}

function push(line: string): void {
  entries.push(line)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
}

/**
 * Start capturing inbound bytes.
 *
 * Called right after anything that could have told the remote its size changed,
 * because the question is what the remote does *next*: a program that reacts to
 * SIGWINCH re-emits its scroll region (`ESC[1;Nr`) and re-addresses the cursor,
 * and that is the difference between "we resized it" and "we moved its output
 * without telling it".
 */
export function armCapture(why: string): void {
  if (!enabled) return
  armed = CAPTURE_BYTES
  log('capture-armed', { why })
}

/** Feed the inbound stream. Costs one boolean read when off or disarmed. */
export function captureInbound(data: Uint8Array): void {
  if (!enabled || armed <= 0) return
  const take = Math.min(armed, data.length)
  armed -= take
  push(`          bytes-in       ${escapeBytes(data.subarray(0, take))}`)
  if (armed === 0) push('          bytes-in       …capture full')
}

/**
 * Every scroll-region change in the stream, whenever it happens.
 *
 * The capture window above only covers the moments just after a resize, and the
 * sequence that matters most may not land there — a program can re-establish
 * its region at any point, and a region that quietly becomes the full screen is
 * exactly what lets a later newline drag a pinned status line up a row. So
 * `ESC [ … r` is picked out of the whole stream, with its parameters.
 *
 * A scan over every inbound byte, and therefore strictly a tracing-only cost:
 * it runs nowhere near the hot path unless the flag is on.
 */
export function scanRegions(data: Uint8Array): void {
  if (!enabled) return
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] !== 0x1b || data[i + 1] !== 0x5b) continue // ESC [
    let j = i + 2
    // A private-parameter marker (`?`) leads the alt-screen modes.
    const priv = data[j] === 0x3f
    if (priv) j++
    // Parameters are digits and semicolons; anything else ends the sequence.
    const from = j
    while (j < data.length && ((data[j] >= 0x30 && data[j] <= 0x39) || data[j] === 0x3b)) j++
    if (j >= data.length) return
    const params = new TextDecoder().decode(data.subarray(from, j))
    if (!priv && data[j] === 0x72) {
      // 'r' — DECSTBM. No parameters at all means "reset to the full screen",
      // which is the interesting case and reads as an empty string.
      log('DECSTBM', { params: params === '' ? '(reset to full screen)' : params })
    } else if (priv && (data[j] === 0x68 || data[j] === 0x6c) && ALT_SCREEN.has(params)) {
      // The alternate screen. Leaving it restores the primary screen wholesale,
      // which is the other way a pinned region can vanish without anyone
      // resizing anything — a debconf prompt mid-upgrade is exactly that.
      log('alt-screen', { mode: params, action: data[j] === 0x68 ? 'enter' : 'leave' })
    }
    i = j
  }
}

/** The modes that swap screens: the modern one, and the two it superseded. */
const ALT_SCREEN = new Set(['1049', '1047', '47'])

/**
 * Readable escapes: `ESC` spelled out, other control bytes as hex, printable
 * ASCII as itself. A raw dump of this is unreadable in a console and, worse,
 * re-interpreted by whatever the reader pastes it into.
 */
function escapeBytes(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) {
    if (b === 0x1b) out += '⟨ESC⟩'
    else if (b === 0x0d) out += '⟨CR⟩'
    else if (b === 0x0a) out += '⟨LF⟩'
    else if (b < 0x20 || b === 0x7f) out += `⟨${b.toString(16).padStart(2, '0')}⟩`
    else if (b < 0x7f) out += String.fromCharCode(b)
    else out += '·'
  }
  return out
}

/** The trace as text, for copying out. */
export function text(): string {
  return entries.join('\n')
}

export function dump(): void {
  // eslint-disable-next-line no-console
  console.log(entries.length ? text() : 'resize trace is empty (is it enabled?)')
}

export function clear(): void {
  entries = []
  t0 = performance.now()
}

enabled = readFlag()
if (enabled) t0 = performance.now()

// Reachable from the devtools console without importing anything.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__resizeTrace = {
    on, off, dump, text, clear, isEnabled,
  }
}
