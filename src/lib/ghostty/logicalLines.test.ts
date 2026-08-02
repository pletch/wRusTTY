import { describe, it, expect } from 'vitest'
import { logicalLines, segmentsFor } from './logicalLines'
import type { RowText } from './rowText'

/**
 * The join that search and link detection share.
 *
 * The cases worth pinning are the ones where a character offset and a column
 * are not the same number — a grapheme cluster is several characters in one
 * column, a wide character's spacer is a column with no characters at all —
 * because mapping an offset back to a screen position is the whole job of this
 * module, and both callers depend on it being right at a wrap boundary.
 */

/** A row of single-character columns, the ordinary case. */
function row(text: string): RowText {
  const colStart = new Int32Array(text.length + 1)
  for (let i = 0; i <= text.length; i++) colStart[i] = i
  return { text, colStart }
}

/** A row built from explicit per-column strings, so a column can hold two
 *  characters (a cluster) or none (a wide character's trailing spacer). */
function cells(columns: string[]): RowText {
  const colStart = new Int32Array(columns.length + 1)
  let text = ''
  for (let c = 0; c < columns.length; c++) {
    colStart[c] = text.length
    text += columns[c]
  }
  colStart[columns.length] = text.length
  return { text, colStart }
}

describe('logicalLines', () => {
  it('keeps unwrapped rows as separate lines', () => {
    const lines = logicalLines([row('one'), row('two')], [false, false])
    expect(lines.map((l) => l.text)).toEqual(['one', 'two'])
    expect(lines.map((l) => l.startRow)).toEqual([0, 1])
    expect(lines.map((l) => l.rowCount)).toEqual([1, 1])
  })

  it('joins a run of continuation rows into one line', () => {
    const lines = logicalLines([row('abc'), row('def'), row('ghi'), row('zzz')], [false, true, true, false])
    expect(lines.map((l) => l.text)).toEqual(['abcdefghi', 'zzz'])
    expect(lines[0]).toMatchObject({ startRow: 0, rowCount: 3 })
    expect(lines[1]).toMatchObject({ startRow: 3, rowCount: 1 })
  })

  it('numbers rows from firstRow, so a window of the buffer stays absolute', () => {
    const lines = logicalLines([row('abc'), row('def')], [false, true], 100)
    expect(lines[0].startRow).toBe(100)
    expect(Array.from(lines[0].rowAt)).toEqual([100, 100, 100, 101, 101, 101])
  })

  /** The row above was not handed in, so the line has to begin here — a caller
   *  that cares widens its window instead. */
  it('starts a line at the first row even when that row is a continuation', () => {
    const lines = logicalLines([row('abc'), row('def')], [true, true], 5)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ text: 'abcdef', startRow: 5, rowCount: 2 })
  })

  it('maps every character to the column it came from', () => {
    // Column 1 holds a combining sequence (two characters), column 2 is a wide
    // character's head and column 3 its empty spacer.
    const line = logicalLines([cells(['a', 'é', '好', '', 'b'])], [false])[0]
    expect(line.text).toBe('aé好b')
    expect(Array.from(line.colAt)).toEqual([0, 1, 1, 2, 4])
  })
})

describe('segmentsFor', () => {
  it('gives one segment for a span inside a single row', () => {
    const line = logicalLines([row('the needle here')], [false])[0]
    expect(segmentsFor(line, 4, 9)).toEqual([{ row: 0, from: 4, to: 9 }])
  })

  it('gives one segment per row for a span across a wrap', () => {
    const line = logicalLines([row('abcde'), row('fghij')], [false, true])[0]
    expect(segmentsFor(line, 3, 6)).toEqual([
      { row: 0, from: 3, to: 4 },
      { row: 1, from: 0, to: 1 },
    ])
  })

  it('covers three rows when the span crosses two wraps', () => {
    const line = logicalLines([row('ab'), row('cd'), row('ef')], [false, true, true])[0]
    expect(segmentsFor(line, 1, 4)).toEqual([
      { row: 0, from: 1, to: 1 },
      { row: 1, from: 0, to: 1 },
      { row: 2, from: 0, to: 0 },
    ])
  })

  it('reports columns, not offsets, across a multi-character column', () => {
    const line = logicalLines([cells(['a', 'é', 'b'])], [false])[0]
    // Offsets 1..3 are the cluster and the `b` after it: columns 1..2.
    expect(segmentsFor(line, 1, 3)).toEqual([{ row: 0, from: 1, to: 2 }])
  })

  it('clamps a span running past the end and rejects one that starts past it', () => {
    const line = logicalLines([row('abc')], [false])[0]
    expect(segmentsFor(line, 1, 99)).toEqual([{ row: 0, from: 1, to: 2 }])
    expect(segmentsFor(line, 5, 9)).toEqual([])
    expect(segmentsFor(line, 2, 1)).toEqual([])
  })
})
