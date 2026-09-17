import { describe, it, expect } from 'vitest'
import { PromptInputTracker, sliceColumns, tooShortToInfer, type GridReader } from './promptInput'
import type { RowText } from './ghostty/rowText'

/**
 * A grid of plain rows, in the shape `readRowText` returns.
 *
 * Rows are given as strings and padded to the grid width, which is what a real
 * terminal row is — every column exists, and the ones nothing was written to
 * hold a space. Tests that forget the padding pass against a fake and fail
 * against the engine, so the fake does it rather than each test.
 */
function makeGrid(cols: number) {
  const rows: string[] = []
  let cursor = { x: 0, y: 0 }

  function rowText(text: string): RowText {
    const padded = text.padEnd(cols, ' ')
    // One code unit per column: enough for everything these tests exercise,
    // and `sliceColumns` has its own test for the case where it isn't.
    const colStart = new Int32Array(cols + 1)
    for (let i = 0; i <= cols; i++) colStart[i] = i
    return { text: padded.slice(0, cols), colStart }
  }

  const grid: GridReader & {
    setRows(...text: string[]): void
    setCursor(row: number, col: number): void
  } = {
    cols,
    cursorCell: () => cursor,
    readRowText: (from, to) => {
      const out: RowText[] = []
      for (let r = from; r <= to; r++) out.push(rowText(rows[r] ?? ''))
      return out
    },
    setRows: (...text: string[]) => {
      rows.length = 0
      rows.push(...text)
    },
    setCursor: (row: number, col: number) => {
      cursor = { x: col, y: row }
    },
  }
  return grid
}

describe('PromptInputTracker', () => {
  it('reads what is between the prompt and the cursor', () => {
    const grid = makeGrid(40)
    const tracker = new PromptInputTracker(grid)
    grid.setRows('tim@host:~$ ')
    grid.setCursor(0, 12)
    tracker.handleOsc('B')
    tracker.noteParsed()

    grid.setRows('tim@host:~$ git st')
    grid.setCursor(0, 18)
    expect(tracker.read()?.text).toBe('git st')
    expect(tracker.exact).toBe(true)
  })

  /**
   * The point of reading the screen instead of the keystrokes. Tab completion
   * and history recall put text on the line that never passed through this
   * app, and both are read correctly with no special handling at all.
   */
  it('sees text the remote put on the line, not just what was typed', () => {
    const grid = makeGrid(40)
    const tracker = new PromptInputTracker(grid)
    grid.setRows('$ ')
    grid.setCursor(0, 2)
    tracker.handleOsc('B')
    tracker.noteParsed()

    // The user typed `git ch` and pressed Tab; the remote completed it.
    grid.setRows('$ git checkout ')
    grid.setCursor(0, 15)
    expect(tracker.read()?.text).toBe('git checkout ')

    // Then Up, and the shell replaced the whole line from its own history.
    grid.setRows('$ docker compose logs -f')
    grid.setCursor(0, 24)
    expect(tracker.read()?.text).toBe('docker compose logs -f')
  })

  it('follows a line that wrapped across rows', () => {
    const grid = makeGrid(20)
    const tracker = new PromptInputTracker(grid)
    grid.setRows('$ ')
    grid.setCursor(0, 2)
    tracker.handleOsc('B')
    tracker.noteParsed()

    // The first row is *full* — 20 of 20 columns — because that is the only
    // way a line wraps. A fixture with a short first row is not a wrapped
    // line, it is a line with trailing blanks, and reading it as one would
    // splice the padding into the middle of the command.
    grid.setRows('$ rsync -avz --dry-r', 'un src/ dst/')
    grid.setCursor(1, 12)
    expect(tracker.read()?.text).toBe('rsync -avz --dry-run src/ dst/')
  })

  /**
   * A password prompt echoes nothing, so there is nothing between the origin
   * and the cursor — the read comes back empty without anything having to
   * recognise the prompt as a password prompt.
   */
  it('reads nothing at a prompt that does not echo', () => {
    const grid = makeGrid(40)
    const tracker = new PromptInputTracker(grid)
    grid.setRows('Password: ')
    grid.setCursor(0, 10)
    tracker.handleOsc('B')
    tracker.noteParsed()

    // The user has typed a password. The screen is unchanged.
    expect(tracker.read()?.text).toBe('')
  })

  it('reports whether the cursor is at the end of the line', () => {
    const grid = makeGrid(40)
    const tracker = new PromptInputTracker(grid)
    grid.setRows('$ ')
    grid.setCursor(0, 2)
    tracker.handleOsc('B')
    tracker.noteParsed()

    grid.setRows('$ git commit')
    grid.setCursor(0, 12)
    expect(tracker.read()?.atEnd).toBe(true)

    // Left-arrowed back into the middle of the word to fix a typo: still
    // readable, but completing it would splice text into the middle.
    grid.setCursor(0, 6)
    const mid = tracker.read()
    // Columns 2..6 — the text *before* the cursor, which is the part a
    // completion would have to extend.
    expect(mid?.text).toBe('git ')
    expect(mid?.atEnd).toBe(false)
  })

  it('has nothing to read while a command is running or on the alt screen', () => {
    const grid = makeGrid(40)
    const tracker = new PromptInputTracker(grid)
    grid.setRows('$ make')
    grid.setCursor(0, 6)
    tracker.handleOsc('B')
    tracker.noteParsed()
    expect(tracker.read()).not.toBeNull()

    tracker.handleOsc('C')
    expect(tracker.read()).toBeNull()

    tracker.handleOsc('D;0')
    tracker.handleOsc('B')
    tracker.noteParsed()
    expect(tracker.read()).not.toBeNull()

    tracker.setAltScreen(true)
    expect(tracker.read()).toBeNull()
  })

  it('gives up when the cursor moves somewhere the origin cannot explain', () => {
    const grid = makeGrid(40)
    const tracker = new PromptInputTracker(grid)
    grid.setRows('$ ', '')
    grid.setCursor(1, 2)
    tracker.handleOsc('B')
    tracker.noteParsed()

    // Scrolled, redrawn, or painted over: the cursor is now above the origin.
    grid.setCursor(0, 5)
    expect(tracker.read()).toBeNull()

    // Or implausibly far below it — a screenful of output, not a wrapped line.
    grid.setCursor(40, 0)
    expect(tracker.read()).toBeNull()
  })

  describe('without shell integration', () => {
    it('infers an origin from a keystroke after a quiet pane', () => {
      const grid = makeGrid(40)
      let clock = 10_000
      const tracker = new PromptInputTracker(grid, () => clock)

      grid.setRows('bash-5.2$ ')
      grid.setCursor(0, 10)
      tracker.noteParsed()

      // Typing while output is still arriving is not the start of a line.
      clock += 100
      tracker.noteInput()
      expect(tracker.read()).toBeNull()

      // After a quiet stretch it is.
      clock += 5_000
      tracker.noteInput()
      expect(tracker.exact).toBe(false)
      grid.setRows('bash-5.2$ ls -')
      grid.setCursor(0, 14)
      expect(tracker.read()?.text).toBe('ls -')
    })

    /**
     * The guess is "output stopped, then you typed, so the cursor is at a
     * fresh prompt". A key pressed before the quiet period gets no origin —
     * and if the far end answers it by drawing a recalled command, the next
     * key's quiet period is measured against a line that is no longer empty.
     * Believing it there puts the origin at the end of the command.
     */
    it('declines to guess at a line a blind keystroke has already changed', () => {
      const grid = makeGrid(40)
      let clock = 10_000
      const tracker = new PromptInputTracker(grid, () => clock)
      grid.setRows('bash-5.2$ ')
      grid.setCursor(0, 10)
      tracker.noteParsed()

      // Up, pressed while the last command's output is still recent.
      clock += 100
      tracker.noteInput(Uint8Array.from([0x1b, 0x5b, 0x41]))
      // The shell recalls a command in answer to it.
      grid.setRows('bash-5.2$ journalctl -u nginx -f')
      grid.setCursor(0, 31)
      tracker.noteParsed()

      // The hand pauses and keeps walking. The pane has been quiet for five
      // seconds, but the line is not the empty one the quiet period implies.
      clock += 5_000
      tracker.noteInput(Uint8Array.from([0x1b, 0x5b, 0x41]))
      expect(tracker.read()).toBeNull()
    })

    it('guesses again at the next line', () => {
      const grid = makeGrid(40)
      let clock = 10_000
      const tracker = new PromptInputTracker(grid, () => clock)
      grid.setRows('bash-5.2$ ')
      grid.setCursor(0, 10)
      tracker.noteParsed()
      clock += 100
      tracker.noteInput(Uint8Array.from([0x1b, 0x5b, 0x41]))
      grid.setRows('bash-5.2$ ls -la')
      grid.setCursor(0, 16)
      tracker.noteParsed()

      // Enter runs it, which ends the line and everything guessed about it.
      tracker.reset()
      grid.setRows('bash-5.2$ ')
      grid.setCursor(0, 10)
      tracker.noteParsed()
      clock += 5_000
      tracker.noteInput(new TextEncoder().encode('m'))
      grid.setRows('bash-5.2$ m')
      grid.setCursor(0, 11)
      expect(tracker.read()?.text).toBe('m')
    })

    it('takes a marker as the answer to a line it had given up on', () => {
      const grid = makeGrid(40)
      let clock = 10_000
      const tracker = new PromptInputTracker(grid, () => clock)
      grid.setRows('bash-5.2$ ')
      grid.setCursor(0, 10)
      tracker.noteParsed()
      clock += 100
      tracker.noteInput(Uint8Array.from([0x1b, 0x5b, 0x41]))
      grid.setRows('bash-5.2$ make test')
      grid.setCursor(0, 19)
      tracker.noteParsed()

      // The host turns out to be integrated after all — a prompt marker says
      // outright where the next line starts, so there is nothing left to guess.
      grid.setRows('$ ')
      grid.setCursor(0, 2)
      tracker.handleOsc('B')
      grid.setRows('$ git push')
      grid.setCursor(0, 10)
      expect(tracker.read()?.text).toBe('git push')
      expect(tracker.exact).toBe(true)
    })

    it('never lets a guess replace a marker', () => {
      const grid = makeGrid(40)
      let clock = 10_000
      const tracker = new PromptInputTracker(grid, () => clock)
      grid.setRows('$ ')
      grid.setCursor(0, 2)
      tracker.handleOsc('B')
      tracker.noteParsed()

      clock += 5_000
      grid.setCursor(0, 9)
      tracker.noteInput()
      // Still the marker's origin, so the text reads from column 2.
      grid.setRows('$ git log')
      expect(tracker.read()?.text).toBe('git log')
      expect(tracker.exact).toBe(true)
    })
  })

  describe('after a resize', () => {
    /**
     * An absolute row survives output scrolling underneath it, which is the
     * whole reason the origin is one. It does not survive a reflow: the core
     * rewraps the buffer at the new width, so the row noted before the resize
     * names different cells after it — and a command that used to wrap onto a
     * second row leaves the origin *below* the cursor, which reads as nothing
     * being there at all.
     */
    it('lets go of an origin the reflow may have moved', () => {
      const grid = makeGrid(40)
      const tracker = new PromptInputTracker(grid)
      grid.setRows('$ ')
      grid.setCursor(0, 2)
      tracker.handleOsc('B')
      grid.setRows('$ cat a.log | grep x')
      grid.setCursor(0, 20)
      expect(tracker.read()?.text).toBe('cat a.log | grep x')

      tracker.noteResized()
      expect(tracker.read()).toBeNull()
    })

    it('takes the prompt marker the resize provokes', () => {
      const grid = makeGrid(60)
      const tracker = new PromptInputTracker(grid)
      grid.setRows('$ ')
      grid.setCursor(0, 2)
      tracker.handleOsc('B')
      tracker.noteResized()

      // readline redraws its prompt on SIGWINCH, markers and all, which is
      // what puts an integrated host straight back in business.
      grid.setRows('$ ')
      grid.setCursor(0, 2)
      tracker.handleOsc('B')
      grid.setRows('$ cat a.log | grep x | sort')
      grid.setCursor(0, 27)
      expect(tracker.read()?.text).toBe('cat a.log | grep x | sort')
      expect(tracker.exact).toBe(true)
    })

    it('does not guess at the redrawn line on a host with no markers', () => {
      const grid = makeGrid(60)
      let clock = 10_000
      const tracker = new PromptInputTracker(grid, () => clock)
      grid.setRows('bash-5.2$ ')
      grid.setCursor(0, 10)
      tracker.noteParsed()
      clock += 5_000
      tracker.noteInput(new TextEncoder().encode('l'))
      grid.setRows('bash-5.2$ ls -la')
      grid.setCursor(0, 16)
      expect(tracker.read()?.text).toBe('ls -la')

      // Nothing here can re-measure, and the line still holds the command the
      // shell redrew, so the next keystroke must not be read as starting one.
      tracker.noteResized()
      clock += 5_000
      tracker.noteInput(new TextEncoder().encode('x'))
      expect(tracker.read()).toBeNull()
    })
  })

  describe('counting what was typed, for passive capture', () => {
    /**
     * The check that keeps a password out of the store on a host with no
     * shell integration: more went out than came back, so the line is refused.
     */
    it('counts printable bytes and backspaces', () => {
      const grid = makeGrid(40)
      const tracker = new PromptInputTracker(grid)
      grid.setRows('$ ')
      grid.setCursor(0, 2)
      tracker.handleOsc('B')
      tracker.noteParsed()

      tracker.noteInput(new TextEncoder().encode('ls -la'))
      expect(tracker.typedCount).toBe(6)
      // Two backspaces take two off.
      tracker.noteInput(Uint8Array.from([0x7f, 0x08]))
      expect(tracker.typedCount).toBe(4)
      // ...and never below zero, however many arrive.
      tracker.noteInput(Uint8Array.from([0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f]))
      expect(tracker.typedCount).toBe(0)
    })

    it('counts a multi-byte character once, not once per byte', () => {
      // Counted per byte, `é` would look like two characters typed and one
      // echoed — and the line would be refused as if it had not echoed.
      const grid = makeGrid(40)
      const tracker = new PromptInputTracker(grid)
      grid.setRows('$ ')
      grid.setCursor(0, 2)
      tracker.handleOsc('B')
      tracker.noteParsed()
      tracker.noteInput(new TextEncoder().encode('echo café'))
      expect(tracker.typedCount).toBe(8)
    })

    it('starts again at each new line', () => {
      const grid = makeGrid(40)
      const tracker = new PromptInputTracker(grid)
      grid.setRows('$ ')
      grid.setCursor(0, 2)
      tracker.handleOsc('B')
      tracker.noteParsed()
      tracker.noteInput(new TextEncoder().encode('whoami'))
      expect(tracker.typedCount).toBe(6)
      tracker.reset()
      expect(tracker.typedCount).toBe(0)
    })
  })

  it('produces nothing at all on an engine without the grid reads', () => {
    const tracker = new PromptInputTracker({ cols: 80 })
    expect(tracker.supported).toBe(false)
    tracker.handleOsc('B')
    tracker.noteParsed()
    tracker.noteInput()
    expect(tracker.read()).toBeNull()
  })
})

describe('sliceColumns', () => {
  /**
   * A column is not a character. A wide character occupies two columns and one
   * code unit, and its trailing column holds none — so slicing the row string
   * by column index drifts by one for every CJK character or emoji earlier in
   * the line. This decides what bytes get sent, so drifting by one means
   * sending a command the user never typed.
   */
  it('slices by column, not by character, across a wide character', () => {
    // Columns:  0='a' 1='世' 2=(spacer) 3='b'
    const row = { text: 'a世b', colStart: Int32Array.from([0, 1, 2, 2, 3]) }
    expect(sliceColumns(row, 0, 4)).toBe('a世b')
    expect(sliceColumns(row, 1, 3)).toBe('世')
    expect(sliceColumns(row, 3, 4)).toBe('b')
    // The trailing half of the wide character shows nothing of its own.
    expect(sliceColumns(row, 2, 3)).toBe('')
  })

  it('clamps rather than throwing on a range past the row', () => {
    const row = { text: 'abc', colStart: Int32Array.from([0, 1, 2, 3]) }
    expect(sliceColumns(row, 0, 99)).toBe('abc')
    expect(sliceColumns(row, -5, 2)).toBe('ab')
    expect(sliceColumns(row, 2, 1)).toBe('')
  })
})

describe('tooShortToInfer', () => {
  it('rejects the single key that answers a program', () => {
    // `y`, `n`, a menu's `1`, a pager's `q` — the whole confusable set is one
    // character long.
    for (const reply of ['y', 'n', 'Y', '1', 'q', ' n ']) {
      expect(tooShortToInfer(reply)).toBe(true)
    }
  })

  it('accepts anything two characters or longer', () => {
    for (const command of ['ls', 'cd ..', 'git status']) {
      expect(tooShortToInfer(command)).toBe(false)
    }
  })

  it('counts an astral character as one character, not two', () => {
    // `'🚀'.length` is 2 in UTF-16, which would let a single keystroke through
    // on a count of code units.
    expect(tooShortToInfer('🚀')).toBe(true)
  })

  it('treats a blank line as too short, as an empty one already was', () => {
    expect(tooShortToInfer('   ')).toBe(true)
  })
})
