/**
 * What the far end says about *itself* — its window title and its working
 * directory.
 *
 *   OSC 0 ; <text> ST    icon name and window title
 *   OSC 1 ; <text> ST    icon name alone
 *   OSC 2 ; <text> ST    window title alone
 *   OSC 7 ; <file-url>   working directory
 *
 * The third member of the family that already includes lib/shellIntegration.ts
 * (what the shell is doing) and lib/appProgress.ts (what a program is doing).
 * Like OSC 9, these need no shell integration and survive a full-screen
 * program, because they are written straight to stdout by whatever is running
 * — a shell's prompt, ssh, vim, a container runtime.
 *
 * Neither of these renames a tab. The tab's label is the connection's, chosen
 * by the user, and a great many shells rewrite their title on *every prompt*;
 * letting that drive the strip would mean tab names that churn as you work and
 * a remote host deciding what the window says it is connected to. Both surface
 * beside the connection's own identifiers instead — see App.tsx.
 *
 * Pure parsing, no state and no DOM, so the grammar can be tested on its own.
 */

/** Titles and paths land in the status bar and a tooltip, which are chrome
 * outside the terminal grid. A host that wants to fill the grid with anything
 * it likes already can; it does not also get to stretch the window's own
 * furniture. Paths get more room than titles because deep trees are ordinary
 * and a truncated path is much less useful than a truncated sentence. */
const MAX_TITLE = 200
const MAX_PATH = 400

/**
 * Control and format characters go, then the result is bounded.
 *
 * `\p{Cc}\p{Cf}` matches lib/appProgress.ts, deliberately: these strings reach
 * the same kind of destination. It covers the bidirectional-override
 * characters as well as the C0 range, which matters more here than it looks —
 * RLO in a title is the classic trick for making one string read as another.
 */
function clampText(raw: string, max: number): string {
  const clean = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/**
 * OSC 0 and OSC 2. OSC 1 sets the icon name alone, which has no counterpart in
 * this UI and is not routed here.
 *
 * @param data everything after `0;`/`2;` — what `registerOscHandler` hands over
 * @returns the title, or null when the host cleared it (an empty payload, which
 *   is how a shell restores the default) or sent nothing usable
 */
export function parseWindowTitle(data: string): string | null {
  return clampText(data, MAX_TITLE) || null
}

/**
 * OSC 7 — `file://<host>/<percent-encoded path>`.
 *
 * The host component is parsed and dropped. It says which machine the path is
 * on, which matters to a terminal that might open a local file manager at it;
 * here the path is only ever displayed, and the pane already says what it is
 * connected to. Keeping it would also mean showing a *second*, host-supplied
 * answer to "what am I connected to" next to the real one.
 *
 * @param data everything after `7;`
 * @returns the decoded path, or null if this wasn't one
 */
export function parseCwd(data: string): string | null {
  const raw = data.trim()
  if (!raw) return null

  let path: string
  if (raw.startsWith('file://')) {
    // The slash that ends the authority component. A URL with no path at all
    // ("file://host") reports no directory rather than the root.
    const slash = raw.indexOf('/', 'file://'.length)
    if (slash === -1) return null
    path = raw.slice(slash)
  } else if (raw.startsWith('/') || raw.startsWith('~')) {
    // Out of spec, but several shells emit a bare path and it is unambiguous.
    path = raw
  } else {
    // Anything else — a relative path, another scheme, a stray title — is not
    // something to display as a directory.
    return null
  }

  try {
    path = decodeURIComponent(path)
  } catch {
    // Malformed percent-escapes. The raw form is still readable and still the
    // host's answer, so it beats reporting nothing.
  }

  // A Windows path arrives as `/C:/Users/...`; that leading slash belongs to
  // the URL grammar, not to the path.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)

  return clampText(path, MAX_PATH) || null
}

/**
 * The working directory as reported by a *shell integration* sequence rather
 * than by OSC 7.
 *
 *   OSC 633 ; P ; Cwd=<path>      VS Code's shell integration
 *   OSC 133 ; P ; Cwd=<path>      the same property syntax, seen in the wild
 *   OSC 1337 ; CurrentDir=<path>  iTerm2's
 *
 * These exist because OSC 7 is far from universal: it is emitted by GNOME's
 * `vte.sh`, by fish and by zsh's own hooks, but a plain bash on a Debian or
 * RHEL host typically sets only the *window title* — where the directory is
 * plainly visible to a human and completely unavailable to a program that
 * wants a path. A terminal that reads only OSC 7 therefore reports "no
 * directory" on a session that is quite clearly showing one, which is exactly
 * as unhelpful as it sounds.
 *
 * @param data everything after the OSC number and its `;`
 * @returns the decoded path, or null if this payload was not a directory report
 */
export function parseCwdProperty(data: string): string | null {
  const raw = data.trim()
  // `P;Cwd=/home/tim` — the property form, with the leading `P;` already part
  // of the payload the handler is given.
  const property = /^P;(?:.*;)?Cwd=(.*)$/.exec(raw) ?? /^CurrentDir=(.*)$/.exec(raw)
  if (!property) return null
  const path = property[1].trim()
  if (!path.startsWith('/') && !path.startsWith('~') && !/^[A-Za-z]:/.test(path)) return null
  return clampText(path, MAX_PATH) || null
}

/**
 * A directory *guessed* from a window title, for use as a suggestion and
 * never as an answer.
 *
 * Bash's stock prompt on Debian and RHEL sets the title to `\u@\h: \w`, so the
 * path is right there in the status bar while nothing has actually reported
 * one. Offering it as a prefilled suggestion turns "type the whole path" into
 * "press Enter", which is worth having — but it stays a suggestion, because a
 * title is arbitrary text a program chose and a file sent somewhere nobody
 * chose is the failure this whole path exists to avoid.
 *
 * Only shapes that cannot be anything else are offered: a leading `/` or `~/`,
 * optionally after a `user@host: ` prefix. A bare word is not a path.
 */
export function guessCwdFromTitle(title: string | null): string | null {
  if (!title) return null
  const afterPrefix = /^[^\s:]+:\s*(.+)$/.exec(title.trim())
  const candidate = (afterPrefix ? afterPrefix[1] : title).trim()
  if (!/^(\/|~\/|~$)/.test(candidate)) return null
  // A title of `~/src — vim` is a path plus commentary; take the path.
  const path = candidate.split(/\s+[—–-]\s+|\s{2,}/)[0].trim()
  return clampText(path, MAX_PATH) || null
}
