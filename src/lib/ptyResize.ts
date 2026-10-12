/**
 * Coalesces PTY resizes, so a window drag tells the remote only where it
 * ended up.
 *
 * The ResizeObserver fires at pointer rate, and each cell-grid change is a
 * real SIGWINCH at the far end; a program pinning a status line to the bottom
 * redraws it on each one, stranding the old copies as text. The local grid
 * isn't coalesced, so the canvas tracks the window.
 *
 * - **The last size always arrives**: a trailing debounce, not a throttle.
 * - **An unchanged size is never sent.**
 */

/** Quiet period before the far end is told: covers a drag's pointer rate,
 *  short enough that a split or font change feels immediate. */
export const PTY_RESIZE_QUIET_MS = 150

export interface PtyResizeSender {
  /** Records a new size; it's sent once things go quiet. */
  post(cols: number, rows: number): void
  /** Sends anything pending now, for a size that can't wait (such as at
   *  connect). */
  flush(): void
  /** Drops anything pending, for teardown. */
  cancel(): void
}

/**
 * `send` gets the settled size. `schedule` lets tests drive the clock.
 */
export function createPtyResizeSender(
  send: (cols: number, rows: number) => void,
  quietMs: number = PTY_RESIZE_QUIET_MS,
): PtyResizeSender {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { cols: number; rows: number } | null = null
  let lastSent = ''

  const fire = () => {
    timer = null
    const size = pending
    pending = null
    if (!size) return
    const key = `${size.cols}x${size.rows}`
    if (key === lastSent) return
    lastSent = key
    send(size.cols, size.rows)
  }

  return {
    post(cols, rows) {
      pending = { cols, rows }
      // Restarted: a drag still moving hasn't settled.
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(fire, quietMs)
    },
    flush() {
      if (timer !== null) clearTimeout(timer)
      fire()
    },
    cancel() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending = null
    },
  }
}
