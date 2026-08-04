import { describe, expect, it } from 'vitest'

import { snapshotViaGhostty } from './gridSnapshot'
import { hasMainBuild, snapshotViaGhosttyMain } from './gridSnapshotMain'

/**
 * The port's real gate: identical bytes through the vendored v1.3.1 build and
 * through ghostty `main`, compared cell by cell.
 *
 * Both sides are the same terminal implementation, so any divergence here is
 * the ABI mapping's fault rather than a VT difference — which is what makes
 * this sharper than `gridSnapshot.test.ts`'s comparison against xterm.js. It is
 * also the only check that would catch the failure mode every trap in this port
 * has had so far: output that is entirely plausible and quietly wrong.
 *
 * Skips without a comparison build; see `main/vendor-main/README.md`.
 */

const enc = new TextEncoder()
const b = (s: string) => enc.encode(s)

const COLS = 40
const ROWS = 8

const run = hasMainBuild() ? describe : describe.skip

run('vendored v1.3.1 vs ghostty main, same bytes', () => {
  const both = async (setup: string | null, ...events: string[]) => {
    const input = {
      setup: setup === null ? undefined : b(setup),
      events: events.map(b),
      cols: COLS,
      rows: ROWS,
    }
    return {
      old: await snapshotViaGhostty(input),
      neu: snapshotViaGhosttyMain(input),
    }
  }

  it('agrees on plain text and cursor position', async () => {
    const { old, neu } = await both(null, 'hello world\r\nsecond line')
    expect(neu.rows).toEqual(old.rows)
    expect(neu.cursorX).toBe(old.cursorX)
    expect(neu.cursorY).toBe(old.cursorY)
  })

  it('agrees on every text attribute', async () => {
    const { old, neu } = await both(
      null,
      '\x1b[1mbold\x1b[0m \x1b[3mital\x1b[0m \x1b[4munder\x1b[0m \x1b[9mstrike\x1b[0m\r\n' +
        '\x1b[7minv\x1b[0m \x1b[8mhid\x1b[0m \x1b[5mblink\x1b[0m \x1b[2mfaint\x1b[0m',
    )
    expect(neu.rows).toEqual(old.rows)
    expect(neu.flags).toEqual(old.flags)
  })

  it('agrees on which underline is drawn, and on overline', async () => {
    const { old, neu } = await both(
      null,
      '\x1b[4:1ma\x1b[4:2mb\x1b[4:3mc\x1b[4:4md\x1b[4:5me\x1b[0m\x1b[53mo\x1b[0m',
    )
    expect(neu.rows).toEqual(old.rows)
    expect(neu.attrs2).toEqual(old.attrs2)
  })

  it('agrees on palette colours', async () => {
    const { old, neu } = await both(
      null,
      '\x1b[31mred\x1b[0m \x1b[32mgrn\x1b[0m \x1b[44mbgblue\x1b[0m\r\n' +
        '\x1b[38;5;9mbright\x1b[0m \x1b[48;5;12mbg\x1b[0m',
    )
    expect(neu.rows).toEqual(old.rows)
    expect(neu.fg).toEqual(old.fg)
    expect(neu.bg).toEqual(old.bg)
  })

  it('agrees on direct rgb colours', async () => {
    const { old, neu } = await both(
      null,
      '\x1b[38;2;10;20;30mfg\x1b[0m \x1b[48;2;40;50;60mbg\x1b[0m',
    )
    expect(neu.fg).toEqual(old.fg)
    expect(neu.bg).toEqual(old.bg)
  })

  it('agrees on default colours, which the two ABIs represent differently', async () => {
    // Our ABI pre-resolves a cell with no explicit colour to the terminal
    // default; main reports INVALID_VALUE and leaves the substitution to the
    // caller. This is the case that check exists for.
    const { old, neu } = await both(null, 'plain text, no sgr at all')
    expect(neu.fg).toEqual(old.fg)
    expect(neu.bg).toEqual(old.bg)
  })

  it('folds a wide glyph the same way on both sides', async () => {
    // If the two disagree about the spacer cell, every column after the first
    // wide character shifts and the whole row mismatches.
    const { old, neu } = await both(null, 'a世界b CJK\r\nplain')
    expect(neu.rows).toEqual(old.rows)
    expect(neu.fg).toEqual(old.fg)
  })

  it('agrees after a scroll, where row identity is easiest to lose', async () => {
    let s = ''
    for (let i = 0; i < ROWS * 3; i++) s += `row ${i}\r\n`
    const { old, neu } = await both(null, s)
    expect(neu.rows).toEqual(old.rows)
    expect(neu.cursorY).toBe(old.cursorY)
  })

  it('agrees on a styled full screen, the case a renderer actually sees', async () => {
    let s = '\x1b[H'
    for (let r = 0; r < ROWS; r++) {
      s += `\x1b[38;5;${(r % 200) + 16}m`
      if (r % 3 === 0) s += '\x1b[1m'
      if (r % 4 === 0) s += '\x1b[4m'
      s += `line ${r} `.repeat(4).slice(0, COLS - 1)
      s += '\x1b[0m'
      if (r < ROWS - 1) s += '\r\n'
    }
    const { old, neu } = await both(null, s)
    expect(neu.rows).toEqual(old.rows)
    expect(neu.fg).toEqual(old.fg)
    expect(neu.bg).toEqual(old.bg)
    expect(neu.flags).toEqual(old.flags)
    expect(neu.attrs2).toEqual(old.attrs2)
  })
})
