/**
 * Spends at most a slice of each frame writing PTY output, so a backlog cannot
 * freeze the window.
 *
 * The problem this solves, measured. On a 100 MB flood into a live pane the
 * worst main-thread block was 106 ms, while a single delivery costs 3.50 ms at
 * the median and 7.30 ms at p95. So a freeze is not one slow parse — it is
 * roughly thirty deliveries running back to back with no chance to render in
 * between, because `onData` wrote synchronously the moment IPC handed bytes
 * over and IPC had a queue built up behind it. The benchmark harness never
 * showed this: it yields between deliveries and its worst stall is ~1 frame.
 *
 * So writes are metered against the frame rather than the delivery. Bytes go in
 * immediately while there is budget left, which keeps interactive echo exactly
 * as fast as before — a keystroke is one small delivery into an empty budget.
 * Once a frame's worth of writing has been spent, the rest waits for the next
 * frame, which resets the budget. The block is then bounded by the budget plus
 * however far the last delivery overshot it, rather than by how much the
 * producer managed to queue.
 *
 * This is the cheap half of what moving the parser to a Worker would buy. A
 * Worker takes the parse off the main thread entirely; this only stops it
 * monopolising the thread. Neither makes the parse faster — at ~86 MB/s the
 * parser is no longer the constraint.
 *
 * Order is never rearranged. The parser is one state machine fed a byte stream,
 * so a queue that reordered or dropped anything would corrupt the screen rather
 * than merely delay it.
 */

/**
 * Milliseconds of writing allowed between frames.
 *
 * The trade is explicit: a smaller budget bounds the freeze more tightly and
 * drains a flood more slowly, because the time spent waiting for frames is time
 * not spent parsing. 10 ms of a ~16.7 ms frame keeps the worst block near a
 * single frame (budget plus one delivery's overshoot) while leaving most of the
 * frame available for parsing.
 */
const FRAME_BUDGET_MS = 10

/**
 * How long to wait for a frame that may never come before giving up and
 * draining without a budget.
 *
 * WebView2 stops firing animation frames when the window is occluded or
 * minimised. Without this the queue would stall until the window came back.
 * Draining freely is the right response rather than a compromise: the budget
 * exists to protect rendering, and nothing is being rendered.
 */
const FRAME_TIMEOUT_MS = 32

export interface WriteScheduler {
  /** Queues a delivery, writing it immediately if the frame has budget left. */
  push(bytes: Uint8Array): void
  /** Deliveries accepted but not yet written. */
  readonly pending: number
  dispose(): void
}

/** Injection seams, so the budget logic can be tested without a browser. */
export interface SchedulerHooks {
  now?: () => number
  requestFrame?: (cb: () => void) => number
  cancelFrame?: (id: number) => void
  setTimer?: (cb: () => void, ms: number) => number
  clearTimer?: (id: number) => void
}

export function createWriteScheduler(
  write: (bytes: Uint8Array) => void,
  budgetMs: number = FRAME_BUDGET_MS,
  hooks: SchedulerHooks = {},
): WriteScheduler {
  const now = hooks.now ?? (() => performance.now())
  const requestFrame = hooks.requestFrame ?? ((cb) => requestAnimationFrame(cb))
  const cancelFrame = hooks.cancelFrame ?? ((id) => cancelAnimationFrame(id))
  const setTimer = hooks.setTimer ?? ((cb, ms) => setTimeout(cb, ms) as unknown as number)
  const clearTimer = hooks.clearTimer ?? ((id) => clearTimeout(id))

  const queue: Uint8Array[] = []
  let spent = 0
  let frameId: number | null = null
  let timerId: number | null = null
  let disposed = false

  function stopWaiting(): void {
    if (frameId !== null) {
      cancelFrame(frameId)
      frameId = null
    }
    if (timerId !== null) {
      clearTimer(timerId)
      timerId = null
    }
  }

  /** Drains until the queue empties or the budget runs out. */
  function pump(): void {
    while (queue.length > 0 && spent < budgetMs) {
      const bytes = queue.shift()!
      const t0 = now()
      write(bytes)
      spent += now() - t0
    }
    if (queue.length > 0) waitForFrame()
  }

  function waitForFrame(): void {
    if (disposed || frameId !== null || timerId !== null) return
    frameId = requestFrame(() => {
      frameId = null
      stopWaiting()
      // A frame rendered, so the budget is honestly spent again.
      spent = 0
      pump()
    })
    timerId = setTimer(() => {
      timerId = null
      stopWaiting()
      // No frame arrived — nothing is being rendered, so there is no freeze to
      // protect against and the backlog should not be held back.
      spent = 0
      while (queue.length > 0) write(queue.shift()!)
    }, FRAME_TIMEOUT_MS)
  }

  return {
    push(bytes: Uint8Array): void {
      if (disposed) return
      queue.push(bytes)
      // Only pump when nothing is already waiting on a frame; otherwise this
      // delivery would jump the budget that the wait exists to enforce.
      if (frameId === null && timerId === null) pump()
    },
    get pending(): number {
      return queue.length
    },
    dispose(): void {
      disposed = true
      stopWaiting()
      queue.length = 0
    },
  }
}
