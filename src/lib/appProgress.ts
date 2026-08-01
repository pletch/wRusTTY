/**
 * Application-driven progress and notifications — OSC 9 and OSC 777.
 *
 * The counterpart to lib/shellIntegration.ts, and deliberately a separate
 * mechanism rather than an extension of it. OSC 133/633 is emitted by the
 * *shell*, around its prompt, which is why it goes quiet for exactly the case
 * this module exists to cover: a full-screen program is one command as far as
 * the shell is concerned, so nothing is reported for the minutes it runs, and
 * `CommandTracker.setAltScreen` suppresses the indicator on top of that.
 *
 * These sequences are emitted by the *program itself*, straight to its own
 * stdout. That needs no shell, no local PTY and no process inspection, so it
 * crosses SSH exactly like a title change does — which makes it the only
 * signal available for a full-screen TUI on a remote host.
 *
 *   OSC 9 ; 4 ; <state> ; <percent> ST   progress (ConEmu; Windows Terminal
 *                                        draws this in the tab, and it is what
 *                                        Claude Code emits while it works)
 *   OSC 9 ; <text> ST                    notification (iTerm2)
 *   OSC 777 ; notify ; <title> ; <body>  notification (urxvt, kitty)
 *
 * Pure parsing — no state, no DOM — so the grammar can be tested on its own.
 * `Terminal.tsx` owns what the results mean for a pane.
 */

/** A program's own report of what it is doing. Percent is separate from state
 * because the two are independent in the wire format: an app can report a bare
 * "still working" with no number, and one that reports a number can be doing so
 * from an error or paused state. */
export interface AppProgress {
  state: 'active' | 'error' | 'paused'
  /** 0–100, or null when the app reported indeterminate progress — which is
   * the common case for a tool that knows it is busy but not how far along it
   * is. Claude Code sends state 3 (indeterminate) throughout. */
  percent: number | null
}

export interface RemoteNotification {
  /** Null under OSC 9, which has no title field — only OSC 777 carries one.
   * The caller supplies something (the pane's name) in its place. */
  title: string | null
  body: string
}

export type Osc9Result =
  /** `progress: null` is a real result, not "nothing to do": it is the app
   * explicitly clearing its progress (ConEmu state 0). */
  | { kind: 'progress'; progress: AppProgress | null }
  | { kind: 'notify'; notification: RemoteNotification }
  | { kind: 'ignore' }

/**
 * Text from the far end lands in a toast and in the OS notification centre, so
 * it is bounded here rather than trusted. A host that wants to paper over the
 * screen has plenty of ways to do it inside the terminal grid; it does not get
 * one that escapes the grid.
 */
const MAX_TEXT = 200

function clampText(raw: string): string {
  // Control characters would otherwise reach a native notification, where a
  // newline or a lone CR is a formatting primitive rather than a character.
  const clean = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean
}

/** ConEmu's `9;4;st;pr`. Percent is optional in every state and meaningless in
 * the indeterminate one, so an absent or unparseable value is null rather than
 * an error — the state is the part that always matters. */
function parsePercent(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) return null
  return Math.min(100, Math.max(0, n))
}

/**
 * @param data everything after `9;` — what `registerOscHandler` hands over.
 */
export function parseOsc9(data: string): Osc9Result {
  const sep = data.indexOf(';')
  const head = sep === -1 ? data : data.slice(0, sep)

  // OSC 9 is overloaded: ConEmu defined numbered subcommands under it, and
  // iTerm2 later defined the whole payload as notification text. They are
  // genuinely ambiguous for a message beginning with a digit and a semicolon,
  // and no terminal resolves that — this takes the same line Windows Terminal
  // does and recognises only the two subcommands anyone emits, treating
  // everything else as iTerm2 text. A notification that happens to start
  // "4;" or "9;" is the cost, and nothing sends one.
  if (sep !== -1) {
    if (head === '4') {
      const fields = data.slice(sep + 1).split(';')
      const percent = parsePercent(fields[1])
      switch (fields[0]) {
        case '0':
          return { kind: 'progress', progress: null }
        case '1':
          return { kind: 'progress', progress: { state: 'active', percent } }
        case '2':
          return { kind: 'progress', progress: { state: 'error', percent } }
        case '3':
          // Indeterminate. Any percent sent alongside is meaningless by
          // definition, so it is dropped rather than shown.
          return { kind: 'progress', progress: { state: 'active', percent: null } }
        case '4':
          return { kind: 'progress', progress: { state: 'paused', percent } }
        default:
          // An unknown state is not a clear. Falling through to `progress:
          // null` here would let a future or malformed state silently stop an
          // indicator that is legitimately running.
          return { kind: 'ignore' }
      }
    }
    // ConEmu's working-directory report. Nothing here consumes it, and it must
    // not be mistaken for notification text.
    if (head === '9') return { kind: 'ignore' }
  } else if (head === '4') {
    // A bare `OSC 9 ; 4` carries no state at all.
    return { kind: 'ignore' }
  }

  const body = clampText(data)
  if (!body) return { kind: 'ignore' }
  return { kind: 'notify', notification: { title: null, body } }
}

interface ProgressHandlers {
  onChange: (progress: AppProgress | null) => void
  /** Progress that had been up has ended, with how long it lasted. Never
   * fired for a `reset()`. */
  onComplete: (durationMs: number) => void
}

/**
 * Turns a stream of OSC 9;4 reports into the two things a pane cares about:
 * what to show, and the moment a program stopped.
 *
 * Split out of the OSC handler rather than left inline because the transition
 * is the part with rules — dropping repeats, distinguishing "the work ended"
 * from "the session did", and timing the run rather than the last step.
 * Deliberately a plain class, driven from the output hot path, for the same
 * reason `CommandTracker` is.
 */
export class ProgressTracker {
  private progress: AppProgress | null = null
  /** When the current run *started*, not when it last changed — so a
   * determinate reporter stepping through percentages still reports the whole
   * run rather than the last step. */
  private since = 0
  private readonly handlers: ProgressHandlers

  constructor(handlers: ProgressHandlers) {
    this.handlers = handlers
  }

  set(next: AppProgress | null): void {
    const previous = this.progress
    // Repeats are dropped here rather than downstream because this sits on the
    // output hot path: a busy program re-sends the same indeterminate state
    // for as long as it runs, at whatever rate it likes, and each one would
    // otherwise re-render the tab strip to say nothing had changed.
    if (previous === next) return
    if (previous && next && previous.state === next.state && previous.percent === next.percent) {
      return
    }
    this.progress = next
    if (next && !previous) this.since = Date.now()
    this.handlers.onChange(next)
    if (previous && !next) this.handlers.onComplete(Date.now() - this.since)
  }

  /**
   * Drop any progress without reporting it as finished — for a disconnect or a
   * teardown, where the program's fate is genuinely unknown.
   *
   * The distinction is the whole point: a program that finished wants you
   * back, and a connection that dropped mid-run knows nothing about whether it
   * did. Still emits `onChange(null)`, because the indicator must come down
   * either way.
   */
  reset(): void {
    if (this.progress === null) return
    this.progress = null
    this.handlers.onChange(null)
  }
}

/**
 * OSC 777's `notify;<title>;<body>`.
 *
 * @param data everything after `777;`.
 * @returns null for any other OSC 777 subcommand, of which this handles none.
 */
export function parseOsc777(data: string): RemoteNotification | null {
  const fields = data.split(';')
  if (fields[0] !== 'notify') return null
  const title = clampText(fields[1] ?? '')
  // Rejoined rather than taken as one field: the format has no escaping, so a
  // body containing a semicolon arrives split, and every sender assumes the
  // last field runs to the end.
  const body = clampText(fields.slice(2).join(';'))
  if (!title && !body) return null
  // A title-only notification is normal (`notify-send`-style one-liners), and
  // reads better as a body under the pane's name than as a title with nothing
  // under it.
  if (!body) return { title: null, body: title }
  return { title, body }
}
