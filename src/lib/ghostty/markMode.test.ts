// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { MarkModeController, type MarkModeHost } from './MarkModeController'
import type { Selection } from './SelectionController'
import type { RowText } from './rowText'

/**
 * Keyboard selection, against a fake buffer.
 *
 * The controller is written to a narrow host precisely so this can be a plain
 * unit test: no WASM, no WebGL, no DOM beyond the KeyboardEvents. What it pins
 * is the part with actual rules in it — where the anchor comes from, which keys
 * are consumed and which are deliberately left for someone else, and what ends
 * up on the clipboard.
 */

const COLS = 20
const ROWS = 4

/** One row of text, padded out to the grid the way a real buffer's is. */
function row(text: string): RowText {
  const padded = text.padEnd(COLS, ' ')
  const colStart = new Int32Array(COLS + 1)
  for (let c = 0; c <= COLS; c++) colStart[c] = c
  return { text: padded.slice(0, COLS), colStart }
}

/** Six absolute rows: two of scrollback above a four-row screen. */
const LINES = [
  'first scrollback',
  'second one here',
  'echo hello world',
  'hello world',
  'tail -f /var/log',
  'done',
]

function harness(overrides: Partial<MarkModeHost> = {}) {
  let painted: Selection | null = null
  const copied: string[] = []
  const modes: boolean[] = []
  let scrolledTo: number | null = null

  const host: MarkModeHost = {
    readRows: (from, to) => LINES.slice(from, to + 1).map(row),
    cols: () => COLS,
    rows: () => ROWS,
    totalRows: () => LINES.length,
    // Parked on the last row, where a shell prompt would be.
    terminalCursor: () => ({ x: 0, y: LINES.length - 1 }),
    setSelection: (sel) => {
      painted = sel
    },
    scrollRowIntoView: (r) => {
      scrolledTo = r
    },
    emitChange: () => {},
    // The engine hands back the mouse path's text() for whatever is painted;
    // this reproduces it closely enough for the copy assertions, including the
    // rule that a bare cursor selects nothing.
    selectionText: () => {
      const sel = painted
      if (!sel) return ''
      if (sel.start.x === sel.end.x && sel.start.y === sel.end.y) return ''
      let a = sel.start
      let b = sel.end
      if (a.y > b.y || (a.y === b.y && a.x > b.x)) [a, b] = [b, a]
      const out: string[] = []
      for (let y = a.y; y <= b.y; y++) {
        const from = y === a.y ? a.x : 0
        const to = y === b.y ? b.x : COLS - 1
        out.push(row(LINES[y]).text.slice(from, to + 1).replace(/\s+$/, ''))
      }
      return out.join('\n')
    },
    requestCopy: (text) => copied.push(text),
    notifyMode: (active) => modes.push(active),
    ...overrides,
  }

  const mark = new MarkModeController(host)
  const press = (key: string, mods: KeyboardEventInit = {}) =>
    mark.handleKey(new KeyboardEvent('keydown', { key, ...mods }))

  return {
    mark,
    press,
    copied,
    modes,
    painted: () => painted as Selection | null,
    scrolledTo: () => scrolledTo,
  }
}

describe('entering and leaving', () => {
  it('consumes nothing at all while it is off', () => {
    const { press } = harness()
    // The whole justification for the mode: with it off, the arrows belong to
    // the program and this must not be in their way.
    expect(press('ArrowUp')).toBe(false)
    expect(press('ArrowUp', { shiftKey: true })).toBe(false)
    expect(press('Escape')).toBe(false)
    expect(press('a')).toBe(false)
  })

  it('opens on the terminal cursor and draws it', () => {
    const { mark, painted } = harness()
    mark.enter()
    expect(mark.isActive()).toBe(true)
    // A one-cell selection is how the cursor is made visible — the renderer has
    // no second cursor to draw.
    expect(painted()).toEqual({ start: { x: 0, y: 5 }, end: { x: 0, y: 5 } })
  })

  it('leaves on Escape and takes the highlight with it', () => {
    const { mark, press, painted, modes } = harness()
    mark.enter()
    press('ArrowUp', { shiftKey: true })
    expect(press('Escape')).toBe(true)
    expect(mark.isActive()).toBe(false)
    expect(painted()).toBeNull()
    expect(modes).toEqual([true, false])
  })
})

describe('moving the cursor', () => {
  it('takes no selection until shift is held', () => {
    const { mark, press, painted } = harness()
    mark.enter()
    press('ArrowUp')
    press('ArrowUp')
    // Still just a cursor: two rows up, and both ends together.
    expect(painted()).toEqual({ start: { x: 0, y: 3 }, end: { x: 0, y: 3 } })
  })

  it('anchors where the first shifted press happened, not where the mode opened', () => {
    const { mark, press, painted } = harness()
    mark.enter()
    press('ArrowUp')
    press('ArrowUp')
    press('ArrowUp', { shiftKey: true })
    // The regression this guards: anchoring on entry would have selected from
    // row 5 — everything the unshifted moves walked past.
    expect(painted()).toEqual({ start: { x: 0, y: 3 }, end: { x: 0, y: 2 } })
  })

  it('collapses back to a cursor when an unshifted move follows', () => {
    const { mark, press, painted } = harness()
    mark.enter()
    press('ArrowUp', { shiftKey: true })
    press('ArrowUp')
    expect(painted()).toEqual({ start: { x: 0, y: 3 }, end: { x: 0, y: 3 } })
  })

  it('wraps onto the row above and below at the ends of a line', () => {
    const { mark, press, painted } = harness()
    mark.enter()
    press('ArrowLeft')
    // From column 0 of row 5, left is the last column of row 4 — a cursor that
    // stopped dead in the corner could not be walked through a paragraph.
    expect(painted()!.end).toEqual({ x: COLS - 1, y: 4 })
    press('ArrowRight')
    expect(painted()!.end).toEqual({ x: 0, y: 5 })
  })

  it('stops at the edges of the buffer rather than running off them', () => {
    const { mark, press, painted } = harness()
    mark.enter()
    for (let i = 0; i < 10; i++) press('ArrowUp')
    expect(painted()!.end.y).toBe(0)
    press('ArrowLeft')
    expect(painted()!.end).toEqual({ x: 0, y: 0 })
    for (let i = 0; i < 10; i++) press('ArrowDown')
    expect(painted()!.end.y).toBe(LINES.length - 1)
  })

  it('keeps the cursor on screen as it moves', () => {
    const { mark, press, scrolledTo } = harness()
    mark.enter()
    press('ArrowUp')
    press('ArrowUp')
    press('ArrowUp')
    expect(scrolledTo()).toBe(2)
  })

  it('puts End after the last character, not out in the padding', () => {
    const { mark, press, painted } = harness()
    mark.enter()
    press('ArrowUp') // row 4: 'tail -f /var/log'
    press('End')
    expect(painted()!.end).toEqual({ x: 'tail -f /var/log'.length - 1, y: 4 })
  })

  it('moves a word at a time with ctrl', () => {
    const { mark, press, painted } = harness()
    mark.enter()
    press('ArrowUp') // row 4: 'tail -f /var/log'
    press('ArrowRight', { ctrlKey: true })
    // Past 'tail' and the space, onto the flag — '-f' and '/var/log' are one
    // word each, which is the point of the wider word rule.
    expect(painted()!.end).toEqual({ x: 5, y: 4 })
    press('ArrowRight', { ctrlKey: true })
    expect(painted()!.end).toEqual({ x: 8, y: 4 })
    press('ArrowLeft', { ctrlKey: true })
    expect(painted()!.end).toEqual({ x: 5, y: 4 })
  })

  it('selects the whole line on ctrl+A', () => {
    const { mark, press, painted } = harness()
    mark.enter()
    expect(press('a', { ctrlKey: true })).toBe(true)
    expect(painted()).toEqual({ start: { x: 0, y: 5 }, end: { x: COLS - 1, y: 5 } })
  })
})

describe('copying', () => {
  it('copies the selection and leaves the mode', () => {
    const { mark, press, copied, painted } = harness()
    mark.enter()
    // Walk up to 'hello world' unshifted, then take the line by extending to
    // its end — the gesture the mode exists for.
    press('ArrowUp')
    press('ArrowUp')
    press('End', { shiftKey: true })
    expect(press('Enter')).toBe(true)
    expect(copied).toEqual(['hello world'])
    expect(mark.isActive()).toBe(false)
    // The highlight stays: it is the confirmation of what was taken.
    expect(painted()).not.toBeNull()
  })

  it('joins the rows of a selection that spans several', () => {
    const { mark, press, copied } = harness()
    mark.enter()
    press('ArrowUp')
    press('ArrowUp')
    press('ArrowDown', { shiftKey: true })
    press('End', { shiftKey: true })
    press('Enter')
    expect(copied).toEqual(['hello world\ntail -f /var/log'])
  })

  it('copies nothing when only the cursor is there', () => {
    const { mark, press, copied, painted } = harness()
    mark.enter()
    press('ArrowUp')
    press('Enter')
    // A one-cell block is the cursor, not a selection — copying it would put
    // one arbitrary character on the clipboard.
    expect(copied).toEqual([])
    expect(painted()).toBeNull()
  })
})

describe('what it refuses to swallow', () => {
  it("leaves the app's own ctrl shortcuts alone", () => {
    const { mark, press } = harness()
    mark.enter()
    // New tab, close pane, the command palette: a mode that ate these would
    // strand the user in the pane it was turned on in.
    expect(press('t', { ctrlKey: true, shiftKey: true })).toBe(false)
    expect(press('w', { ctrlKey: true, shiftKey: true })).toBe(false)
    expect(press('Tab', { ctrlKey: true })).toBe(false)
    expect(press('c', { ctrlKey: true, shiftKey: true })).toBe(false)
  })

  it('swallows plain typing, which is what it suspends', () => {
    const { mark, press } = harness()
    mark.enter()
    expect(press('a')).toBe(true)
    expect(press(' ')).toBe(true)
    // Holding shift to reach a capital is still typing.
    expect(press('A', { shiftKey: true })).toBe(true)
  })

  it('passes bare modifier presses through', () => {
    const { mark, press } = harness()
    mark.enter()
    expect(press('Shift', { shiftKey: true })).toBe(false)
  })
})

describe('yielding to the mouse', () => {
  it('lets go of the keyboard without wiping what the mouse is about to draw', () => {
    const { mark, press, painted } = harness()
    mark.enter()
    press('ArrowUp', { shiftKey: true })
    const before = painted()
    mark.cancel()
    expect(mark.isActive()).toBe(false)
    // cancel() is for a caller that is taking the selection over; clearing it
    // here would fight whatever is replacing it.
    expect(painted()).toBe(before)
    expect(press('ArrowUp')).toBe(false)
  })
})

describe('not announcing every keystroke', () => {
  it('stays quiet while a selection is being built', () => {
    const emitChange = vi.fn()
    const { mark, press } = harness({ emitChange })
    mark.enter()
    press('ArrowUp', { shiftKey: true })
    press('ArrowUp', { shiftKey: true })
    // copy-on-select listens to this. Firing per keystroke would put every
    // intermediate state of the selection on the clipboard.
    expect(emitChange).not.toHaveBeenCalled()
    press('Escape')
    expect(emitChange).toHaveBeenCalledTimes(1)
  })
})
