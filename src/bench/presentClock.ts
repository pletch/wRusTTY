/**
 * Stopping the clock at presentation, not at hand-off.
 *
 * Both engines paint on their own rAF loop only when damaged, so presentation
 * is knowable without reading pixels back:
 *
 *   1. A paint issued during rAF frame N is presented at the vsync after N,
 *      so it's visible by the time frame N+1 runs.
 *   2. Each engine fires `onRender` on exactly the frames it painted.
 *
 * So a burst is presented at the first rAF after its last paint that has no
 * paint of its own. rAF timestamps share `performance.now()`'s origin.
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
   * Hard ceiling on one trial. Approaching it means the render loop died or is
   * thrashing, so the trial fails rather than hanging the run.
   */
  timeoutMs?: number
}

/**
 * Times one unit of work from just before write to presented. Timing starts
 * at a frame boundary so it isn't biased by landing mid-frame.
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
    // The first idle frame after a paint burst is when it's on screen.
    let armed = false
    while (idle < SETTLE_FRAMES) {
      const ts = await nextFrame()
      // Catches a dead render loop (no paints) and a runaway one (every frame).
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
