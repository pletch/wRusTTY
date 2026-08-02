import type { RowText } from './rowText'

/**
 * Joining wrapped rows back into the line they belong to.
 *
 * A wrapped line is several rows on screen but one line of text, and anything
 * matching row by row misses whatever straddles the wrap. Search has needed
 * that since the vendored shim started answering `is_row_wrapped` for
 * scrollback; URL detection needs exactly the same thing, over the same rows,
 * with the same offset-to-column mapping on the way back out.
 *
 * It lives here rather than in `SearchController` so there is one answer to
 * "what is a line" instead of two that drift. The two callers differ only in
 * what they match — a user's regex over the whole buffer, a URL pattern over
 * the viewport — which is the part that should differ.
 */

/** A run of one row covered by a match. A match that wraps produces several. */
export interface Segment {
  row: number
  from: number
  to: number
}

/**
 * One logical line: the text of every row it covers, concatenated, plus the
 * absolute row and column each character came from.
 *
 * The maps are built during the join because the join is already walking every
 * column; recomputing them per match would make a line with many matches
 * quadratic in its own length. They are the reason a caller can hand back a
 * character offset and get a screen position — a column can hold more than one
 * character (a grapheme cluster) or none (a wide character's trailing spacer),
 * so an offset is not a column.
 */
export interface LogicalLine {
  text: string
  /** Absolute row the line starts on. */
  startRow: number
  /** How many rows it covers, its own included. */
  rowCount: number
  /** Absolute row each character of `text` came from. */
  rowAt: Int32Array
  /** Column within that row. */
  colAt: Int32Array
}

/**
 * Groups `rows` into logical lines.
 *
 * `rows[i]` is the absolute row `firstRow + i`, and `wrapped[i]` says that row
 * continues the one above it. Search reads from row 0 and passes `firstRow`
 * 0; anything reading a window of the buffer passes the window's top, so the
 * rows a caller gets back are absolute either way.
 *
 * A `wrapped[0]` of true is deliberately not honoured — the row above is
 * outside what was handed in, so the line has to start here. Callers that care
 * about a line running off the top of their window (link hit-testing does)
 * widen the window before calling rather than asking this to read rows it was
 * not given.
 */
export function logicalLines(rows: RowText[], wrapped: boolean[], firstRow = 0): LogicalLine[] {
  const out: LogicalLine[] = []
  let i = 0
  while (i < rows.length) {
    // This row plus every continuation of it.
    let end = i + 1
    while (end < rows.length && wrapped[end]) end++

    let text = ''
    // Sized from the joined text once it exists rather than grown per
    // character: a row is `cols` columns and a cluster is a handful of
    // codepoints, so the two passes cost less than repeated array growth.
    const parts: { row: number; colStart: Int32Array; base: number }[] = []
    for (let r = i; r < end; r++) {
      const row = rows[r]
      parts.push({ row: firstRow + r, colStart: row.colStart, base: text.length })
      text += row.text
    }

    const rowAt = new Int32Array(text.length)
    const colAt = new Int32Array(text.length)
    for (const part of parts) {
      const cs = part.colStart
      for (let c = 0; c + 1 < cs.length; c++) {
        for (let k = cs[c]; k < cs[c + 1]; k++) {
          rowAt[part.base + k] = part.row
          colAt[part.base + k] = c
        }
      }
    }

    out.push({ text, startRow: firstRow + i, rowCount: end - i, rowAt, colAt })
    i = end
  }
  return out
}

/**
 * The rows and columns a `[start, end]` span of a line's text covers, `end`
 * inclusive.
 *
 * One segment per row, because the rows are apart on screen: a match across a
 * wrap is a single hit that has to be painted twice. Returns nothing for a
 * span that falls outside the line, which is what a match ending past the last
 * mapped character would be.
 */
export function segmentsFor(line: LogicalLine, start: number, end: number): Segment[] {
  const last = line.rowAt.length - 1
  if (last < 0 || start < 0 || start > last) return []
  const to = Math.min(end, last)
  if (to < start) return []

  const segments: Segment[] = []
  let k = start
  while (k <= to) {
    const row = line.rowAt[k]
    let j = k
    while (j + 1 <= to && line.rowAt[j + 1] === row) j++
    segments.push({ row, from: line.colAt[k], to: line.colAt[j] })
    k = j + 1
  }
  return segments
}
