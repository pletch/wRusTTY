/**
 * Golden tests: feed each of the four workload profiles (Phase 7's own
 * scenarios — interactive typing, streaming logs, a full-screen TUI, and a
 * large flood) through GhosttyEngine's core and xterm.js's core, headlessly,
 * and assert they agree on what ended up on screen. This is what
 * src/bench/parity.ts's "Glyphs, colours, layout: parity" line rests on —
 * this test is what keeps that claim from silently going stale.
 *
 * Colours and text attributes are compared as well as glyphs. They were not
 * originally, which left the "colours" half of that ledger line as prose: you
 * could break the renderer's default-colour remap outright and every test
 * here still passed. Both engines are pinned to one palette to make the
 * comparison mean something — see gridPalette.ts.
 */
import { describe, it, expect } from 'vitest'
import { typing, streaming, tui, flood } from './workloads'
import type { Workload } from './workloads'
import { snapshotViaGhostty, snapshotViaXterm, type GridSnapshot } from './gridSnapshot'
import { rgbHex } from './gridPalette'
import {
  CELL_BOLD,
  CELL_ITALIC,
  CELL_UNDERLINE,
  CELL_STRIKETHROUGH,
  CELL_INVERSE,
  CELL_INVISIBLE,
  CELL_BLINK,
  CELL_FAINT,
} from '../lib/ghostty/wasmBindings'

const COLS = 80
const ROWS = 24

const enc = new TextEncoder()

async function compare(workload: Workload) {
  const built = workload.build(COLS, ROWS)
  const input = { setup: built.setup, events: built.events, cols: COLS, rows: ROWS }
  const [ghostty, xterm] = await Promise.all([snapshotViaGhostty(input), snapshotViaXterm(input)])
  return { ghostty, xterm }
}

async function compareBytes(text: string) {
  const input = { events: [enc.encode(text)], cols: COLS, rows: ROWS }
  const [ghostty, xterm] = await Promise.all([snapshotViaGhostty(input), snapshotViaXterm(input)])
  return { ghostty, xterm }
}

/** Renders one row's colours as a readable string so a failure names the row
 * and the column rather than dumping two 1920-element arrays. The glyphs are
 * interleaved because "row 7 differs at column 34" is only actionable
 * alongside what is at column 34. */
function colorRow(snap: GridSnapshot, y: number, which: 'fg' | 'bg'): string {
  const line = snap.rows[y]
  return snap[which][y].map((c, i) => `${line[i] ?? ' '}:${rgbHex(c)}`).join(' ')
}

const ATTR_NAMES: [number, string][] = [
  [CELL_BOLD, 'bold'],
  [CELL_ITALIC, 'italic'],
  [CELL_UNDERLINE, 'underline'],
  [CELL_STRIKETHROUGH, 'strike'],
  [CELL_INVERSE, 'inverse'],
  [CELL_INVISIBLE, 'invisible'],
  [CELL_BLINK, 'blink'],
  [CELL_FAINT, 'faint'],
]

function attrRow(snap: GridSnapshot, y: number): string {
  const line = snap.rows[y]
  return snap.flags[y]
    .map((f, i) => {
      const names = ATTR_NAMES.filter(([bit]) => (f & bit) !== 0).map(([, n]) => n)
      return `${line[i] ?? ' '}:${names.length ? names.join('+') : '-'}`
    })
    .join(' ')
}

/** Row-by-row rather than whole-snapshot: a single `toEqual` on the nested
 * arrays reports "arrays differ" and leaves you to find where. */
function expectRowwise(a: GridSnapshot, b: GridSnapshot, render: (s: GridSnapshot, y: number) => string) {
  for (let y = 0; y < a.rows.length; y++) {
    expect(render(a, y), `row ${y}`).toEqual(render(b, y))
  }
}

describe('grid-state parity between GhosttyEngine and xterm.js', () => {
  const workloads: [string, Workload][] = [
    ['typing (interactive keystroke echo)', typing],
    ['streaming (tail -f / build log)', streaming],
    ['tui (htop full-screen redraw)', tui],
    ['flood (large coloured cat)', flood],
  ]

  it.each(workloads)('%s: agree on every row', async (_name, workload) => {
    const { ghostty, xterm } = await compare(workload)
    expect(ghostty.rows).toEqual(xterm.rows)
  }, 20_000)

  it.each(workloads)('%s: agree on every foreground colour', async (_name, workload) => {
    const { ghostty, xterm } = await compare(workload)
    expectRowwise(ghostty, xterm, (s, y) => colorRow(s, y, 'fg'))
  }, 20_000)

  it.each(workloads)('%s: agree on every background colour', async (_name, workload) => {
    const { ghostty, xterm } = await compare(workload)
    expectRowwise(ghostty, xterm, (s, y) => colorRow(s, y, 'bg'))
  }, 20_000)

  it.each(workloads)('%s: agree on every text attribute', async (_name, workload) => {
    const { ghostty, xterm } = await compare(workload)
    expectRowwise(ghostty, xterm, attrRow)
  }, 20_000)

  it('typing: agree on cursor position', async () => {
    const { ghostty, xterm } = await compare(typing)
    expect([ghostty.cursorX, ghostty.cursorY]).toEqual([xterm.cursorX, xterm.cursorY])
  })

  it('streaming: agree on cursor position', async () => {
    const { ghostty, xterm } = await compare(streaming)
    expect([ghostty.cursorX, ghostty.cursorY]).toEqual([xterm.cursorX, xterm.cursorY])
  })
})

/**
 * The four workloads are realistic but narrow: between them they use 256-colour
 * foregrounds and nothing else. No background colour, no bold, no inverse, no
 * 24-bit colour, no erase-with-background. These cases exist to exercise the
 * parts of the new comparison the workloads would leave permanently unread —
 * a test that only ever sees `\x1b[38;5;Nm` cannot tell you the bg path works.
 */
describe('colour and attribute parity on directed SGR cases', () => {
  it('agrees on the 16 ANSI foregrounds and backgrounds', async () => {
    const parts: string[] = []
    for (let i = 0; i < 8; i++) parts.push(`\x1b[3${i}mF${i}\x1b[0m `)
    for (let i = 0; i < 8; i++) parts.push(`\x1b[9${i}mB${i}\x1b[0m `)
    parts.push('\r\n')
    for (let i = 0; i < 8; i++) parts.push(`\x1b[4${i}mG${i}\x1b[0m `)
    for (let i = 0; i < 8; i++) parts.push(`\x1b[10${i}mH${i}\x1b[0m `)
    const { ghostty, xterm } = await compareBytes(parts.join(''))
    expect(ghostty.rows).toEqual(xterm.rows)
    expectRowwise(ghostty, xterm, (s, y) => colorRow(s, y, 'fg'))
    expectRowwise(ghostty, xterm, (s, y) => colorRow(s, y, 'bg'))
  })

  it('agrees across the whole 256-colour cube and grey ramp', async () => {
    const parts: string[] = []
    for (let i = 0; i < 256; i++) {
      parts.push(`\x1b[38;5;${i}m#\x1b[0m`)
      if (i % 64 === 63) parts.push('\r\n')
    }
    const { ghostty, xterm } = await compareBytes(parts.join(''))
    expectRowwise(ghostty, xterm, (s, y) => colorRow(s, y, 'fg'))
  })

  it('agrees on 24-bit truecolour', async () => {
    const text = '\x1b[38;2;17;34;51m24bit\x1b[48;2;204;170;136mBG\x1b[0m plain'
    const { ghostty, xterm } = await compareBytes(text)
    expectRowwise(ghostty, xterm, (s, y) => colorRow(s, y, 'fg'))
    expectRowwise(ghostty, xterm, (s, y) => colorRow(s, y, 'bg'))
  })

  it('agrees on bold, italic, underline, strikethrough, inverse, blink and faint', async () => {
    const text = [
      '\x1b[1mbold\x1b[0m ',
      '\x1b[3mitalic\x1b[0m ',
      '\x1b[4munder\x1b[0m ',
      '\x1b[9mstrike\x1b[0m ',
      '\x1b[7minverse\x1b[0m ',
      '\x1b[5mblink\x1b[0m ',
      '\x1b[2mfaint\x1b[0m ',
      '\x1b[1;3;4;7mall\x1b[0m',
    ].join('')
    const { ghostty, xterm } = await compareBytes(text)
    expect(ghostty.rows).toEqual(xterm.rows)
    expectRowwise(ghostty, xterm, attrRow)
  })

  // Attributes have to *stop* where the SGR says, not just start there. A
  // reset that clears one bit too many (or too few) is invisible to a test
  // that only checks the attributed run itself.
  it('agrees on where an attribute run ends', async () => {
    const text = '\x1b[1;31mred bold\x1b[22m red only\x1b[39m plain\x1b[0m tail'
    const { ghostty, xterm } = await compareBytes(text)
    expectRowwise(ghostty, xterm, attrRow)
    expectRowwise(ghostty, xterm, (s, y) => colorRow(s, y, 'fg'))
  })

  // Erase-with-background: ED/EL paint the *current* background into the
  // erased cells rather than the default. This is the one place a blank cell's
  // colour is load-bearing, which is why it gets a directed case even though
  // the snapshot trims trailing blanks elsewhere.
  it('agrees on erase-in-line with a non-default background', async () => {
    const text = '\x1b[44mblue bg\x1b[K\r\nnext line'
    const { ghostty, xterm } = await compareBytes(text)
    expect(ghostty.rows).toEqual(xterm.rows)
    expectRowwise(ghostty, xterm, (s, y) => colorRow(s, y, 'bg'))
  })
})
