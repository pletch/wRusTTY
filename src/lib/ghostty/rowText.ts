/**
 * How a buffer row travels between `GhosttyEngine.readRows` and the things
 * that read it — copy, word selection, search.
 *
 * Its own module because the search controller needs the type and the engine
 * produces it; putting it in either would make the other import from a
 * 2,000-line file (or from its own consumer) for one interface.
 */

/**
 * One buffer row: the text of every column concatenated, plus where each
 * column begins in it.
 *
 * `colStart` has `cols + 1` entries, so column `c` is always
 * `text.slice(colStart[c], colStart[c + 1])` with no special case for the last
 * column. A span can be longer than one character (a grapheme cluster) or
 * empty (the trailing half of a wide character) — which is exactly the
 * information a plain `string` per row would throw away, and which a
 * `string[]` per cell paid ~2M allocations on a full-scrollback search to
 * keep.
 */
export interface RowText {
  text: string
  colStart: Int32Array
}

/** What column `c` shows. Empty for a wide character's trailing spacer. */
export function columnText(row: RowText, c: number): string {
  if (c < 0 || c + 1 >= row.colStart.length) return ''
  return row.text.slice(row.colStart[c], row.colStart[c + 1])
}

/**
 * What counts as one word. Deliberately wider than alphanumerics: the things
 * worth grabbing out of a terminal in one gesture are paths, flags, hostnames
 * and URLs, and stopping at every `/` or `.` turns picking up a path into
 * several gestures.
 *
 * Hoisted to module scope so the literal isn't recompiled per call — V8 handles
 * the inline form well, but a word scan calls this once per column and a
 * module-level constant is free.
 *
 * Lives here rather than in either caller because both the mouse's double-click
 * and mark mode's word-wise movement have to agree on where a word ends; two
 * copies of this regex would be two slightly different answers within a week.
 */
const WORD_RE = /[A-Za-z0-9_\-./:@~+=%?&#]/

export function isWordChar(s: string): boolean {
  if (s.length === 0) return false
  const c = s.codePointAt(0)!
  if (c > 127) return true // CJK, accented letters, and the like
  return WORD_RE.test(s[0])
}
