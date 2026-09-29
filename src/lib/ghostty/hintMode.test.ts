// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { HintModeController, type Hint, type HintModeHost } from './HintModeController'
import type { Link } from './LinkController'

/**
 * Hint mode, driven by real `KeyboardEvent`s against a stub host — the shape
 * `markModeKeys.test.ts` uses, because the questions are the same: which keys
 * the mode claims, which it deliberately lets past, and what it leaves behind
 * when it goes.
 */

const COLS = 20

function link(url: string, row: number, from: number, to = from + 4): Link {
  return { url, kind: 'url', segments: [{ row, from, to }], source: 'detected' }
}

interface Harness {
  mode: HintModeController
  hints: Hint[] | null
  opened: string[]
  modeChanges: boolean[]
}

function harness(links: Link[], viewport = { top: 0, bottom: 9 }): Harness {
  const h: Harness = { mode: null as never, hints: null, opened: [], modeChanges: [] }
  const host: HintModeHost = {
    linksInViewport: () => links,
    viewport: () => viewport,
    cols: () => COLS,
    setHints: (hints) => {
      h.hints = hints
    },
    openLink: (url) => h.opened.push(url),
    notifyMode: (active) => h.modeChanges.push(active),
  }
  h.mode = new HintModeController(host)
  return h
}

const key = (k: string, mods: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, ...mods })

describe('hint mode', () => {
  it('labels every link on screen and says it is on', () => {
    const h = harness([link('https://a.example', 0, 2), link('https://b.example', 3, 5)])
    h.mode.enter()
    expect(h.mode.isActive()).toBe(true)
    expect(h.hints).toEqual([
      { label: 'a', row: 0, col: 2, url: 'https://a.example', kind: 'url' },
      { label: 's', row: 3, col: 5, url: 'https://b.example', kind: 'url' },
    ])
    expect(h.modeChanges).toEqual([true])
  })

  it('opens the link whose label is typed, and leaves', () => {
    const h = harness([link('https://a.example', 0, 2), link('https://b.example', 3, 5)])
    h.mode.enter()
    expect(h.mode.handleKey(key('s'))).toBe(true)
    expect(h.opened).toEqual(['https://b.example'])
    expect(h.mode.isActive()).toBe(false)
    // Nothing left painted, and the frontend told the mode is over.
    expect(h.hints).toBeNull()
    expect(h.modeChanges).toEqual([true, false])
  })

  it('takes two keystrokes when there are more links than letters', () => {
    const many: Link[] = []
    for (let i = 0; i < 30; i++) many.push(link(`https://${i}.example`, i % 10, 0))
    const h = harness(many)
    h.mode.enter()
    expect(h.hints?.[0].label).toBe('aa')
    expect(h.hints?.[28].label).toBe('sd')

    // The first key narrows rather than opening: `a` is a prefix, not a label.
    expect(h.mode.handleKey(key('a'))).toBe(true)
    expect(h.opened).toEqual([])
    expect(h.hints).toHaveLength(26)
    expect(h.mode.handleKey(key('d'))).toBe(true)
    expect(h.opened).toEqual(['https://2.example'])
  })

  it('backspaces out of a half-typed label', () => {
    const many: Link[] = []
    for (let i = 0; i < 30; i++) many.push(link(`https://${i}.example`, i % 10, 0))
    const h = harness(many)
    h.mode.enter()
    h.mode.handleKey(key('a'))
    expect(h.hints).toHaveLength(26)
    expect(h.mode.handleKey(key('Backspace'))).toBe(true)
    expect(h.hints).toHaveLength(30)
    expect(h.opened).toEqual([])
  })

  /** A typo costs one key, not the label so far. */
  it('ignores a key that matches no label without losing the prefix', () => {
    const many: Link[] = []
    for (let i = 0; i < 30; i++) many.push(link(`https://${i}.example`, i % 10, 0))
    const h = harness(many)
    h.mode.enter()
    // Thirty links: `s` heads only four labels, so `sg` names nothing.
    h.mode.handleKey(key('s'))
    expect(h.hints).toHaveLength(4)
    expect(h.mode.handleKey(key('g'))).toBe(true)
    expect(h.hints).toHaveLength(4)
    expect(h.mode.handleKey(key('d'))).toBe(true)
    expect(h.opened).toEqual(['https://28.example'])
  })

  it('gives everything back on Escape', () => {
    const h = harness([link('https://a.example', 0, 2)])
    h.mode.enter()
    expect(h.mode.handleKey(key('Escape'))).toBe(true)
    expect(h.mode.isActive()).toBe(false)
    expect(h.hints).toBeNull()
    expect(h.opened).toEqual([])
  })

  /** Typing is what the mode suspends: a stray keystroke reaching the shell
   *  while the user believes they are picking a link is how this does damage. */
  it('swallows printable keys that name no label', () => {
    const h = harness([link('https://a.example', 0, 2)])
    h.mode.enter()
    expect(h.mode.handleKey(key('1'))).toBe(true)
    expect(h.mode.handleKey(key('/'))).toBe(true)
    expect(h.opened).toEqual([])
  })

  /** The app's own shortcuts have to keep working — including the chord that
   *  opened the mode, which is therefore also the one that closes it. */
  it('passes modified keys through', () => {
    const h = harness([link('https://a.example', 0, 2)])
    h.mode.enter()
    expect(h.mode.handleKey(key('u', { ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(h.mode.handleKey(key('t', { altKey: true }))).toBe(false)
    expect(h.mode.handleKey(key('ArrowDown'))).toBe(false)
  })

  it('claims nothing at all while it is off', () => {
    const h = harness([link('https://a.example', 0, 2)])
    expect(h.mode.handleKey(key('a'))).toBe(false)
    expect(h.mode.handleKey(key('Escape'))).toBe(false)
  })

  /** Entering with nothing to label still enters: an indicator with no labels
   *  under it says "there are no links here", where a chord that silently did
   *  nothing would be indistinguishable from a broken binding. */
  it('enters with no links on screen', () => {
    const h = harness([])
    h.mode.enter()
    expect(h.mode.isActive()).toBe(true)
    expect(h.hints).toEqual([])
    expect(h.mode.handleKey(key('Escape'))).toBe(true)
  })

  it('labels the first row of a wrapped link that is actually on screen', () => {
    const wrapped: Link = {
      url: 'https://long.example/path',
      kind: 'url',
      segments: [
        { row: 2, from: 10, to: 19 },
        { row: 3, from: 0, to: 4 },
      ],
      source: 'detected',
    }
    // The viewport starts below the link's own first row.
    const h = harness([wrapped], { top: 3, bottom: 9 })
    h.mode.enter()
    expect(h.hints).toEqual([{ label: 'a', row: 3, col: 0, url: 'https://long.example/path', kind: 'url' }])
  })

  /** A label half off the right edge names nothing. */
  it('pulls a label back from the right margin', () => {
    const h = harness([link('https://a.example', 0, COLS - 1, COLS - 1)])
    h.mode.enter()
    expect(h.hints?.[0].col).toBe(COLS - 1)

    const many: Link[] = []
    for (let i = 0; i < 30; i++) many.push(link(`https://${i}.example`, i % 10, COLS - 1, COLS - 1))
    const wide = harness(many)
    wide.mode.enter()
    // Two-character labels need the last two columns.
    expect(wide.hints?.[0].col).toBe(COLS - 2)
  })

  it('cancels when something else takes over', () => {
    const h = harness([link('https://a.example', 0, 2)])
    h.mode.enter()
    h.mode.cancel()
    expect(h.mode.isActive()).toBe(false)
    expect(h.hints).toBeNull()
    expect(h.modeChanges).toEqual([true, false])
  })
})
