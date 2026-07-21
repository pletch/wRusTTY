import type { VibrancyMode } from './windowEffects'

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
