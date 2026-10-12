/**
 * Application-driven progress and notifications (OSC 9 and OSC 777). Unlike OSC
 * 133, these come from the program itself rather than the shell, so they work
 * through SSH for a full-screen program the shell reports as one command.
 *
 *   OSC 9 ; 4 ; <state> ; <percent> ST   progress (ConEmu; shown in Windows
 *                                        Terminal's tab; emitted by Claude Code)
 *   OSC 9 ; <text> ST                    notification (iTerm2)
 *   OSC 777 ; notify ; <title> ; <body>  notification (urxvt, kitty)
 *
 * Pure parsing; `Terminal.tsx` decides what results mean for a pane.
 */

/** A program's own report of what it's doing. State and percent are
 * independent on the wire. */
export interface AppProgress {
  state: 'active' | 'error' | 'paused'
  /** 0-100, or null for indeterminate (Claude Code always sends state 3). */
  percent: number | null
}

export interface RemoteNotification {
  /** Null under OSC 9, which has no title; the caller uses the pane name. */
  title: string | null
  body: string
}

export type Osc9Result =
  /** `progress: null` means the app cleared its progress (state 0). */
  | { kind: 'progress'; progress: AppProgress | null }
  | { kind: 'notify'; notification: RemoteNotification }
  /** ConEmu's working-directory report, `9;9;<path>` (documented by Windows
   *  Terminal for PowerShell, emitted by oh-my-posh); drive-absolute only. */
  | { kind: 'cwd'; cwd: string }
  | { kind: 'ignore' }

/**
 * Remote text lands in toasts and OS notifications, so it's bounded.
 */
const MAX_TEXT = 200

function clampText(raw: string): string {
  // Control characters are formatting in a native notification.
  const clean = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean
}

/** Percent for `9;4;st;pr`: optional, so absent or unparseable is null. */
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

  // OSC 9 is overloaded (ConEmu subcommands vs iTerm2 text). Like Windows
  // Terminal, recognize only `4;` and `9;` and treat everything else as text.
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
          // Indeterminate: any percent is meaningless.
          return { kind: 'progress', progress: { state: 'active', percent: null } }
        case '4':
          return { kind: 'progress', progress: { state: 'paused', percent } }
        default:
          // Unknown state is not a clear; don't stop a running indicator.
          return { kind: 'ignore' }
      }
    }
    // ConEmu cwd (quoted or bare); only drive-absolute paths.
    if (head === '9') {
      const cwd = data.slice(sep + 1).trim().replace(/^"(.*)"$/, '$1')
      if (/^[A-Za-z]:[\\/]/.test(cwd) && !/\p{Cc}/u.test(cwd)) return { kind: 'cwd', cwd }
      return { kind: 'ignore' }
    }
  } else if (head === '4') {
    // A bare `OSC 9 ; 4` has no state.
    return { kind: 'ignore' }
  }

  const body = clampText(data)
  if (!body) return { kind: 'ignore' }
  return { kind: 'notify', notification: { title: null, body } }
}

interface ProgressHandlers {
  onChange: (progress: AppProgress | null) => void
  /** Progress that was up has ended, with its duration. Not fired by
   * `reset()`. */
  onComplete: (durationMs: number) => void
  /**
   * Watch for a full reset (`ESC c`), which abandons any report. Subscribed only
   * while a report is up, since watching makes the scanner check every 'c'; see
   * `GhosttyEngine.registerResetHandler`. Optional (tests, the bench).
   */
  watchReset?: (cb: () => void) => { dispose: () => void }
}

/**
 * Turns OSC 9;4 reports into what a pane shows and the moment a program
 * stopped: drops repeats, distinguishes "the work ended" from "the session
 * did", and times the whole run. A plain class, on the output hot path.
 */
export class ProgressTracker {
  private progress: AppProgress | null = null
  /** When the current run started (not its last change). */
  private since = 0
  private readonly handlers: ProgressHandlers
  /** Live only while `progress` is non-null; see `watchReset`. */
  private resetWatch: { dispose: () => void } | null = null

  constructor(handlers: ProgressHandlers) {
    this.handlers = handlers
  }

  set(next: AppProgress | null): void {
    const previous = this.progress
    // Drop repeats here: busy programs resend the same state constantly, on
    // the hot path.
    if (previous === next) return
    if (previous && next && previous.state === next.state && previous.percent === next.percent) {
      return
    }
    this.progress = next
    if (next && !previous) this.since = Date.now()
    this.syncResetWatch()
    this.handlers.onChange(next)
    if (previous && !next) this.handlers.onComplete(Date.now() - this.since)
  }

  /**
   * Drop any progress without reporting completion (disconnect or teardown,
   * where the program's fate is unknown). Still emits `onChange(null)`.
   */
  reset(): void {
    if (this.progress === null) return
    this.progress = null
    this.syncResetWatch()
    this.handlers.onChange(null)
  }

  /** Releases the reset watch, for teardown. */
  dispose(): void {
    this.resetWatch?.dispose()
    this.resetWatch = null
  }

  /**
   * Watch exactly while there's something for a reset to clear. Runs before
   * `onChange`, and is safe to call from the watch's own callback.
   */
  private syncResetWatch(): void {
    const want = this.progress !== null
    if (want === (this.resetWatch !== null)) return
    if (!want) {
      this.resetWatch?.dispose()
      this.resetWatch = null
      return
    }
    this.resetWatch = this.handlers.watchReset?.(() => this.reset()) ?? null
  }
}

/**
 * OSC 777's `notify;<title>;<body>`.
 *
 * @param data everything after `777;`.
 * @returns null for other OSC 777 subcommands.
 */
export function parseOsc777(data: string): RemoteNotification | null {
  const fields = data.split(';')
  if (fields[0] !== 'notify') return null
  const title = clampText(fields[1] ?? '')
  // Rejoined: there's no escaping, so the body may contain semicolons.
  const body = clampText(fields.slice(2).join(';'))
  if (!title && !body) return null
  // A title-only notification reads better as a body under the pane name.
  if (!body) return { title: null, body: title }
  return { title, body }
}
