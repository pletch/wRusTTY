/**
 * OSC 133 shell integration (the "semantic prompt" protocol). Over SSH, telnet
 * or serial there's no local PTY to inspect for the foreground process, so
 * the remote shell's own reports are the only reliable "command started" /
 * "finished with this exit code" signal. A cooperating shell emits:
 *
 *   OSC 133 ; A ST          prompt is about to be drawn
 *   OSC 133 ; B ST          prompt drawn; keystrokes from here are the command
 *   OSC 133 ; C ST          command is executing, output follows
 *   OSC 133 ; D ; <code> ST command finished, with its exit status
 *
 * VS Code's OSC 633 uses the same letters plus `E`, which carries the command
 * line. See docs/SHELL_INTEGRATION.md for the shell snippets.
 *
 * A plain class: it's driven from an OSC handler on the output hot path.
 */

export interface CommandActivity {
  state: 'idle' | 'running'
  /** Epoch ms the running command started; null while idle. */
  startedAt: number | null
  /** The command line, from OSC 633's `E`; null under plain OSC 133. */
  command: string | null
}

export interface CommandResult {
  command: string | null
  /** Null when the shell reported no code (a bare `D`, or a partial integration
   * whose run was closed by the next prompt). */
  exitCode: number | null
  durationMs: number
  /** The run used the alternate screen, i.e. it was a full-screen program (vim,
   * top, less); its completion isn't worth a notification. */
  interactive: boolean
}

export const IDLE: CommandActivity = { state: 'idle', startedAt: null, command: null }

/** Commands shorter than this never show the running indicator. */
const RUNNING_VISIBLE_AFTER_MS = 400

/** Human-readable run length for a completion notice (whole seconds). */
export function formatCommandDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** Unescapes OSC 633 command text (`\\` and `\xHH`), in one left-to-right pass
 * so an escaped `\x3b` can't become a separator. Invalid escapes are left
 * as-is. */
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
  /** Reported by `E` before the `C` that starts its run. */
  private pendingCommand: string | null = null
  private sawAltScreen = false
  /** Whether the alternate screen is up now (`sawAltScreen` records whether the
   * run touched it). */
  private onAltScreen = false
  /** A program in this run reported its own progress (OSC 9;4); sticky for the
   * run. See noteProgress. */
  private sawProgress = false
  /** Whether `running` is currently shown, so idle only undoes a real report. */
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

  /** Show the indicator once the run has lasted long enough, and only while it
   * owns the screen (see setAltScreen). */
  private armShowTimer() {
    this.clearShowTimer()
    this.showTimer = setTimeout(() => {
      this.showTimer = null
      if (this.running && !this.onAltScreen && !this.sawProgress) this.emitRunning()
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
   * Feed an OSC 133 / 633 payload (everything after the identifier, e.g. `"D;0"`).
   * Always returns true: this app owns these sequences.
   */
  handleOsc(data: string): boolean {
    // Markers aren't gated on the alternate screen: OSC dispatch runs before
    // the parser, so the chunk leaving the alternate screen (carrying the
    // closing `D`/`A`) still reads as alternate. Only the display is
    // suppressed (see setAltScreen).
    const sep = data.indexOf(';')
    const kind = sep === -1 ? data : data.slice(0, sep)
    const rest = sep === -1 ? '' : data.slice(sep + 1)

    switch (kind) {
      case 'A':
        // A new prompt means the previous command is over, even for partial
        // integrations that never send `D`; close it with an unknown status.
        if (this.running) this.finish(null)
        break

      case 'B':
        // Drop any command line left from a run that never started.
        this.pendingCommand = null
        break

      case 'C':
        // Some shells repeat `C` per pipeline segment; don't restart the clock.
        if (!this.running) this.start()
        break

      case 'D': {
        // Enter on an empty prompt sends `D` with no `C` (repeating the previous
        // status); nothing ran.
        if (!this.running) break
        const code = rest.split(';')[0]
        const parsed = Number.parseInt(code, 10)
        this.finish(Number.isNaN(parsed) ? null : parsed)
        break
      }

      case 'E':
        // OSC 633 only: `E;<commandline>;<nonce>`. Semicolons in the command are
        // escaped, so the first raw `;` ends it.
        this.pendingCommand = unescapeCommandText(rest.split(';')[0]) || null
        break

      // `P` (property reports such as `P;Cwd=`) and unknown letters are consumed.
    }
    return true
  }

  /**
   * A program reported its own progress (OSC 9;4), so it owns the pane's
   * indicator for the rest of the run: one `claude` or `cargo watch` is many
   * pieces of work, which the shell can't see. The run is still tracked. Sticky
   * for the run, so the running marker doesn't return between turns (and hide
   * the attention marker a cleared progress leaves).
   */
  noteProgress() {
    if (this.sawProgress) return
    this.sawProgress = true
    this.clearShowTimer()
    this.emitIdle()
  }

  /** The terminal switched screen buffers. Entering the alternate screen during
   * a run marks it interactive, and suppresses the indicator while it's up. */
  setAltScreen(isAlternate: boolean) {
    this.onAltScreen = isAlternate
    if (isAlternate) {
      if (this.running) this.sawAltScreen = true
      // A full-screen program is something you're using, not waiting on; don't
      // spin for a whole vim or tmux session. The run is still tracked.
      this.clearShowTimer()
      this.emitIdle()
    } else if (this.running) {
      // The program exited and the shell's `D` usually follows within
      // milliseconds; re-arm the delay rather than flashing the indicator.
      this.armShowTimer()
    }
  }

  /** Drop any in-flight run without reporting it (a disconnect, where its fate
   * is unknown). */
  reset() {
    // Cleared unconditionally, or a disconnect during a full-screen program
    // would leave the indicator suppressed.
    this.onAltScreen = false
    // Sticky per run, so it goes with the run.
    this.sawProgress = false
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
    this.sawProgress = false
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
    this.sawProgress = false
    this.clearShowTimer()
    this.emitIdle()
    this.handlers.onComplete(result)
  }
}
