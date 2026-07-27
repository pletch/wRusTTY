import { describe, it, expect } from 'vitest'
import { ContextManager, type ContextClient } from './ContextManager'

/**
 * The context budget had no coverage while it lived as a static method on the
 * engine — it needed a real clock, a real `Set` of real engines, and a real
 * WebGL context to say anything about. As its own object with an injected
 * clock it is just a ranking rule, which is the part worth pinning: every bug
 * this code can have is "the pane you were looking at went black".
 */

const BUDGET = 8

class FakePane implements ContextClient {
  hasContext = true
  ensureCalls = 0
  dropCalls = 0

  ensureContext(): void {
    this.ensureCalls++
    this.hasContext = true
  }

  dropContext(): void {
    this.dropCalls++
    this.hasContext = false
  }
}

/** A clock the test advances by hand, so the 100 ms rate limit is explicit
 *  rather than something to sleep through. */
function harness() {
  let now = 1000
  const mgr = new ContextManager<FakePane>(() => now)
  return {
    mgr,
    advance: (ms: number) => {
      now += ms
    },
    add: (n: number) => {
      const panes: FakePane[] = []
      for (let i = 0; i < n; i++) {
        const p = new FakePane()
        panes.push(p)
        mgr.add(p)
      }
      return panes
    },
  }
}

describe('ContextManager', () => {
  it('takes no context away while under the budget', () => {
    const { mgr, add, advance } = harness()
    const panes = add(BUDGET)
    advance(200)
    mgr.reconcile()
    expect(panes.every((p) => p.dropCalls === 0)).toBe(true)
  })

  /** A handful of tabs is the normal case; rebuilding a context on every tab
   *  switch would buy nothing but a flash. */
  it('still takes none away at exactly the budget', () => {
    const { mgr, add, advance } = harness()
    const panes = add(BUDGET)
    advance(200)
    mgr.noteVisibility(panes[0], true)
    expect(panes.every((p) => p.dropCalls === 0)).toBe(true)
  })

  it('drops the least recently visible once over the budget', () => {
    const { mgr, add, advance } = harness()
    const panes = add(BUDGET + 2)
    // Touch them in order, so pane 0 is the stalest and the last is freshest.
    for (const p of panes) {
      advance(200)
      mgr.noteVisibility(p, true)
      mgr.noteVisibility(p, false)
    }
    advance(200)
    mgr.reconcile()
    expect(panes[0].hasContext).toBe(false)
    expect(panes[1].hasContext).toBe(false)
    expect(panes.slice(2).every((p) => p.hasContext)).toBe(true)
  })

  /** The property the whole thing exists for. */
  it('never drops a pane that is on screen, however stale', () => {
    const { mgr, add, advance } = harness()
    const panes = add(BUDGET + 3)
    const onScreen = panes[0]
    advance(200)
    mgr.noteVisibility(onScreen, true)
    // Everyone else gets touched much later, so `onScreen` ranks last by
    // recency — and would be dropped if visibility weren't the override.
    for (const p of panes.slice(1)) {
      advance(200)
      mgr.noteVisibility(p, true)
      mgr.noteVisibility(p, false)
    }
    advance(200)
    mgr.reconcile()
    expect(onScreen.hasContext).toBe(true)
  })

  it('rate-limits the pass to once per interval', () => {
    const { mgr, add, advance } = harness()
    const panes = add(2)
    advance(200)
    mgr.reconcile()
    const after = panes[0].ensureCalls
    // Same tick: the pass must not run again.
    mgr.reconcile()
    expect(panes[0].ensureCalls).toBe(after)
    advance(200)
    mgr.reconcile()
    expect(panes[0].ensureCalls).toBe(after + 1)
  })

  /**
   * Closing a pane frees a context, so someone previously over the budget
   * should get one back immediately rather than waiting for their own poll —
   * `remove` bypasses the rate limit for exactly this.
   */
  it('reconciles immediately when a pane is removed', () => {
    const { mgr, add, advance } = harness()
    const panes = add(BUDGET + 1)
    for (const p of panes) {
      advance(200)
      mgr.noteVisibility(p, true)
      mgr.noteVisibility(p, false)
    }
    advance(200)
    mgr.reconcile()
    const dropped = panes[0]
    expect(dropped.hasContext).toBe(false)

    // No clock advance: this must still take effect.
    mgr.remove(panes[panes.length - 1])
    expect(dropped.hasContext).toBe(true)
  })

  it('forgets a removed pane', () => {
    const { mgr, add } = harness()
    const [a, b] = add(2)
    expect(mgr.size).toBe(2)
    mgr.remove(a)
    expect(mgr.size).toBe(1)
    expect([...mgr.all()]).toEqual([b])
  })

  it('ranks the most recently visible pane first', () => {
    const { mgr, add, advance } = harness()
    const [a, b] = add(2)
    advance(200)
    mgr.noteVisibility(a, true)
    advance(200)
    mgr.noteVisibility(b, true)
    expect(mgr.lastVisibleAt(b)).toBeGreaterThan(mgr.lastVisibleAt(a))
  })
})
