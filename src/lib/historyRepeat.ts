/**
 * Detects when Up/Down at a remote prompt lands on the same text already
 * showing (a run of duplicate history entries), which otherwise looks exactly
 * like a key that never arrived. Works on any host with no shell setup, because
 * `PromptInputTracker` reads the line off the grid (lib/promptInput.ts) and can
 * be asked before and after a press. The flicker that shows it is in
 * lib/historyFlicker.ts.
 *
 * It doesn't wait for a reply: readline writes only the difference, so
 * recalling a duplicate may send nothing at all. A finding means only "the line
 * didn't change", never that the session is dead.
 *
 * To keep up with fast presses, the next history key resolves the previous
 * press immediately, and the timeout for the last press is derived from this
 * session's measured round trip.
 */

import type { Cell, PromptInput } from './promptInput'

export interface HistoryRepeat {
  /** First cell of the input, i.e. just past the prompt. */
  origin: Cell
  /** Where the cursor ended up — the end of the input. */
  cursor: Cell
  /**
   * How many consecutive presses have landed on this same text, including this
   * one.
   */
  run: number
  /** Bumped per finding, so identical findings can be told apart. */
  seq: number
}

/**
 * Quiet period after the last parsed chunk before the line is read back. A
 * redraw arrives in several chunks (CR, erase, text, cursor move), and reading
 * after the first would see a briefly empty line. Restarted by each chunk.
 */
export const SETTLE_MS = 40

/** Floor under the measured deadline, so even a local link's redraw lands. */
export const MIN_DEADLINE_MS = 45

/**
 * Ceiling on the deadline. Past it the feature stays silent rather than
 * guessing, since a deadline shorter than the round trip can't tell silence
 * from a pending reply. See `deadlineBounded`.
 */
export const MAX_DEADLINE_MS = 400

/**
 * Multiplier from measured round trip to deadline, to wait out the slow reply
 * rather than the median.
 */
const DEADLINE_SAFETY = 3

/**
 * The longest a comparison may be put off from the keypress, so unrelated
 * output can't postpone it forever. Firing here means the line was still in
 * flux, so the press produces no finding (see `trustworthy`).
 */
export const MAX_WAIT_MS = 700

/**
 * Whether these bytes are a bare Up or Down: legacy (`CSI A`) or application
 * cursor mode (`SS3 A`), plus the Kitty protocol's explicit "no modifiers"
 * press form. Modified arrows (`CSI 1;5A`, tmux pane movement) and Kitty
 * release events (which would compare a line with itself) are excluded.
 */
export function isHistoryKey(data: Uint8Array): boolean {
  if (data.length < 3 || data.length > 12) return false
  // ESC is checked as a byte; a control character in a regex literal trips
  // `no-control-regex`.
  if (data[0] !== 0x1b) return false
  let text = ''
  for (let i = 1; i < data.length; i++) text += String.fromCharCode(data[i])
  return /^(?:\[(?:|1|1;1(?::[12])?)|O)[AB]$/.test(text)
}

export interface HistoryRepeatOptions {
  /** The prompt line as it stands (`PromptInputTracker.read`). */
  read: () => PromptInput | null
  /** Called when a press landed on the line already showing. */
  emit: (repeat: HistoryRepeat) => void
}

/**
 * Watches one pane's history keys, driven by outgoing bytes and parsed writes
 * (no polling).
 */
export class HistoryRepeatWatcher {
  private readonly read: () => PromptInput | null
  private readonly emit: (repeat: HistoryRepeat) => void

  /** The line when the history key went out, or null if none is pending. */
  private pending: string | null = null
  /** When that press happened (backstop and round-trip measurements). */
  private pressedAt = 0
  /** Whether this press has been timed yet (once per press). Also means the far
   * end has replied since; see `trustworthy`. */
  private timed = false
  /** When the last chunk was parsed, so the backstop can tell whether the settle
   * period actually elapsed. */
  private lastParsedAt = 0
  /** Slowest recent round trip from a history key to the first reply, decayed
   * over time. Null until the session has answered. */
  private latencyMs: number | null = null
  private run = 0
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: HistoryRepeatOptions) {
    this.read = options.read
    this.emit = options.emit
  }

  /** The current deadline. */
  get deadlineMs(): number {
    if (this.latencyMs === null) return MAX_DEADLINE_MS
    const scaled = Math.round(this.latencyMs * DEADLINE_SAFETY) + 15
    return Math.max(MIN_DEADLINE_MS, Math.min(MAX_DEADLINE_MS, scaled))
  }

  /**
   * Whether the deadline is real evidence rather than the ceiling: false once
   * the measured round trip needs more than `MAX_DEADLINE_MS` (silence would
   * then mean "not yet", not "nothing"), and before any measurement.
   */
  private get deadlineBounded(): boolean {
    if (this.latencyMs === null) return false
    return Math.round(this.latencyMs * DEADLINE_SAFETY) + 15 <= MAX_DEADLINE_MS
  }

  /**
   * Bytes on their way to the far end. Anything but a history key ends the run.
   */
  noteInput(data: Uint8Array): void {
    if (!isHistoryKey(data)) {
      this.reset()
      return
    }
    // A press still pending is resolved now rather than canceled, so a fast
    // walk through history still gets feedback.
    if (this.pending !== null) {
      this.clearTimer()
      this.compare()
    }
    const input = this.read()
    // No readable line (no origin, a command running, alternate screen): skip.
    if (!input) {
      this.reset()
      return
    }
    this.pending = input.text
    this.pressedAt = Date.now()
    this.timed = false
    this.schedule(this.deadlineMs)
  }

  /** A write was parsed; the redraw is under way, so compare once it settles. */
  noteParsed(): void {
    if (this.pending === null) return
    this.lastParsedAt = Date.now()
    if (!this.timed) {
      this.timed = true
      this.observeLatency(this.lastParsedAt - this.pressedAt)
    }
    this.schedule(SETTLE_MS)
  }

  /** The line is over (Enter, `^C`, disconnect, teardown). */
  reset(): void {
    this.clearTimer()
    this.pending = null
    this.run = 0
  }

  /**
   * Fold one round trip into the deadline: rises immediately, decays slowly.
   */
  private observeLatency(ms: number): void {
    const seen = Math.max(0, ms)
    if (this.latencyMs === null || seen > this.latencyMs) this.latencyMs = seen
    else this.latencyMs = this.latencyMs * 0.8 + seen * 0.2
  }

  /** Compare in `delayMs`, or at the backstop, whichever comes first. */
  private schedule(delayMs: number): void {
    this.clearTimer()
    const remaining = this.pressedAt + MAX_WAIT_MS - Date.now()
    const wait = Math.max(0, Math.min(delayMs, remaining))
    this.timer = setTimeout(() => {
      this.timer = null
      this.compare()
    }, wait)
  }

  /**
   * Whether "unchanged" is a real finding rather than an early look; a false
   * flicker under a press that did change the line is worse than silence. If the
   * far end replied, the settle period must have elapsed since its last chunk;
   * if nothing came back, the deadline must be bounded (`deadlineBounded`). A
   * press resolved by the next keystroke goes through this too.
   */
  private get trustworthy(): boolean {
    if (this.timed) return Date.now() - this.lastParsedAt >= SETTLE_MS
    return this.deadlineBounded
  }

  private compare(): void {
    const before = this.pending
    this.pending = null
    if (before === null) return
    // Resolved, but silently.
    if (!this.trustworthy) {
      this.run = 0
      return
    }
    const now = this.read()
    // The line became unreadable (scrolled, painted over, stale origin).
    if (!now) {
      this.run = 0
      return
    }
    if (now.text !== before) {
      this.run = 0
      return
    }
    this.run += 1
    this.emit({ origin: now.origin, cursor: now.cursor, run: this.run, seq: ++this.seq })
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
