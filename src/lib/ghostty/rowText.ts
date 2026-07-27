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
