/**
 * Sharing a browser's WebGL context budget across every mounted pane,
 * extracted from `GhosttyEngine`.
 *
 * The odd one out among the engine's controllers: the other two are per-pane,
 * this is inherently cross-instance — it was a static `Set` plus a static
 * timestamp plus two per-instance fields (`visible`, `lastVisibleAt`) that
 * only the static pass ever read. Making it an object means the registry and
 * the per-pane bookkeeping it depends on live in one place instead of being
 * spread across the instance/static boundary of a 2,000-line class.
 *
 * Generic over the participant so the engine's diagnostics can still walk the
 * live set and read engine-specific things off it.
 */

/**
 * How many panes may hold a GL context at once.
 *
 * Browsers cap live contexts — around sixteen in Chromium — and past that they
 * take them from whoever they like, quite possibly the pane being looked at.
 * Eight leaves headroom for anything else on the page. Below the budget
 * nothing is given up at all: a handful of tabs is the common case and should
 * cost nothing. Above it, the least recently seen panes give theirs up.
 */
const CONTEXT_BUDGET = 8

/** Rate-limits the shared pass below; it runs once per interval, not per pane. */
const RECONCILE_INTERVAL_MS = 100

export interface ContextClient {
  /**
   * Reclaims a context. Also covers one the browser took by itself: whatever
   * the reason a pane that should have a context doesn't, asking for it back
   * is the answer.
   */
  ensureContext(): void
  dropContext(): void
}

interface Bookkeeping {
  visible: boolean
  /** Ranks panes for the budget; a pane on screen now keeps bumping this. */
  lastVisibleAt: number
}

export class ContextManager<T extends ContextClient> {
  private readonly clients = new Map<T, Bookkeeping>()
  private lastReconcileAt = 0
  /** Injected so tests and headless runs don't need a real clock. */
  private readonly now: () => number

  constructor(now: () => number = () => performance.now()) {
    this.now = now
  }

  add(client: T): void {
    if (!this.clients.has(client)) {
      this.clients.set(client, { visible: false, lastVisibleAt: 0 })
    }
  }

  /**
   * Closing a pane frees a context, which may put someone else back under the
   * budget — so this reconciles immediately rather than letting them wait for
   * their own next poll.
   */
  remove(client: T): void {
    this.clients.delete(client)
    this.lastReconcileAt = 0
    this.reconcile()
  }

  /** Records what a pane can see, then lets the shared pass decide. */
  noteVisibility(client: T, visible: boolean): void {
    const book = this.clients.get(client)
    if (!book) return
    book.visible = visible
    if (visible) book.lastVisibleAt = this.now()
    this.reconcile()
  }

  lastVisibleAt(client: T): number {
    return this.clients.get(client)?.lastVisibleAt ?? 0
  }

  all(): Iterable<T> {
    return this.clients.keys()
  }

  get size(): number {
    return this.clients.size
  }

  /**
   * Decides which panes hold a GL context.
   *
   * Every tab here stays mounted and merely hidden, so panes accumulate
   * whether or not they are on screen.
   *
   * Below the budget nothing is given up at all: a handful of tabs is the
   * normal case, and making it rebuild a context on every tab switch buys
   * nothing but a flash. Only once there are more panes than the budget do the
   * least recently seen ones hand theirs back, and a pane that is on screen
   * never does — a visible pane going dark is the thing this exists to prevent.
   *
   * Ordering by when a pane was last visible rather than by whether it is
   * visible right now is also what makes this stable: a pane measures zero for
   * the first frames after mount and while a split is dragged, and a recency
   * ranking rides straight over that where a strict hidden/visible rule would
   * tear the context down and build it back.
   */
  reconcile(): void {
    const now = this.now()
    if (now - this.lastReconcileAt < RECONCILE_INTERVAL_MS) return
    this.lastReconcileAt = now

    const entries = [...this.clients.entries()]
    if (entries.length > CONTEXT_BUDGET) {
      entries.sort((a, b) => b[1].lastVisibleAt - a[1].lastVisibleAt)
    }
    for (let i = 0; i < entries.length; i++) {
      const [client, book] = entries[i]
      if (entries.length <= CONTEXT_BUDGET || i < CONTEXT_BUDGET || book.visible) {
        client.ensureContext()
      } else {
        client.dropContext()
      }
    }
  }
}
