/**
 * Two fingers changing the font size, and a two-finger double-tap asking for the usual
 * size back. Only ever reports a whole size that differs from the last, since each one
 * rebuilds the renderer. The far end hears of the new grid once the sizes stop changing
 * (see ptyResize.ts).
 */

/** Longest a two-finger press can last and still be a tap. */
const TAP_MS = 300
/** Longest between two taps of a double-tap. */
const DOUBLE_TAP_MS = 400
/** How far the fingers can move apart or together, as a share, and still be a tap. */
const TAP_SLOP = 0.1

export interface TouchPinchHost {
  fontSize(): number
  setFontSize(size: number): void
  resetFontSize(): void
  /** Injected so tests can run a double-tap without waiting for one. */
  now?(): number
}

/** The size for a pinch that began at `startSize`, with the fingers `ratio` times as far
 * apart as they started. */
export function pinchedFontSize(
  startSize: number,
  ratio: number,
  range: { min: number; max: number },
): number {
  return Math.min(range.max, Math.max(range.min, Math.round(startSize * ratio)))
}

function spread(touches: TouchList): number {
  const [a, b] = [touches[0], touches[1]]
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

export class TouchPinch {
  private readonly target: HTMLElement
  private readonly host: TouchPinchHost
  private readonly range: { min: number; max: number }
  private pinch: {
    startSpread: number
    startSize: number
    lastSize: number
    startedAt: number
    moved: boolean
  } | null = null
  private lastTapAt: number | null = null

  constructor(target: HTMLElement, host: TouchPinchHost, range: { min: number; max: number }) {
    this.target = target
    this.host = host
    this.range = range
    target.addEventListener('touchstart', this.onStart, { passive: true })
    // Not passive: without canceling, the page itself may zoom.
    target.addEventListener('touchmove', this.onMove, { passive: false })
    target.addEventListener('touchend', this.onEnd)
    target.addEventListener('touchcancel', this.onEnd)
  }

  dispose(): void {
    this.target.removeEventListener('touchstart', this.onStart)
    this.target.removeEventListener('touchmove', this.onMove)
    this.target.removeEventListener('touchend', this.onEnd)
    this.target.removeEventListener('touchcancel', this.onEnd)
  }

  private onStart = (e: TouchEvent) => {
    if (e.touches.length !== 2) {
      this.pinch = null
      return
    }
    const startSpread = spread(e.touches)
    if (startSpread <= 0) return
    const startSize = this.host.fontSize()
    this.pinch = {
      startSpread,
      startSize,
      lastSize: startSize,
      startedAt: this.now(),
      moved: false,
    }
  }

  private onMove = (e: TouchEvent) => {
    const pinch = this.pinch
    if (!pinch || e.touches.length !== 2) return
    if (e.cancelable) e.preventDefault()
    const ratio = spread(e.touches) / pinch.startSpread
    if (Math.abs(ratio - 1) > TAP_SLOP) pinch.moved = true
    const size = pinchedFontSize(pinch.startSize, ratio, this.range)
    if (size === pinch.lastSize) return
    pinch.lastSize = size
    this.host.setFontSize(size)
  }

  private onEnd = (e: TouchEvent) => {
    if (e.touches.length >= 2) return
    const pinch = this.pinch
    this.pinch = null
    if (!pinch) return
    const now = this.now()
    if (pinch.moved || now - pinch.startedAt > TAP_MS) {
      this.lastTapAt = null
    } else if (this.lastTapAt !== null && now - this.lastTapAt <= DOUBLE_TAP_MS) {
      this.lastTapAt = null
      this.host.resetFontSize()
    } else {
      this.lastTapAt = now
    }
  }

  private now(): number {
    return this.host.now?.() ?? performance.now()
  }
}
