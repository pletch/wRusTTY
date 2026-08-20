import { describe, it, expect } from 'vitest'
import { computeRuns, LIGATURE_CHARS, type RunScratch } from './ligatureRuns'
import { emptyCell, CELL_BYTES, CELL_BOLD, CELL_UNDERLINE } from './wasmBindings'

interface CellSpec {
  ch?: string
  fg?: [number, number, number]
  bg?: [number, number, number]
  flags?: number
  attrs2?: number
  width?: number
  graphemeLen?: number
}

/** A row of cells in the core's wire layout, so `computeRuns` reads the same
 *  bytes here as it does off WASM memory. */
function row(cells: CellSpec[]): DataView {
  const view = new DataView(new ArrayBuffer(cells.length * CELL_BYTES))
  cells.forEach((c, i) => {
    const o = i * CELL_BYTES
    view.setUint32(o, (c.ch ?? ' ').codePointAt(0)!, true)
    const [fr, fg, fb] = c.fg ?? [200, 200, 200]
    const [br, bg, bb] = c.bg ?? [0, 0, 0]
    view.setUint8(o + 4, fr)
    view.setUint8(o + 5, fg)
    view.setUint8(o + 6, fb)
    view.setUint8(o + 7, br)
    view.setUint8(o + 8, bg)
    view.setUint8(o + 9, bb)
    view.setUint8(o + 10, c.flags ?? 0)
    view.setUint8(o + 11, c.width ?? 1)
    view.setUint8(o + 14, c.graphemeLen ?? 0)
    view.setUint8(o + 15, c.attrs2 ?? 0)
  })
  return view
}

function scratch(cols: number): RunScratch {
  return {
    head: new Int32Array(cols),
    span: new Int32Array(cols),
    cp: new Int32Array(cols),
    brk: new Uint8Array(cols),
    linkState: new Uint8Array(cols),
    cell: emptyCell(),
  }
}

/** The runs found, as `[startColumn, text]` pairs — which is what the renderer
 *  goes on to hand the atlas. */
function runsOf(cells: CellSpec[], prepare?: (s: RunScratch) => void): [number, string][] {
  const s = scratch(cells.length)
  prepare?.(s)
  computeRuns(row(cells), 0, cells.length, cells.length, s)
  const found: [number, string][] = []
  for (let c = 0; c < cells.length; c++) {
    if (s.head[c] !== c) continue
    let text = ''
    for (let i = 0; i < s.span[c]; i++) text += String.fromCharCode(s.cp[c + i])
    found.push([c, text])
  }
  return found
}

function chars(text: string): CellSpec[] {
  return [...text].map((ch) => ({ ch }))
}

describe('the run alphabet', () => {
  it('covers the operators and punctuation ligature fonts substitute on', () => {
    for (const ch of '=<>-!&|:+*/~.?#$%^;_@') expect(LIGATURE_CHARS[ch.charCodeAt(0)]).toBe(1)
    expect(LIGATURE_CHARS['\\'.charCodeAt(0)]).toBe(1)
  })

  it('takes w, and no other letter, because www is the one word ligature', () => {
    expect(LIGATURE_CHARS['w'.charCodeAt(0)]).toBe(1)
    for (const ch of 'abcdefghijklmnopqrstuvxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(LIGATURE_CHARS[ch.charCodeAt(0)]).toBe(0)
    }
  })

  it('leaves out the brackets, the quotes, the digits and the space', () => {
    // Brackets would cost a slot for every `))` and `}}` in a file, which is
    // the most common adjacency in code and the least rewarding.
    for (const ch of '0 (){}[]"\'`,') expect(LIGATURE_CHARS[ch.charCodeAt(0)]).toBe(0)
  })
})

describe('finding runs', () => {
  it('groups adjacent operators and leaves ordinary text alone', () => {
    expect(runsOf(chars('a => b'))).toEqual([[2, '=>']])
  })

  it('finds every run in a row, not just the first', () => {
    expect(runsOf(chars('a => b != c'))).toEqual([
      [2, '=>'],
      [7, '!='],
    ])
  })

  it('does not make a run of a lone operator — there is nothing to shape', () => {
    expect(runsOf(chars('a = b'))).toEqual([])
  })

  it('takes the four- and five-cell arrows whole, which is what the cap is for', () => {
    expect(runsOf(chars('<==>'))).toEqual([[0, '<==>']])
    expect(runsOf(chars('<--->'))).toEqual([[0, '<--->']])
  })

  it('caps a run at five cells, and the sixth is a lone operator again', () => {
    expect(runsOf(chars('======'))).toEqual([[0, '=====']])
  })

  it('picks the next run up where the cap left off', () => {
    expect(runsOf(chars('========'))).toEqual([
      [0, '====='],
      [5, '==='],
    ])
  })

  it('takes three when three are there', () => {
    expect(runsOf(chars('a === b'))).toEqual([[2, '===']])
  })

  it('runs to the end of the row without reading past it', () => {
    expect(runsOf(chars('x =>'))).toEqual([[2, '=>']])
  })
})

describe('what breaks a run', () => {
  it('a change of foreground colour', () => {
    expect(
      runsOf([{ ch: '=' }, { ch: '>', fg: [255, 0, 0] }]),
    ).toEqual([])
  })

  it('a change of background colour', () => {
    expect(runsOf([{ ch: '=' }, { ch: '>', bg: [255, 0, 0] }])).toEqual([])
  })

  it('a change of weight', () => {
    expect(runsOf([{ ch: '=' }, { ch: '>', flags: CELL_BOLD }])).toEqual([])
  })

  it('a change of underline style, which is baked into the raster', () => {
    expect(
      runsOf([
        { ch: '=', flags: CELL_UNDERLINE, attrs2: 1 },
        { ch: '>', flags: CELL_UNDERLINE, attrs2: 2 },
      ]),
    ).toEqual([])
  })

  it('the same style throughout does not break it', () => {
    expect(
      runsOf([
        { ch: '=', flags: CELL_BOLD, fg: [1, 2, 3] },
        { ch: '>', flags: CELL_BOLD, fg: [1, 2, 3] },
      ]),
    ).toEqual([[0, '=>']])
  })

  it('a wide character or a grapheme cluster, which own their own slot', () => {
    expect(runsOf([{ ch: '=' }, { ch: '>', width: 2 }])).toEqual([])
    expect(runsOf([{ ch: '=' }, { ch: '>', graphemeLen: 2 }])).toEqual([])
  })

  it('a marked cell — the cursor sits on the plain character, not on a slice', () => {
    expect(runsOf(chars('a => b'), (s) => (s.brk[3] = 1))).toEqual([])
    // The cursor one column further on leaves the run intact.
    expect(runsOf(chars('a => b'), (s) => (s.brk[4] = 1))).toEqual([[2, '=>']])
  })

  it('a change of link state, which the renderer underlines from outside the cell', () => {
    expect(runsOf(chars('=>'), (s) => (s.linkState[1] = 2))).toEqual([])
    expect(
      runsOf(chars('=>'), (s) => {
        s.linkState[0] = 2
        s.linkState[1] = 2
      }),
    ).toEqual([[0, '=>']])
  })

  it('a break in the middle splits one run into the halves either side', () => {
    expect(runsOf(chars('<==>'), (s) => (s.brk[2] = 1))).toEqual([[0, '<=']])
  })
})

describe('bookkeeping the renderer relies on', () => {
  it('marks every cell of a run with the head, so a continuation knows its slice', () => {
    const s = scratch(6)
    computeRuns(row(chars('a === b')), 0, 6, 6, s)
    expect([...s.head]).toEqual([-1, -1, 2, 2, 2, -1])
    expect(s.span[2]).toBe(3)
  })

  it('clears last row before marking this one, so a shorter row leaves no ghosts', () => {
    const s = scratch(6)
    computeRuns(row(chars('a === b')), 0, 6, 6, s)
    computeRuns(row(chars('abcdef')), 0, 6, 6, s)
    expect([...s.head]).toEqual([-1, -1, -1, -1, -1, -1])
  })

  it('stops at the columns the core actually filled', () => {
    // A grid wider than the core's: the tail must not be read as cells.
    const s = scratch(6)
    computeRuns(row(chars('=>')), 0, 2, 6, s)
    expect([...s.head]).toEqual([0, 0, -1, -1, -1, -1])
  })
})
