/**
 * Guards a run against the engine hosts scrolling off screen.
 *
 * xterm.js stops rendering when its screen element leaves the viewport
 * (`RenderService` latches `_isPaused` from an IntersectionObserver), so it
 * reports zero paints and the latency loop counts empty trials; Ghostty keeps
 * painting. Visibility is therefore a precondition: a run won't start unless
 * both hosts are fully on screen, and aborts (rather than flags) if either
 * leaves. It covers every mode, since a paused renderer changes main-thread
 * load too.
 */

/**
 * Fraction of a host that must be on screen. Not 1.0: wholly visible elements
 * on a fractional device-pixel boundary report slightly less. xterm pauses
 * only at 0.
 */
export const MIN_VISIBLE_RATIO = 0.98

export interface HostVisibility {
  /** Hosts currently below the threshold, by name. Empty when all are visible. */
  hidden(): string[]
  /**
   * Hosts that dropped below the threshold since the last `arm()`. Latched,
   * since the observer is asynchronous and a brief scroll still paused the
   * renderer.
   */
  lost(): string[]
  /** Clears the latch at the start of a run. */
  arm(): void
  dispose(): void
}

export interface NamedHost {
  name: string
  el: HTMLElement
}

/**
 * The message shown when the guard trips. Pure, for testing.
 */
export function visibilityMessage(names: string[], during: boolean, stillHidden: string[] = []): string {
  const who = names.join(' and ')
  const verb = names.length > 1 ? 'were' : 'was'
  if (!during) {
    return `${who} ${verb} not fully on screen. xterm does not render a host that has left the viewport, so a run ` +
      'now would report empty trials instead of latencies. Scroll both panes into view.'
  }
  // Whether the host is still off screen separates "you scrolled" from "the
  // harness perturbed its own layout".
  const detail =
    stillHidden.length > 0
      ? `${stillHidden.join(' and ')} still off screen.`
      : 'Both are back on screen now, so the loss was transient — if you did not scroll, this is a harness bug ' +
        'rather than a scroll: note the grid size and what was on screen.'
  return `${who} left the viewport during the run. xterm stops rendering when its host does, so the remaining ` +
    `trials would have measured nothing and been counted as empty. Run aborted. ${detail}`
}

/**
 * Starts observing. Without `IntersectionObserver` (tests, old WebViews),
 * returns a watcher that never trips.
 */
export function observeHosts(hosts: NamedHost[]): HostVisibility {
  if (typeof IntersectionObserver === 'undefined') {
    return { hidden: () => [], lost: () => [], arm: () => {}, dispose: () => {} }
  }

  const visible = new Map<string, boolean>()
  const lostNames = new Set<string>()
  const byElement = new Map<Element, string>(hosts.map((h) => [h.el, h.name]))

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const name = byElement.get(entry.target)
        if (name === undefined) continue
        const ok = entry.intersectionRatio >= MIN_VISIBLE_RATIO
        visible.set(name, ok)
        if (!ok) lostNames.add(name)
      }
    },
    // Several thresholds, so a host already partly off screen when observation
    // starts doesn't report a stale ratio.
    { threshold: [0, 0.5, MIN_VISIBLE_RATIO, 1] },
  )
  for (const h of hosts) observer.observe(h.el)

  return {
    hidden: () => hosts.filter((h) => visible.get(h.name) === false).map((h) => h.name),
    lost: () => hosts.filter((h) => lostNames.has(h.name)).map((h) => h.name),
    arm: () => lostNames.clear(),
    dispose: () => observer.disconnect(),
  }
}
