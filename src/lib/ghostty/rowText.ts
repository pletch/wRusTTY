/**
 * How a buffer row travels from `GhosttyEngine.readRows` to copy, word
 * selection and search. Its own module so neither the engine nor the search
 * controller imports the other for one interface.
 */

/**
 * One buffer row: its columns' text concatenated, plus where each column
 * begins. `colStart` has `cols + 1` entries, so column `c` is always
 * `text.slice(colStart[c], colStart[c + 1])`. A span can be several
 * characters (a grapheme cluster) or empty (a wide character's trailing half).
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
 * What counts as one word: wider than alphanumerics, so a path, flag,
 * hostname or URL is one double-click. Shared by double-click and mark
 * mode's word movement so they agree; module-scoped since it runs per column.
 */
const WORD_RE = /[A-Za-z0-9_\-./:@~+=%?&#]/

export function isWordChar(s: string): boolean {
  if (s.length === 0) return false
  const c = s.codePointAt(0)!
  if (c > 127) return true // CJK, accented letters, and the like
  return WORD_RE.test(s[0])
}
