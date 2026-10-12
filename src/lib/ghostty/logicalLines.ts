import type { RowText } from './rowText'

/**
 * Joining wrapped rows back into the line they belong to, so matches that
 * straddle a wrap are found. Shared by search (a regex over the buffer) and
 * URL detection (over the viewport), so there's one answer to "what is a
 * line".
 */

/** A run of one row covered by a match. A match that wraps produces several. */
export interface Segment {
  row: number
  from: number
  to: number
}

/**
 * One logical line: its rows' text concatenated, plus the absolute row and
 * column each character came from. Built during the join, so mapping many
 * matches stays linear. Needed because an offset isn't a column: a column can
 * hold a grapheme cluster or nothing (a wide character's spacer).
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
 * Groups `rows` into logical lines. `rows[i]` is absolute row
 * `firstRow + i`, and `wrapped[i]` says it continues the row above.
 *
 * `wrapped[0]` is ignored: the row above wasn't passed in. Callers that care
 * about a line running off their window's top (link hit-testing) widen the
 * window first.
 */
export function logicalLines(rows: RowText[], wrapped: boolean[], firstRow = 0): LogicalLine[] {
  const out: LogicalLine[] = []
  let i = 0
  while (i < rows.length) {
    // This row plus its continuations.
    let end = i + 1
    while (end < rows.length && wrapped[end]) end++

    let text = ''
    // Sized from the joined text once, rather than grown per character.
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
 * The rows and columns a `[start, end]` span (end inclusive) covers, one
 * segment per row. Empty for a span outside the line.
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
