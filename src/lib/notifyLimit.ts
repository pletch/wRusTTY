/**
 * Caps how often one pane's remote notifications (OSC 9 / OSC 777) may show.
 * Anything a host prints can raise one, so without a cap a loop on the far
 * end (or a hostile `cat`) could bury the window in toasts or fill the
 * system's notification center.
 *
 * A sliding window per key: at most `limit` in any `windowMs`. Excess
 * notifications are dropped, not queued, since a backlog would just replay
 * the flood more slowly.
 */
export class NotifyLimiter {
  private readonly sent = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number

  constructor(limit = 3, windowMs = 10_000) {
    this.limit = limit
    this.windowMs = windowMs
  }

  /** Whether `key` may notify now; records it if so. */
  allow(key: string, now: number = Date.now()): boolean {
    const recent = (this.sent.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (recent.length >= this.limit) {
      this.sent.set(key, recent)
      return false
    }
    recent.push(now)
    this.sent.set(key, recent)
    return true
  }

  /** Forgets a key, for a pane that closed. */
  forget(key: string): void {
    this.sent.delete(key)
  }
}

/** The app's one limiter for remote notifications, keyed by pane id. */
export const remoteNotifyLimiter = new NotifyLimiter()
