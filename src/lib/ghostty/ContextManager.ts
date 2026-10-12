/**
 * Sharing the browser's WebGL context budget across every mounted pane,
 * extracted from `GhosttyEngine`. Unlike the other controllers it's
 * cross-instance, holding the registry and per-pane bookkeeping together.
 * Generic over the participant so diagnostics can read engine fields.
 */

/**
 * How many panes may hold a GL context at once. Chromium caps live contexts
 * around sixteen and then takes them from anyone, possibly the visible pane;
 * eight leaves headroom. Past the budget, the least recently seen panes give
 * theirs up.
 */
const CONTEXT_BUDGET = 8

/** Rate-limits the shared pass below; it runs once per interval, not per pane. */
const RECONCILE_INTERVAL_MS = 100

export interface ContextClient {
  /**
   * Reclaims a context, including one the browser took on its own.
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
   * Closing a pane frees a context, so reconcile immediately for whoever is
   * waiting.
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
   * Decides which panes hold a GL context. Tabs stay mounted when hidden, so
   * panes accumulate.
   *
   * Below the budget nothing is given up (rebuilding on every tab switch would
   * only flash). Above it, the least recently seen give theirs back; a visible
   * pane never does. Ranking by recency rather than current visibility rides
   * over the zero-size frames after mount and during split drags.
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
