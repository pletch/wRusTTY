/**
 * Coalesces PTY resizes, so a window drag tells the remote once where it ended
 * up instead of narrating every pixel of the journey.
 *
 * The ResizeObserver behind this fires at pointer rate — a drag was measured
 * producing six events in 80 ms — and each one that changes the *cell* grid is
 * a real `TIOCSWINSZ` at the far end, hence a real SIGWINCH. A program holding
 * a status line at the bottom of the screen redraws it on every one of those,
 * at the new last row, and the row it drew on before is left behind as ordinary
 * text. Measured against a pinned apt progress bar: a drag across five row
 * boundaries left **five** stranded bars and scrolled the actual output away;
 * the same drag delivered once left one bar and the output intact.
 *
 * The local grid is deliberately *not* coalesced — the canvas has to track the
 * container while the pointer moves, or the pane visibly lags the window. Only
 * the message to the far end waits, and only for as long as the drag is still
 * moving.
 *
 * Two behaviours worth stating, because both are what the trace showed going
 * wrong:
 *
 * - **The last size always arrives.** This is a trailing debounce, not a
 *   throttle: whatever the drag settles on is what gets sent, however long it
 *   went on.
 * - **A size that did not change is never sent.** The trace showed dozens of
 *   `sameAsLast=true` resizes on tab switches alone. The kernel happens to
 *   swallow those (it only signals when the winsize differs), so they were
 *   harmless — but harmless-by-accident is not a reason to keep sending them.
 */

/** Quiet period before the far end is told. Long enough to cover a drag's
 *  pointer rate, short enough that a discrete change (a split, a font size)
 *  still feels immediate. */
export const PTY_RESIZE_QUIET_MS = 150

export interface PtyResizeSender {
  /** Record a new size. The send happens once things go quiet. */
  post(cols: number, rows: number): void
  /** Send immediately if anything is pending — for a size that must not wait,
   *  such as the one a session is handed at connect. */
  flush(): void
  /** Drop anything pending, for teardown. */
  cancel(): void
}

/**
 * `send` is called with the settled size. `schedule` exists so tests can drive
 * the clock; it defaults to the real timers.
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
      // Restarted rather than left to run: a drag that is still moving has not
      // told us its answer yet.
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
