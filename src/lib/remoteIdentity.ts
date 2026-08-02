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
