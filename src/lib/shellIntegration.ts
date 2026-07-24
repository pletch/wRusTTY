/**
 * OSC 133 shell integration — the "semantic prompt" protocol.
 *
 * Over SSH/telnet/serial there is no local PTY to inspect. A terminal that
 * spawns its own shell can call tcgetpgrp() on the PTY master to see which
 * process is in the foreground; nothing equivalent exists here, because the
 * process actually running lives on a machine this app reaches only as a
 * byte stream. So the only reliable source of "a command started" / "it
 * finished, with this exit code" is the remote shell itself, saying so out
 * of band.
 *
 * OSC 133 is that protocol — FinalTerm's originally, now implemented by
 * iTerm2, kitty, WezTerm, Windows Terminal and VS Code. A cooperating shell
 * brackets each prompt and command with:
 *
 *   OSC 133 ; A ST          prompt is about to be drawn
 *   OSC 133 ; B ST          prompt drawn; keystrokes from here are the command
 *   OSC 133 ; C ST          command is executing, output follows
 *   OSC 133 ; D ; <code> ST command finished, with its exit status
 *
 * VS Code's OSC 633 is a superset using the same letters plus `E`, which
 * carries the command line as text. Worth handling both: `E` is the only way
 * to name the command in a notification, and shells already set up for VS
 * Code emit it for free. See docs/SHELL_INTEGRATION.md for the snippets.
 *
 * Deliberately a plain class rather than anything React-aware — it's driven
 * from an xterm OSC handler sitting on the hot path of the output stream.
 */

export interface CommandActivity {
  state: 'idle' | 'running'
  /** Epoch ms the running command started; null while idle. */
  startedAt: number | null
  /** The command line, when the shell reported one (OSC 633's `E`). Null
   * under plain OSC 133, which has no field for it. */
  command: string | null
}

export interface CommandResult {
  command: string | null
  /** Null when the shell reported no code — a bare `OSC 133 ; D ST`, which
   * is legal, and also what a partial integration that never emits `D` at
   * all leaves us to infer from the next prompt. */
  exitCode: number | null
  durationMs: number
  /** The command spent time on the alternate screen, i.e. it was a
   * full-screen interactive program (vim, top, less). Tracked because
   * "vim finished after 20 minutes" is not a notification anyone wants —
   * the user quit it themselves, deliberately, a moment ago. */
  interactive: boolean
}

export const IDLE: CommandActivity = { state: 'idle', startedAt: null, command: null }

/** A command that starts and finishes inside this window never shows the
 * indicator at all. Nearly everything typed at a prompt returns in well under a
 * second, and flashing a spinner for each one is noise rather than information —
 * the indicator exists to say "something is still going", which is only a
 * meaningful claim once it has gone on longer than a keystroke. */
const RUNNING_VISIBLE_AFTER_MS = 400

/** Human-readable run length for a completion notice. Only ever shown for
 * commands past the notification threshold, so it never needs sub-second
 * resolution. */
export function formatCommandDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** VS Code's OSC 633 escapes backslashes as `\\` and `;` (plus other
 * control characters) as `\xHH`, so command text can't be mistaken for
 * extra protocol fields. Done as one left-to-right pass rather than two
 * replaces, or a command containing a literal `\x3b` would get unescaped
 * into a `;` that was never a separator. Anything that isn't a valid
 * escape is left exactly as it arrived. */
function unescapeCommandText(raw: string): string {
  return raw.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_match, _all, hex: string | undefined) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : '\\',
  )
}

interface Handlers {
  onChange: (activity: CommandActivity) => void
  onComplete: (result: CommandResult) => void
}

export class CommandTracker {
  private running = false
  private startedAt = 0
  /** The command line for the run currently in flight. */
  private command: string | null = null
  /** Reported by `E` *before* the `C` that starts the run it describes, so
   * it's parked here until then. */
  private pendingCommand: string | null = null
  private sawAltScreen = false
  /** Whether the alternate screen is up right now (as opposed to `sawAltScreen`,
   * which records that the run in flight touched it at some point). */
  private onAltScreen = false
  /** Whether a `running` activity is currently showing, so idle is only sent to
   * undo one that was actually sent. */
  private reportedRunning = false
  private showTimer: ReturnType<typeof setTimeout> | null = null
  private readonly handlers: Handlers

  constructor(handlers: Handlers) {
    this.handlers = handlers
  }

  private clearShowTimer() {
    if (this.showTimer === null) return
    clearTimeout(this.showTimer)
    this.showTimer = null
  }

  /** Show the indicator once the run has lasted long enough to be worth one, and
   * only while the run actually owns the screen (see setAltScreen). */
  private armShowTimer() {
    this.clearShowTimer()
    this.showTimer = setTimeout(() => {
      this.showTimer = null
      if (this.running && !this.onAltScreen) this.emitRunning()
    }, RUNNING_VISIBLE_AFTER_MS)
  }

  private emitRunning() {
    if (this.reportedRunning) return
    this.reportedRunning = true
    this.handlers.onChange({
      state: 'running',
      startedAt: this.startedAt,
      command: this.command,
    })
  }

  private emitIdle() {
    if (!this.reportedRunning) return
    this.reportedRunning = false
    this.handlers.onChange(IDLE)
  }

  /**
   * Feed the payload of an OSC 133 / OSC 633 sequence — everything after the
   * identifier and its semicolon, which is what xterm's registerOscHandler
   * hands over (`"D;0"` for `OSC 133 ; D ; 0 ST`).
   *
   * Always returns true: this app owns 133 and 633, and consuming them keeps
   * them from being treated as anything else.
   */
  handleOsc(data: string): boolean {
    // Markers are never gated on the alternate screen being up, even though the
    // ones emitted from inside a full-screen program describe its commands and
    // not the outer shell's. The engine dispatches OSC by scanning the raw byte
    // stream *before* the chunk reaches the parser, so the screen-buffer state
    // still reads as "alternate" on the very chunk that leaves it — and that is
    // exactly the chunk carrying the `D`/`A` that ends the run. Dropping those
    // strands the run open and leaves the indicator stuck on after quitting tmux
    // or nano. Suppressing the *display* while the alternate screen is up (see
    // setAltScreen) deals with the noise without losing the transitions.
    const sep = data.indexOf(';')
    const kind = sep === -1 ? data : data.slice(0, sep)
    const rest = sep === -1 ? '' : data.slice(sep + 1)

    switch (kind) {
      case 'A':
        // A fresh prompt. Under a complete integration this arrives just
        // after `D` and there's nothing left to finish. It matters for the
        // partial ones (and there are plenty in the wild) that mark prompts
        // and command starts but never report an exit code: a new prompt
        // still means the previous command is over, so close it out with an
        // unknown status rather than leaving the pane spinning forever.
        if (this.running) this.finish(null)
        break

      case 'B':
        // Prompt finished drawing; whatever is typed next is the command.
        // Nothing to do beyond dropping a command line left over from a run
        // that never started, so it can't attach itself to the next one.
        this.pendingCommand = null
        break

      case 'C':
        // Ignored while already running: some shells emit `C` again for each
        // segment of a pipeline, and restarting the clock there would report
        // only the last segment's duration.
        if (!this.running) this.start()
        break

      case 'D': {
        // Pressing Enter on an empty prompt produces a `D` with no `C` before
        // it (the shell reports the *previous* command's status again). No
        // command ran, so there is nothing to report.
        if (!this.running) break
        const code = rest.split(';')[0]
        const parsed = Number.parseInt(code, 10)
        this.finish(Number.isNaN(parsed) ? null : parsed)
        break
      }

      case 'E':
        // OSC 633 only. `E;<commandline>;<nonce>` — the nonce is optional,
        // and any `;` inside the command itself is escaped, so the first
        // unescaped `;` genuinely ends the command text.
        this.pendingCommand = unescapeCommandText(rest.split(';')[0]) || null
        break

      // `P` (OSC 633 property reports such as `P;Cwd=/home/tim`) and any
      // future letters fall through unhandled but still consumed.
    }
    return true
  }

  /** Called whenever the terminal switches screen buffers. Entering the
   * alternate buffer is how a full-screen program announces itself: mid-run it
   * marks the run interactive (an interactive program started from the prompt is
   * still one "command" as far as OSC 133 is concerned), and either way it gates
   * the semantic-prompt markers emitted from inside it — see handleOsc. */
  setAltScreen(isAlternate: boolean) {
    this.onAltScreen = isAlternate
    if (isAlternate) {
      if (this.running) this.sawAltScreen = true
      // A full-screen program is not a job you are waiting on — it is the thing
      // you are using. Spinning for the whole life of a tmux attach or a vim
      // session says nothing and never stops, so the indicator stands down for
      // as long as the alternate screen is up. The run is still tracked; only
      // its display is suppressed.
      this.clearShowTimer()
      this.emitIdle()
    } else if (this.running) {
      // Back on the primary screen with the run still open: the program has
      // exited and the shell's `D` is usually a few milliseconds behind, so go
      // through the delay again rather than flashing the indicator on the way
      // out of every editor.
      this.armShowTimer()
    }
  }

  /** Drop any in-flight run without reporting it — for a disconnect, where
   * the command's fate is genuinely unknown and a completion notification
   * would be a lie. */
  reset() {
    // Cleared unconditionally: a disconnect while a full-screen program was up
    // would otherwise leave the gate in handleOsc stuck on, silently ignoring
    // every marker for the rest of the pane's life.
    this.onAltScreen = false
    this.clearShowTimer()
    if (!this.running) return
    this.running = false
    this.command = null
    this.pendingCommand = null
    this.sawAltScreen = false
    this.emitIdle()
  }

  private start() {
    this.running = true
    this.startedAt = Date.now()
    this.command = this.pendingCommand
    this.pendingCommand = null
    this.sawAltScreen = false
    this.armShowTimer()
  }

  private finish(exitCode: number | null) {
    const result: CommandResult = {
      command: this.command,
      exitCode,
      durationMs: Date.now() - this.startedAt,
      interactive: this.sawAltScreen,
    }
    this.running = false
    this.command = null
    this.sawAltScreen = false
    this.clearShowTimer()
    this.emitIdle()
    this.handlers.onComplete(result)
  }
}
