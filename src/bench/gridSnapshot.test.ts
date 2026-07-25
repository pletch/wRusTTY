/**
 * Golden tests: feed each of the four workload profiles (Phase 7's own
 * scenarios — interactive typing, streaming logs, a full-screen TUI, and a
 * large flood) through GhosttyEngine's core and xterm.js's core, headlessly,
 * and assert they agree on what ended up on screen. This is what
 * src/bench/parity.ts's "Glyphs, colours, layout: parity" line rests on —
 * this test is what keeps that claim from silently going stale.
 */
import { describe, it, expect } from 'vitest'
import { typing, streaming, tui, flood } from './workloads'
import type { Workload } from './workloads'
import { snapshotViaGhostty, snapshotViaXterm } from './gridSnapshot'

const COLS = 80
const ROWS = 24

async function compare(workload: Workload) {
  const built = workload.build(COLS, ROWS)
  const input = { setup: built.setup, events: built.events, cols: COLS, rows: ROWS }
  const [ghostty, xterm] = await Promise.all([snapshotViaGhostty(input), snapshotViaXterm(input)])
  return { ghostty, xterm }
}

describe('grid-state parity between GhosttyEngine and xterm.js', () => {
  it.each([
    ['typing (interactive keystroke echo)', typing],
    ['streaming (tail -f / build log)', streaming],
    ['tui (htop full-screen redraw)', tui],
    ['flood (large coloured cat)', flood],
  ])('%s: agree on every row', async (_name, workload) => {
    const { ghostty, xterm } = await compare(workload)
    expect(ghostty.rows).toEqual(xterm.rows)
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
