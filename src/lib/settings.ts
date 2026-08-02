import type { VibrancyMode } from './windowEffects'

export type CursorStyleSetting = 'block' | 'bar' | 'underline'

/**
 * DECSCUSR values, which pair each shape with whether it blinks — there is no
 * way to set one without the other, which is why the two settings resolve to a
 * single sequence.
 */
const DECSCUSR: Record<CursorStyleSetting, { blink: number; steady: number }> = {
  block: { blink: 1, steady: 2 },
  underline: { blink: 3, steady: 4 },
  bar: { blink: 5, steady: 6 },
}

/** The sequence that puts a terminal into the configured cursor. */
export function cursorStyleSequence(style: CursorStyleSetting, blink: boolean): string {
  const pair = DECSCUSR[style] ?? DECSCUSR.block
  return `[${blink ? pair.blink : pair.steady} q`
}

export interface TerminalSettings {
  /** Selecting text immediately copies it to the clipboard. */
  copyOnSelect: boolean
  /** Right-click pastes clipboard contents instead of opening a menu. */
  rightClickPaste: boolean
  /** When a connection ends cleanly (the remote shell exits or the server
   * hangs up), automatically close the pane after a brief moment. Off leaves
   * the pane open showing Reconnect / connection-settings actions instead.
   * On by default — the long-standing behavior. */
  closeOnDisconnect: boolean
  /** Session logs strip terminal escape sequences (colors, cursor moves,
   * title sequences) so the file is readable text. Off logs the raw PTY
   * stream verbatim (PuTTY "all session output" style) for exact fidelity /
   * replay. Applies to the next log started, not one already running. */
  logPlainText: boolean
  /** Toast when a long-running command finishes in a tab you aren't looking
   * at, using the remote shell's own OSC 133 reports (see
   * lib/shellIntegration.ts). Never fires for the tab currently on screen in
   * a focused window — you watched it finish. Does nothing at all against a
   * shell with no integration set up, which is why it defaults on: it can't
   * become noise without deliberate setup on the far end. */
  notifyOnCommandComplete: boolean
  /** A bell (BEL) from the far end marks its pane until you focus it. Unlike
   * the above this needs no remote setup whatsoever — `sleep 60; echo -e
   * '\a'` works on anything.
   *
   * The key still says "tab" because it predates the marker moving from the
   * tab to the individual pane's segment of the tab strip's pane map;
   * renaming it would silently reset the preference for anyone who had
   * changed it, which isn't worth the tidier name. */
  bellMarksTab: boolean
  /** A bell also plays a short tone. Off by default and separate from the
   * marker above rather than folded into one three-way setting: they're
   * genuinely independent (a marker is passive, a sound interrupts), and
   * merging them would have meant retiring `bellMarksTab`'s storage key and
   * silently resetting anyone who had turned it off. */
  bellSound: boolean
  /** A program on the far end may ask for a desktop notification by name,
   * with OSC 9 or OSC 777, and have its text shown.
   *
   * Distinct from `notifyOnCommandComplete`, which is this app *inferring* a
   * notification from a command's exit: here the remote side is choosing both
   * the moment and the words. That is why it gets its own toggle despite
   * sounding like the same feature — the text is attacker-controlled if the
   * host is hostile (bounded and stripped of control characters in
   * lib/appProgress.ts, and always shown under the pane's own name so it can
   * never impersonate the app itself), and someone may reasonably want no
   * such channel at all.
   *
   * On by default regardless: it needs no shell setup, works through a
   * full-screen program where nothing else does, and only fires when a
   * program deliberately asks. */
  remoteNotifications: boolean
  /** Programs on the far end may put text on this machine's clipboard with
   * OSC 52. Reading it is never allowed regardless of this setting — that
   * half is refused in the parser, not gated here.
   *
   * On by default: it is the only copy path a remote full-screen program has
   * (it can't reach the local clipboard, and while it holds the mouse the
   * user can't drag out a selection either), and network-gear operators hit
   * legitimate uses of it. The risk it carries is clipboard poisoning — a
   * hostile host replacing what the user last copied so they paste an
   * attacker-chosen command into a *local* shell — which is why a write
   * always raises a toast even when allowed. Silence was the actual problem;
   * the toggle is for people who'd rather not have the capability at all. */
  clipboardWriteFromRemote: boolean
  /** Font stack passed to the terminal engine. Anything CSS accepts; the
   * default is the platform's UI monospace with Consolas behind it. Only
   * fixed-width fonts make sense — the engine measures one glyph and assumes
   * the rest match, so a proportional font renders with visibly wrong column
   * alignment. */
  fontFamily: string
  /** Terminal font size in px. */
  fontSize: number
  /**
   * Memory each pane may spend on scrollback, in MB — one of
   * `SCROLLBACK_FOOTPRINT_TIERS_MB`, and the pane's whole WASM footprint
   * rather than the scrollback budget alone.
   *
   * Memory rather than rows because memory is the quantity that is actually
   * enforced. The core's limit is a byte budget, so the *depth* a pane reaches
   * depends on how wide it is: the same budget that holds ~24,000 rows at 80
   * columns holds ~6,500 at 400. A row setting is therefore a promise whose
   * truth depends on how the user later drags the pane — offered and broken
   * twice here before this. Rows are shown instead, derived at the current
   * width, in Settings and the status bar.
   */
  scrollbackBudgetMB: number
  /**
   * Shape the cursor takes until the remote application says otherwise.
   *
   * Applied by writing DECSCUSR (`ESC[N q`) into the terminal, which is the
   * mechanism the core already expects — so an application that sets its own
   * shape correctly wins over this, the same way it does in any other terminal.
   * It is a default, not an override.
   */
  cursorStyle: CursorStyleSetting
  /** Whether that default cursor blinks. DECSCUSR encodes shape and blink in
   *  one value, so this is written as part of the same sequence. An
   *  application that sets DECSCUSR itself overrides both together. */
  cursorBlink: boolean
  /** Ask before closing a tab, pane or the window while something is still
   * connected. On by default: closing is instant and irreversible, and the
   * session it drops may have taken a vault unlock and a jump host to
   * establish. */
  confirmCloseWithConnection: boolean
  /**
   * Command used to open a remote file for editing, instead of handing it to
   * Windows. Empty (the default) keeps the OS handler.
   *
   * **It must block until the user is finished** — `code --wait`,
   * `subl --wait`, `gvim -f`. That is the entire reason the setting exists: the
   * OS opener returns the moment it has dispatched the file, usually to an
   * editor that was already running, so nothing can tell when the user is done
   * and the "watching" marker has to be dismissed by hand. A command that
   * blocks turns that into a real signal, and the watch ends itself.
   *
   * `{file}` marks where the path goes; without it the path is appended.
   * Backslashes are literal (they are path separators here), and double quotes
   * group — so a program path with spaces needs quoting and nothing else does.
   *
   * A command that returns immediately is detected and the watch is kept, since
   * the alternative is deleting the temp file out from under an editor the user
   * is still typing in.
   */
  externalEditor: string
  /** Name of the active preset in lib/theme.ts. */
  themeName: string
  /** Offers to reopen whatever tabs/panes were connected when the app was
   * last closed. Off by default — it's a real behavior change (reconnecting
   * live sessions on launch) with a security angle (may need to unlock the
   * vault to do it), so it's opt-in rather than assumed. */
  restoreSessionsOnLaunch: boolean
  /** 1 = fully opaque (default). Below 1, the app background/terminal both
   * get an alpha-blended background. With `vibrancyMode` off this is plain
   * unblurred glass (the window was already OS-transparent for the rounded
   * corners); with acrylic/mica it's layered under that OS effect instead,
   * so the two read as one consistent translucent window. */
  backgroundOpacity: number
  /** 'off' skips the native call entirely. 'acrylic' is live blur-behind
   * (the classic Windows Terminal look) but has a documented Microsoft
   * resize/drag perf bug on Win10 1903+/Win11 22000+. 'mica' and 'tabbed'
   * have no such bug but also no live blur — just a one-time
   * wallpaper-color tint; 'tabbed' is the same tint tuned for windows with
   * a tab strip (this one's), giving it a subtly different tone. */
  vibrancyMode: VibrancyMode
}

const STORAGE_KEY = 'wrustty.terminal-settings'
// Pre-rebrand key (was wr-shell) — read as a fallback so existing settings
// aren't silently dropped by the rename; loadSettings never writes back to
// it, so it's naturally retired once saveSettings runs once under the new
// key.
const PREVIOUS_STORAGE_KEY = 'wr-shell.terminal-settings'

const defaults: TerminalSettings = {
  copyOnSelect: true,
  rightClickPaste: true,
  closeOnDisconnect: true,
  logPlainText: true,
  notifyOnCommandComplete: true,
  bellMarksTab: true,
  bellSound: false,
  remoteNotifications: true,
  clipboardWriteFromRemote: true,
  fontFamily: 'ui-monospace, Consolas, monospace',
  fontSize: 14,
  // 16 MB, not the smallest tier: it estimates ~10,100 rows at 80 columns,
  // which is what the previous default (10,000 rows) meant to deliver. A new
  // install should not quietly get less history than the last version aimed at.
  scrollbackBudgetMB: 16,
  cursorStyle: 'block',
  cursorBlink: true,
  confirmCloseWithConnection: true,
  // Empty on purpose: the OS handler opens the user's *own* editor with no
  // setup at all, and that is the better default even though it can report
  // nothing back. This is the trade to opt into, not out of.
  externalEditor: '',
  themeName: 'wRusTTY Dark',
  restoreSessionsOnLaunch: false,
  backgroundOpacity: 1,
  vibrancyMode: 'off',
}

/**
 * Per-pane scrollback memory tiers offered in Settings, ascending, in MB of
 * total pane footprint.
 *
 * Lives here rather than beside the byte budgets in `GhosttyEngine` only to
 * keep the dependency one-way — the engine already imports this module, so the
 * reverse would be a cycle. `scrollbackBudgetBytesFor` there maps each of these
 * to a measured budget and must be kept in step; `scrollbackTiers.test.ts`
 * asserts the two agree rather than trusting that they do.
 */
export const SCROLLBACK_FOOTPRINT_TIERS_MB = [8, 16, 32, 64]

/**
 * Approximate rows each tier holds at 80 columns, used only to translate a
 * stored row-count setting into a tier. Measured, not derived — see
 * `SCROLLBACK_BUDGET_BY_FOOTPRINT_MB` in GhosttyEngine.
 */
const TIER_ROWS_AT_80_COLS: ReadonlyArray<readonly [tierMB: number, rows: number]> = [
  [8, 3788],
  [16, 10100],
  [32, 24617],
  [64, 49230],
]

/**
 * Migrates the pre-tier `scrollback` row count onto a memory tier.
 *
 * The field had to be *renamed* rather than reinterpreted. `loadSettings` does
 * `{ ...defaults, ...parsed }`, so a stored `scrollback: 10000` left under the
 * same name would have been read as 10,000 MB — clamped harmlessly, but every
 * existing user would have silently landed on the largest tier and roughly ten
 * times the memory they had agreed to.
 *
 * Rounds *up* to the first tier that covers what the user had, so nobody loses
 * history they were already relying on; a value past the largest tier (the old
 * menu went to 100,000) lands there rather than being refused.
 */
export function scrollbackTierForRows(rows: number): number {
  if (!Number.isFinite(rows)) return defaults.scrollbackBudgetMB
  for (const [tierMB, tierRows] of TIER_ROWS_AT_80_COLS) {
    if (rows <= tierRows) return tierMB
  }
  return TIER_ROWS_AT_80_COLS[TIER_ROWS_AT_80_COLS.length - 1][0]
}

export function loadSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(PREVIOUS_STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw)
    const merged = { ...defaults, ...parsed }
    // A settings blob written before tiers existed carries `scrollback` (rows)
    // and no `scrollbackBudgetMB`. Convert once; the stale key then rides along
    // harmlessly until the next save drops it.
    if (parsed.scrollbackBudgetMB === undefined && parsed.scrollback !== undefined) {
      merged.scrollbackBudgetMB = scrollbackTierForRows(Number(parsed.scrollback))
    }
    // Anything that isn't a tier — corrupt, hand-edited, or retired by a later
    // version — falls back to the default rather than reaching the engine,
    // which would silently substitute its own smallest tier instead.
    if (!SCROLLBACK_FOOTPRINT_TIERS_MB.includes(merged.scrollbackBudgetMB)) {
      merged.scrollbackBudgetMB = defaults.scrollbackBudgetMB
    }
    delete merged.scrollback
    return merged
  } catch {
    return defaults
  }
}

export function saveSettings(settings: TerminalSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Best-effort; a settings-persistence failure shouldn't break the app.
  }
}
