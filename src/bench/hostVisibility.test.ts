import { describe, it, expect, vi, afterEach } from 'vitest'
import { observeHosts, visibilityMessage, MIN_VISIBLE_RATIO } from './hostVisibility'
import { RunAborted, type RunOptions } from './runner'

/**
 * A controllable IntersectionObserver. The real one only reports on a real
 * layout, and the behaviour worth pinning here is the bookkeeping — which host
 * is hidden, what stays latched, when the latch clears — not the browser's
 * intersection maths.
 */
class FakeObserver {
  static live: FakeObserver[] = []
  targets: Element[] = []
  disconnected = false
  private cb: (entries: { target: Element; intersectionRatio: number }[]) => void
  constructor(cb: (entries: { target: Element; intersectionRatio: number }[]) => void) {
    this.cb = cb
    FakeObserver.live.push(this)
  }
  observe(el: Element) {
    this.targets.push(el)
  }
  disconnect() {
    this.disconnected = true
  }
  emit(entries: { target: Element; intersectionRatio: number }[]) {
    this.cb(entries)
  }
}

function withFakeObserver() {
  FakeObserver.live = []
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  const a = { nodeName: 'DIV-A' } as unknown as HTMLElement
  const b = { nodeName: 'DIV-B' } as unknown as HTMLElement
  const watch = observeHosts([{ name: 'xterm', el: a }, { name: 'ghostty', el: b }])
  return { watch, a, b, observer: FakeObserver.live[0] }
}

afterEach(() => vi.unstubAllGlobals())

describe('observeHosts', () => {
  it('reports nothing hidden before the observer has said anything', () => {
    const { watch } = withFakeObserver()
    expect(watch.hidden()).toEqual([])
    expect(watch.lost()).toEqual([])
  })

  it('names the host that fell below the threshold', () => {
    const { watch, a, b, observer } = withFakeObserver()
    observer.emit([{ target: a, intersectionRatio: 1 }, { target: b, intersectionRatio: 1 }])
    expect(watch.hidden()).toEqual([])
    observer.emit([{ target: a, intersectionRatio: 0 }])
    expect(watch.hidden()).toEqual(['xterm'])
  })

  it('treats a hair under full visibility as visible', () => {
    // A maximised window at a fractional DPR reports this routinely, and xterm
    // pauses only at ratio 0 — so this band is still rendering normally.
    const { watch, a, observer } = withFakeObserver()
    observer.emit([{ target: a, intersectionRatio: MIN_VISIBLE_RATIO }])
    expect(watch.hidden()).toEqual([])
  })

  it('latches a host that scrolled away and back', () => {
    // The whole reason `lost` exists: the trials in between were measured
    // against a paused renderer, and a check that only samples the current
    // state would never see it.
    const { watch, a, observer } = withFakeObserver()
    observer.emit([{ target: a, intersectionRatio: 0 }])
    observer.emit([{ target: a, intersectionRatio: 1 }])
    expect(watch.hidden()).toEqual([])
    expect(watch.lost()).toEqual(['xterm'])
  })

  it('clears the latch on arm, so a previous run does not fail the next', () => {
    const { watch, a, observer } = withFakeObserver()
    observer.emit([{ target: a, intersectionRatio: 0 }])
    expect(watch.lost()).toEqual(['xterm'])
    watch.arm()
    expect(watch.lost()).toEqual([])
  })

  it('ignores entries for elements it does not know', () => {
    const { watch, observer } = withFakeObserver()
    observer.emit([{ target: { nodeName: 'OTHER' } as unknown as Element, intersectionRatio: 0 }])
    expect(watch.hidden()).toEqual([])
    expect(watch.lost()).toEqual([])
  })

  it('disconnects on dispose', () => {
    const { watch, observer } = withFakeObserver()
    watch.dispose()
    expect(observer.disconnected).toBe(true)
  })

  it('never blocks a run where IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const watch = observeHosts([{ name: 'xterm', el: {} as HTMLElement }])
    expect(watch.hidden()).toEqual([])
    expect(watch.lost()).toEqual([])
    expect(() => {
      watch.arm()
      watch.dispose()
    }).not.toThrow()
  })
})

describe('visibilityMessage', () => {
  it('says why rather than just what, for both timings', () => {
    // The message has to carry the mechanism: "xterm stops rendering" is the
    // non-obvious part, and without it the refusal looks like a harness bug.
    expect(visibilityMessage(['xterm'], false)).toContain('does not render')
    expect(visibilityMessage(['xterm'], false)).toContain('Scroll both panes into view')
    expect(visibilityMessage(['xterm'], true)).toContain('Run aborted')
  })

  it('distinguishes a host still off screen from one that came back', () => {
    // The difference between "you scrolled" and "the harness moved its own
    // layout". Getting this wrong once already cost every 200x60 run.
    const still = visibilityMessage(['xterm', 'ghostty'], true, ['xterm'])
    expect(still).toContain('xterm still off screen')
    expect(still).not.toContain('harness bug')

    const transient = visibilityMessage(['xterm', 'ghostty'], true, [])
    expect(transient).toContain('transient')
    expect(transient).toContain('harness bug')
  })

  it('agrees with itself about number', () => {
    expect(visibilityMessage(['xterm'], false)).toContain('xterm was not')
    expect(visibilityMessage(['xterm', 'ghostty'], false)).toContain('xterm and ghostty were not')
  })
})

describe('RunAborted', () => {
  it('carries the reason and is distinguishable from an ordinary failure', () => {
    // The harness catches this specifically and rethrows anything else, so a
    // real bug during a run is not swallowed as "you scrolled".
    const e = new RunAborted('scrolled away')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('RunAborted')
    expect(e.message).toBe('scrolled away')
  })

  it('is what a run throws when shouldAbort returns a reason', async () => {
    const opts: RunOptions = { throughputRounds: 1, shouldAbort: () => 'gone' }
    // Mirrors the runner's own guard rather than driving a whole workload,
    // which would need two live engines and a DOM.
    const check = () => {
      const reason = opts.shouldAbort?.()
      if (reason != null) throw new RunAborted(reason)
    }
    expect(check).toThrow(RunAborted)
  })
})
