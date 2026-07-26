/**
 * Guards a run against the engine hosts scrolling off screen.
 *
 * xterm.js stops rendering entirely when its screen element leaves the
 * viewport. `RenderService` observes intersection and latches a flag instead of
 * painting:
 *
 *   _isPaused = !entry.isIntersecting
 *   refreshRows(...) { if (this._isPaused) { this._needsFullRefresh = true; return } }
 *
 * `onRender` only fires from a real render, so a paused xterm reports zero
 * paints — which `measurePresent` returns and the latency loop counts as an
 * empty trial. The Ghostty engine drives its own rAF loop with no such check
 * and keeps painting throughout.
 *
 * That asymmetry silently gutted the TUI row: 18 usable samples out of 120,
 * the other 102 flagged `⚠️ empty`, because a two-minute workload is exactly
 * long enough for someone to scroll down and read the tables that already
 * landed. The surviving samples were not *wrong*, but they were the first 15%
 * of the run rather than a sample of it, and the flag was easy to read past.
 *
 * So visibility is treated as a precondition of the measurement rather than a
 * property of it: a run refuses to start unless both hosts are fully on screen,
 * and aborts if either leaves. Aborting rather than flagging is deliberate — a
 * partial latency distribution looks exactly like a complete one once it is in
 * a table.
 *
 * Only latency workloads read paints, but the guard covers every mode: a paused
 * renderer changes what the main thread is doing, which is the thing a
 * throughput or block round is measuring.
 */

/**
 * Fraction of a host that must be on screen. Deliberately not 1.0: browsers
 * report intersection ratios a hair under it for elements that are wholly
 * visible but sit on a fractional device-pixel boundary, which a maximised
 * window at a non-integer DPR does routinely. xterm pauses only at ratio 0, so
 * anything in this band is rendering normally.
 */
export const MIN_VISIBLE_RATIO = 0.98

export interface HostVisibility {
  /** Hosts currently below the threshold, by name. Empty when all are visible. */
  hidden(): string[]
  /**
   * Hosts that dropped below the threshold at any point since the last
   * `arm()`. Latched, because the observer fires asynchronously and a scroll
   * that happens and reverses between two checks still paused the renderer for
   * the trials in between.
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
 * The message a caller shows when the guard trips. Pure, so the wording is
 * testable without a DOM or an observer.
 */
export function visibilityMessage(names: string[], during: boolean): string {
  const who = names.join(' and ')
  const verb = names.length > 1 ? 'were' : 'was'
  return during
    ? `${who} scrolled out of view during the run. xterm stops rendering when its host leaves the viewport, ` +
        'so the remaining trials would have measured nothing and been counted as empty. Run aborted — ' +
        'keep both panes on screen for the whole run.'
    : `${who} ${verb} not fully on screen. xterm does not render a host that has left the viewport, so a run ` +
        'now would report empty trials instead of latencies. Scroll both panes into view.'
}

/**
 * Starts observing. Returns a no-op watcher (never hidden, never lost) where
 * `IntersectionObserver` is unavailable, so a test environment or an old
 * WebView is not blocked from running — the guard is there to catch a real
 * scroll, not to gate on feature detection.
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
    // A range of thresholds rather than just the one: with a single threshold
    // the callback fires only on the crossing, and a host that is already
    // partly off screen when observation starts can report a stale ratio.
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
