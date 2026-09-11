/**
 * "That Up went somewhere" — feedback for walking a shell's history.
 *
 * The complaint this answers: pressing Up at a remote prompt through a stretch
 * of history where the same command was run again and again looks identical to
 * pressing a key that never arrived. Nothing on screen changes either way. On
 * a real host these stretches run long — twenty-eight presses on one
 * `journalctl` line is what prompted this.
 *
 * Nothing here talks to the shell, and nothing needs configuring on the far
 * end — the point being that a terminal *can* answer this on its own, for any
 * host, including the appliance whose `~/.bashrc` you will never be allowed to
 * edit. The whole trick is that `PromptInputTracker` already reads the input
 * line off the grid rather than modelling it from keystrokes, so "what does
 * the prompt line say" is a question that can be asked before a keypress and
 * again afterwards. See lib/promptInput.ts.
 *
 * What it produces is the *finding*; the flicker that shows it lives in
 * lib/historyFlicker.ts.
 *
 * ## Why this does not wait for a reply
 *
 * The first version treated "the far end answered" as the trigger to compare,
 * and "the far end did not answer" as a separate finding rendered in amber,
 * meaning a wedged session. Both halves were wrong, and measured against a
 * live host rather than argued about:
 *
 *   - **An unchanged line often produces no reply at all.** readline diffs the
 *     recalled line against what is displayed and writes only the difference,
 *     so recalling a duplicate can put nothing whatever on the wire. Waiting
 *     for a write meant the one case this exists for was the one case it could
 *     not see.
 *   - **"No reply" is not evidence of a wedged session.** Pressing Up while
 *     `apt` is midway through, or at a password prompt, or in a program that
 *     ignores arrows, is also silent — and an origin inferred from a quiet
 *     period cannot tell any of them from a dead link. It cried wolf.
 *
 * So nothing here claims a session is dead. A finding means "the line did not
 * change", which is true whichever of those it was.
 *
 * ## Keeping up with a fast hand
 *
 * Someone hunting through history does not press Up once and wait; they press
 * it as fast as it will go. Two things make that work rather than lag:
 *
 *   - **The next press resolves the previous one.** A comparison still pending
 *     when another history key goes out is run immediately instead of being
 *     cancelled — the user's own next keystroke is the proof that enough time
 *     has passed, so a burst costs no waiting at all.
 *   - **The deadline is measured, not guessed.** For the last press of a burst
 *     there is nothing to resolve it, so it falls back to a timer — but one
 *     derived from how quickly *this* session has actually been answering,
 *     which on a host down the hall is a small fraction of what a fixed value
 *     safe for a transatlantic link would have to be.
 */

import type { Cell, PromptInput } from './promptInput'

export interface HistoryRepeat {
  /** First cell of the input, i.e. just past the prompt. */
  origin: Cell
  /** Where the cursor ended up — the end of the input. */
  cursor: Cell
  /**
   * How many presses in a row have now landed on this same text, counting
   * this one. 1 is a single duplicate; 20 means you are twenty deep in the
   * same command and the shell has been telling you nothing about it.
   */
  run: number
  /** Bumped per finding, so a consumer can tell two identical ones apart —
   * which is the normal case here, not the exception. */
  seq: number
}

/**
 * How long after the last parsed chunk the line is read back.
 *
 * A history recall that *does* redraw is not one write. The far end sends a
 * carriage return, an erase, the recalled text and a cursor move, and those
 * arrive split across however many segments the network felt like — so the
 * first `onWriteParsed` after a keypress usually lands mid-redraw, on a line
 * that is briefly empty. Comparing there reports "changed" for every press.
 *
 * Restarted by each further chunk, so this is a quiet period rather than a
 * deadline: the comparison happens once the far end has stopped talking.
 */
export const SETTLE_MS = 40

/** Floor under the measured deadline. Below this the comparison starts racing
 * the far end's own redraw on even a local connection. */
export const MIN_DEADLINE_MS = 45

/** Ceiling over it, for a link slow enough that waiting for certainty would
 * cost more than the answer is worth. */
export const MAX_DEADLINE_MS = 400

/**
 * What the measured round trip is multiplied by to get the deadline.
 *
 * Three, because the thing being waited out is not the median reply but the
 * slow one — a host that usually answers in 4ms and occasionally takes 12
 * must not have the twelve read as silence. Cheap insurance: on a local host
 * it is still well under a tenth of a second.
 */
const DEADLINE_SAFETY = 3

/**
 * The longest the comparison may be put off, measured from the keypress.
 *
 * `SETTLE_MS` restarting on every chunk is what makes a split redraw work, and
 * it is also what would let a pane that is busy printing something unrelated
 * postpone the comparison indefinitely. This is the backstop.
 */
export const MAX_WAIT_MS = 700

/**
 * Whether these bytes are a bare Up or Down — the keys that walk history.
 *
 * Both the legacy form (`CSI A`) and application cursor mode (`SS3 A`), since
 * which one goes out depends on DECCKM and readline sets it. The parameter
 * check is what keeps this to *history* keys: `CSI 1;5A` is Ctrl+Up, which
 * moves between panes in tmux and walks nothing, and reporting on it would be
 * a lie about what just happened.
 *
 * Under the Kitty protocol an unmodified arrow keeps its legacy form but may
 * carry an explicit "no modifiers" parameter and an event type. Release
 * events are rejected: with them enabled one press sends two sequences, and
 * the second would compare a line against itself and report a repeat that
 * never happened.
 */
export function isHistoryKey(data: Uint8Array): boolean {
  if (data.length < 3 || data.length > 12) return false
  // The ESC is matched as a byte rather than inside the pattern: a control
  // character in a regex literal is a lint error (`no-control-regex`) however
  // it is spelled, and escaping past that would leave the one part of this
  // worth reading at a glance the least readable part of it.
  if (data[0] !== 0x1b) return false
  let text = ''
  for (let i = 1; i < data.length; i++) text += String.fromCharCode(data[i])
  return /^(?:\[(?:|1|1;1(?::[12])?)|O)[AB]$/.test(text)
}

export interface HistoryRepeatOptions {
  /** The prompt line as it stands. `PromptInputTracker.read`, in practice. */
  read: () => PromptInput | null
  /** Called when a press landed on the line already showing. */
  emit: (repeat: HistoryRepeat) => void
}

/**
 * Watches one pane's history keys.
 *
 * Driven from the same two places the prompt tracker is — the bytes going out
 * and the writes coming back — so it adds no polling, and no work at all to a
 * pane where nobody is pressing Up.
 */
export class HistoryRepeatWatcher {
  private readonly read: () => PromptInput | null
  private readonly emit: (repeat: HistoryRepeat) => void

  /** The line as it was when the history key went out, or null when no press
   * is outstanding. */
  private pending: string | null = null
  /** When that press happened: the backstop is measured from the key, and so
   * is the round trip this learns from. */
  private pressedAt = 0
  /** Whether this press has already contributed a measurement, so a redraw
   * split across five chunks is timed once rather than five times. */
  private timed = false
  /** The slowest recent round trip from a history key to the first byte back,
   * decayed so a one-off stall does not slow the pane down for ever. Null
   * until this session has answered at all. */
  private latencyMs: number | null = null
  private run = 0
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: HistoryRepeatOptions) {
    this.read = options.read
    this.emit = options.emit
  }

  /** The deadline as it currently stands, for tests and for callers that want
   * to explain themselves. */
  get deadlineMs(): number {
    if (this.latencyMs === null) return MAX_DEADLINE_MS
    const scaled = Math.round(this.latencyMs * DEADLINE_SAFETY) + 15
    return Math.max(MIN_DEADLINE_MS, Math.min(MAX_DEADLINE_MS, scaled))
  }

  /**
   * Bytes on their way to the far end.
   *
   * Anything that is not a history key ends the run: having typed a character
   * or moved along the line, you are no longer walking history, and the next
   * Up starts counting again from one.
   */
  noteInput(data: Uint8Array): void {
    if (!isHistoryKey(data)) {
      this.reset()
      return
    }
    // Another history key while one is outstanding: the user is hunting, and
    // their own keystroke has established that time has passed. Resolve the
    // previous press now rather than cancelling it — cancelling is what made
    // a fast walk through history produce no feedback at all until the hand
    // stopped moving.
    if (this.pending !== null) {
      this.clearTimer()
      this.compare()
    }
    const input = this.read()
    // No readable line means no origin — before the first prompt, mid-command,
    // on the alternate screen, or at a prompt this never got the chance to
    // infer. All of them are cases where there is nothing to compare and no
    // honest place to draw, so the press passes without comment rather than
    // being guessed at.
    if (!input) {
      this.reset()
      return
    }
    this.pending = input.text
    this.pressedAt = Date.now()
    this.timed = false
    this.schedule(this.deadlineMs)
  }

  /** A write has been fully parsed. Only ever brings the comparison forward:
   * the far end having spoken means the redraw is under way, and the line is
   * worth reading as soon as it stops. */
  noteParsed(): void {
    if (this.pending === null) return
    if (!this.timed) {
      this.timed = true
      this.observeLatency(Date.now() - this.pressedAt)
    }
    this.schedule(SETTLE_MS)
  }

  /** The line is over — Enter, `^C`, a disconnect, a pane going away. */
  reset(): void {
    this.clearTimer()
    this.pending = null
    this.run = 0
  }

  /**
   * Fold one observed round trip into the deadline.
   *
   * Rises immediately and falls slowly. A link that has just got slower has to
   * be believed at once, or the very next press is misread; a link that looks
   * fast once should not drag the deadline down under a stall that is still
   * happening.
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

  private compare(): void {
    const before = this.pending
    this.pending = null
    if (before === null) return
    const now = this.read()
    // The line stopped being readable between the press and the redraw: the
    // screen scrolled, a program painted over the prompt, or the origin went
    // stale. Whatever is there now is not the line that was compared against.
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
