/**
 * Stopping the clock at *presentation*, not at hand-off — the discipline Phase 7
 * asks for.
 *
 * Both engines paint on their own `requestAnimationFrame` loop and only when
 * there is damage. So "the frame is on the glass" is knowable without reading
 * pixels back (which would perturb the very timing being measured):
 *
 *   1. A paint issued during rAF frame N is submitted to the compositor during
 *      N and presented at the vsync after N — guaranteed visible by the time
 *      rAF frame N+1 runs.
 *   2. Each engine fires `onRender` on exactly the frames it painted.
 *
 * So the present time of the last paint in a burst is the timestamp of the
 * first rAF that follows it with no paint of its own. That is what this returns.
 *
 * rAF timestamps and `performance.now()` share one time origin, so the start
 * mark and the present mark are directly subtractable.
 */

import type { IDisposable } from '@xterm/xterm'

/** The paint signal both concrete engines expose (see their `onRender`). */
export interface Paintable {
  onRender(cb: () => void): IDisposable
}

/** Consecutive paint-free frames that count a burst as settled. */
const SETTLE_FRAMES = 3

/** Resolves in the next animation frame with that frame's timestamp. */
export function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame((ts) => resolve(ts)))
}

export interface PresentResult {
  /** Milliseconds from the write to the last paint being presented. */
  elapsed: number
  /** How many frames the engine actually painted. Zero means nothing rendered. */
  paints: number
  /** The trial hit its wall-clock ceiling before settling; `elapsed` is unusable. */
  timedOut: boolean
}

export interface PresentOptions {
  /**
   * Hard ceiling on one trial. A measurement should settle in well under a
   * second; anything approaching this means the engine's render loop died or is
   * thrashing, and the trial is failed rather than left to hang the whole run.
   */
  timeoutMs?: number
}

/**
 * Times one unit of work from just-before-write to presented.
 *
 * `feed` issues the writes (and may await its own cadence between them); timing
 * starts at a frame boundary right before it runs so the measurement is not
 * biased by landing mid-frame.
 */
export async function measurePresent(
  engine: Paintable,
  feed: () => void | Promise<void>,
  opts: PresentOptions = {},
): Promise<PresentResult> {
  const timeoutMs = opts.timeoutMs ?? 8000
  let paintedThisInterval = false
  let paints = 0
  const sub = engine.onRender(() => {
    paintedThisInterval = true
    paints++
  })

  try {
    await nextFrame()
    const t0 = performance.now()
    await feed()

    let idle = 0
    let presentedAt = t0
    // First idle frame after a paint burst is when that burst is on screen.
    let armed = false
    while (idle < SETTLE_FRAMES) {
      const ts = await nextFrame()
      // A trial that can't settle must fail, not wedge the run. This catches a
      // dead render loop (no paints ever) and a runaway one (a paint every
      // frame) alike.
      if (ts - t0 > timeoutMs) {
        return { elapsed: presentedAt - t0, paints, timedOut: true }
      }
      if (paintedThisInterval) {
        paintedThisInterval = false
        armed = true
        idle = 0
      } else {
        if (armed) {
          presentedAt = ts
          armed = false
        }
        idle++
      }
    }
    return { elapsed: presentedAt - t0, paints, timedOut: false }
  } finally {
    sub.dispose()
  }
}
