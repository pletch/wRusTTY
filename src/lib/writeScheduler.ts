/**
 * Spends at most a slice of each frame writing PTY output, so a backlog can't
 * freeze the window.
 *
 * Without it, a queued-up IPC backlog ran many deliveries back to back with
 * no chance to render. Bytes are written immediately while the frame has
 * budget (so echo stays instant); once spent, the rest waits for the next
 * frame. The block is then bounded by the budget plus one delivery's
 * overshoot. A Worker would take the parse off the main thread entirely; this
 * only keeps it from monopolizing it.
 *
 * Order is never changed: the parser is one state machine over a byte stream.
 */

/**
 * Milliseconds of writing allowed between frames. Smaller bounds the freeze
 * tighter but drains a flood slower; 10 ms of a ~16.7 ms frame keeps the
 * worst block near one frame.
 */
const FRAME_BUDGET_MS = 10

/**
 * How long to wait for a frame before draining without a budget. WebView2
 * stops animation frames when occluded or minimized, and with nothing being
 * rendered there's nothing to protect.
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

/**
 * Creates the scheduler. `onPaced` receives each deliberate wait, so the
 * delivery recorder can tell pacing from starvation.
 */
export function createWriteScheduler(
  write: (bytes: Uint8Array) => void,
  budgetMs: number = FRAME_BUDGET_MS,
  hooks: SchedulerHooks = {},
  onPaced?: (ms: number) => void,
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
    const waitStartedAt = now()
    frameId = requestFrame(() => {
      frameId = null
      stopWaiting()
      onPaced?.(now() - waitStartedAt)
      // A frame rendered; the budget resets.
      spent = 0
      pump()
    })
    timerId = setTimer(() => {
      timerId = null
      stopWaiting()
      onPaced?.(now() - waitStartedAt)
      // No frame: nothing is rendering, so don't hold the backlog back.
      spent = 0
      while (queue.length > 0) write(queue.shift()!)
    }, FRAME_TIMEOUT_MS)
  }

  return {
    push(bytes: Uint8Array): void {
      if (disposed) return
      queue.push(bytes)
      // Only pump when nothing waits on a frame, or this would jump the budget.
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
