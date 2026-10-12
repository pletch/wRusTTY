/**
 * What the far end says about itself: its window title and working directory.
 *
 *   OSC 0 ; <text> ST    icon name and window title
 *   OSC 1 ; <text> ST    icon name alone
 *   OSC 2 ; <text> ST    window title alone
 *   OSC 7 ; <file-url>   working directory
 *
 * Alongside lib/shellIntegration.ts and lib/appProgress.ts. These need no
 * shell integration and survive full-screen programs.
 *
 * Neither renames a tab: the label is the user's, and many shells rewrite the
 * title on every prompt. Both show beside the connection's own identifiers
 * (see App.tsx). Pure parsing, so the grammar tests on its own.
 */

/** Bounds for chrome outside the grid. Paths get more room, since a truncated
 * path is less useful than a truncated sentence. */
const MAX_TITLE = 200
const MAX_PATH = 400

/**
 * Strips control and format characters (`\p{Cc}\p{Cf}`, as in
 * lib/appProgress.ts, including bidi overrides like RLO), then bounds the
 * result.
 */
function clampText(raw: string, max: number): string {
  const clean = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/**
 * OSC 0 and OSC 2 (OSC 1's icon name has no counterpart here).
 *
 * @param data everything after `0;`/`2;`
 * @returns the title, or null when cleared (an empty payload restores the
 *   default) or unusable
 */
export function parseWindowTitle(data: string): string | null {
  return clampText(data, MAX_TITLE) || null
}

/**
 * OSC 7: `file://<host>/<percent-encoded path>`. The host is dropped: the
 * path is only displayed, and the pane already says what it's connected to.
 *
 * @param data everything after `7;`
 * @returns the decoded path, or null if this wasn't one
 */
export function parseCwd(data: string): string | null {
  const raw = data.trim()
  if (!raw) return null

  let path: string
  if (raw.startsWith('file://')) {
    // The slash ending the authority. "file://host" reports no directory.
    const slash = raw.indexOf('/', 'file://'.length)
    if (slash === -1) return null
    path = raw.slice(slash)
  } else if (raw.startsWith('/') || raw.startsWith('~')) {
    // Out of spec, but several shells emit a bare path.
    path = raw
  } else {
    // A relative path, another scheme or a stray title isn't a directory.
    return null
  }

  try {
    path = decodeURIComponent(path)
  } catch {
    // Malformed escapes: the raw form is still the host's answer.
  }

  // A Windows path arrives as `/C:/Users/...`; drop the URL's leading slash.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)

  return clampText(path, MAX_PATH) || null
}

/**
 * The working directory from a shell integration sequence rather than OSC 7:
 *
 *   OSC 633 ; P ; Cwd=<path>      VS Code's shell integration
 *   OSC 133 ; P ; Cwd=<path>      the same property syntax, seen in the wild
 *   OSC 1337 ; CurrentDir=<path>  iTerm2's
 *
 * OSC 7 comes from GNOME's `vte.sh`, fish and zsh hooks, but plain bash on
 * Debian or RHEL usually sets only the title.
 *
 * @param data everything after the OSC number and its `;`
 * @returns the decoded path, or null if this wasn't a directory report
 */
export function parseCwdProperty(data: string): string | null {
  const raw = data.trim()
  // `P;Cwd=/home/dev`: the `P;` is part of the payload.
  const property = /^P;(?:.*;)?Cwd=(.*)$/.exec(raw) ?? /^CurrentDir=(.*)$/.exec(raw)
  if (!property) return null
  const path = property[1].trim()
  if (!path.startsWith('/') && !path.startsWith('~') && !/^[A-Za-z]:/.test(path)) return null
  return clampText(path, MAX_PATH) || null
}

/**
 * A directory guessed from a window title, as a suggestion only. Stock bash
 * on Debian and RHEL titles `\u@\h: \w`. A title is arbitrary text, so it's
 * never treated as an answer. Only unambiguous shapes are offered: a leading
 * `/` or `~/`, optionally after `user@host: `.
 */
export function guessCwdFromTitle(title: string | null): string | null {
  if (!title) return null
  const afterPrefix = /^[^\s:]+:\s*(.+)$/.exec(title.trim())
  const candidate = (afterPrefix ? afterPrefix[1] : title).trim()
  if (!/^(\/|~\/|~$)/.test(candidate)) return null
  // `~/src — vim` is a path plus commentary; take the path.
  const path = candidate.split(/\s+[—–-]\s+|\s{2,}/)[0].trim()
  return clampText(path, MAX_PATH) || null
}
