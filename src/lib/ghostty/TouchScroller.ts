/**
 * One finger dragging the terminal, reported in whole rows.
 *
 * A tap has to stay a tap, since the mouse events it synthesizes are what focus
 * the terminal and open the keyboard. So nothing is claimed until the finger has
 * moved past `SLOP_PX`, and only then is `touchmove` canceled, which is what stops
 * those mouse events.
 */

/** Movement below this is a shaky tap. */
const SLOP_PX = 10
/** The stretch of a drag that sets a flick's speed. */
const VELOCITY_WINDOW_MS = 100
/** Slower than this at release, in px/ms, and the finger just stopped. */
const MIN_FLING_SPEED = 0.25
const MAX_FLING_SPEED = 6
/** Where a flick gives up, in px/ms. */
const STOP_FLING_SPEED = 0.03
/** How quickly a flick loses speed: the time to fall to about a third. */
const FLING_DECAY_MS = 325
/** How long a finger has to stay put to be a long press. */
const LONG_PRESS_MS = 450

export interface TouchScrollerHost {
  /** Pixels in a row, or 0 before the terminal has a size. */
  rowHeight(): number
  /** Positive when the finger moved down, which brings up older text. */
  scroll(rows: number, x: number, y: number): void
  /** Whether a flick should carry on after release. */
  canFling(): boolean
  /** The finger stayed put. True claims the rest of the gesture for the press. */
  longPress?(x: number, y: number): boolean
  /** A claimed press moved, without lifting. */
  longPressMove?(x: number, y: number): void
  longPressEnd?(): void
  /** A tap, before it reaches the terminal. True swallows it. */
  consumeTap?(): boolean
  /** Injected so tests can run a flick without waiting for one. */
  now?(): number
}

export class TouchScroller {
  private readonly target: HTMLElement
  private readonly host: TouchScrollerHost
  private drag: { startY: number; lastY: number; x: number; y: number; scrolling: boolean } | null = null
  private samples: { t: number; y: number }[] = []
  /** Pixels not yet making up a whole row. */
  private remainder = 0
  private flingFrame: number | null = null
  /** The touch that stopped a flick, whose tap shouldn't also reach the terminal. */
  private swallowTap = false
  private pressTimer: ReturnType<typeof setTimeout> | null = null
  /** A long press has claimed this gesture. */
  private pressing = false

  constructor(target: HTMLElement, host: TouchScrollerHost) {
    this.target = target
    this.host = host
    target.addEventListener('touchstart', this.onStart, { passive: true })
    // Not passive: canceling is how a drag claims the gesture.
    target.addEventListener('touchmove', this.onMove, { passive: false })
    target.addEventListener('touchend', this.onEnd)
    target.addEventListener('touchcancel', this.onCancel)
  }

  dispose(): void {
    this.stopFling()
    this.stopPressTimer()
    this.target.removeEventListener('touchstart', this.onStart)
    this.target.removeEventListener('touchmove', this.onMove)
    this.target.removeEventListener('touchend', this.onEnd)
    this.target.removeEventListener('touchcancel', this.onCancel)
  }

  private now(): number {
    return this.host.now?.() ?? performance.now()
  }

  private onStart = (e: TouchEvent) => {
    this.swallowTap = this.flingFrame !== null
    this.stopFling()
    this.stopPressTimer()
    this.pressing = false
    this.remainder = 0
    // Two fingers aren't a scroll.
    if (e.touches.length !== 1) {
      this.drag = null
      return
    }
    const t = e.touches[0]
    this.drag = { startY: t.clientY, lastY: t.clientY, x: t.clientX, y: t.clientY, scrolling: false }
    this.samples = [{ t: this.now(), y: t.clientY }]
    if (this.host.longPress) {
      const { clientX: x, clientY: y } = t
      this.pressTimer = setTimeout(() => {
        this.pressTimer = null
        if (this.drag && this.host.longPress?.(x, y)) this.pressing = true
      }, LONG_PRESS_MS)
    }
  }

  private onMove = (e: TouchEvent) => {
    const drag = this.drag
    if (!drag) return
    if (e.touches.length !== 1) {
      this.stopPressTimer()
      this.drag = null
      return
    }
    const y = e.touches[0].clientY
    if (this.pressing) {
      if (e.cancelable) e.preventDefault()
      this.host.longPressMove?.(e.touches[0].clientX, y)
      return
    }
    if (!drag.scrolling) {
      if (Math.abs(y - drag.startY) < SLOP_PX) return
      this.stopPressTimer()
      drag.scrolling = true
      // From here, not the start, or the row of slack lands as a jump.
      drag.lastY = y
    }
    if (e.cancelable) e.preventDefault()
    this.apply(y - drag.lastY)
    drag.lastY = y
    this.samples.push({ t: this.now(), y })
    const oldest = this.now() - VELOCITY_WINDOW_MS
    while (this.samples.length > 2 && this.samples[0].t < oldest) this.samples.shift()
  }

  private onEnd = (e: TouchEvent) => {
    const drag = this.drag
    this.drag = null
    this.stopPressTimer()
    if (this.pressing) {
      this.pressing = false
      // Otherwise the lift synthesizes a click on what was just selected.
      if (e.cancelable) e.preventDefault()
      this.host.longPressEnd?.()
      return
    }
    const tap = !drag?.scrolling
    // Asked even for the tap that stopped a flick, but only for a real tap.
    const consumed = tap && drag !== null && this.host.consumeTap?.() === true
    if ((consumed || (this.swallowTap && tap)) && e.cancelable) e.preventDefault()
    this.swallowTap = false
    if (!drag?.scrolling || !this.host.canFling()) return
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const elapsed = last.t - first.t
    if (elapsed <= 0 || this.now() - last.t > VELOCITY_WINDOW_MS) return
    const speed = (last.y - first.y) / elapsed
    if (Math.abs(speed) < MIN_FLING_SPEED) return
    this.fling(
      Math.sign(speed) * Math.min(Math.abs(speed), MAX_FLING_SPEED),
      drag.x,
      drag.y,
    )
  }

  private onCancel = () => {
    this.stopPressTimer()
    if (this.pressing) this.host.longPressEnd?.()
    this.pressing = false
    this.drag = null
    this.swallowTap = false
  }

  private stopPressTimer(): void {
    if (this.pressTimer !== null) clearTimeout(this.pressTimer)
    this.pressTimer = null
  }

  private apply(pixels: number, x = this.drag?.x ?? 0, y = this.drag?.y ?? 0): void {
    const height = this.host.rowHeight()
    if (height <= 0) return
    this.remainder += pixels
    const rows = Math.trunc(this.remainder / height)
    if (rows === 0) return
    this.remainder -= rows * height
    this.host.scroll(rows, x, y)
  }

  private fling(startSpeed: number, x: number, y: number): void {
    let speed = startSpeed
    let last = this.now()
    const step = () => {
      const now = this.now()
      const elapsed = now - last
      last = now
      speed *= Math.exp(-elapsed / FLING_DECAY_MS)
      if (Math.abs(speed) < STOP_FLING_SPEED) {
        this.flingFrame = null
        return
      }
      this.apply(speed * elapsed, x, y)
      this.flingFrame = requestAnimationFrame(step)
    }
    this.flingFrame = requestAnimationFrame(step)
  }

  private stopFling(): void {
    if (this.flingFrame !== null) cancelAnimationFrame(this.flingFrame)
    this.flingFrame = null
  }
}
