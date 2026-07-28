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
  /** Rows of scrollback the engine retains per pane. Counted in *wrapped* rows,
   * not logical lines, so verbose output with long lines fills it faster
   * than the number suggests. Memory scales with this times the number of
   * open panes, which is why it isn't simply set very high. */
  scrollback: number
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
  clipboardWriteFromRemote: true,
  fontFamily: 'ui-monospace, Consolas, monospace',
  fontSize: 14,
  scrollback: 10000,
  cursorStyle: 'block',
  cursorBlink: true,
  confirmCloseWithConnection: true,
  themeName: 'wRusTTY Dark',
  restoreSessionsOnLaunch: false,
  backgroundOpacity: 1,
  vibrancyMode: 'off',
}

export function loadSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(PREVIOUS_STORAGE_KEY)
    if (!raw) return defaults
    return { ...defaults, ...JSON.parse(raw) }
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
