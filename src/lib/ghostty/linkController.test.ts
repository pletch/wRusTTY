import { describe, it, expect } from 'vitest'
import { LinkController, type LinkHost } from './LinkController'
import type { RowText } from './rowText'

/**
 * Hit-testing, against a stub buffer.
 *
 * The controller's own job is small — detection is `urlDetect`'s and the join
 * is `logicalLines`' — so what is worth pinning here is the part that is
 * neither: which rows it reads, which it refuses to read, and when it reads
 * them again.
 */

const COLS = 20

function row(text: string): RowText {
  const padded = text.padEnd(COLS, ' ').slice(0, COLS)
  const colStart = new Int32Array(COLS + 1)
  for (let i = 0; i <= COLS; i++) colStart[i] = i
  return { text: padded, colStart }
}

interface Stub {
  host: LinkHost
  /** Absolute rows handed to `readRows`, in call order. */
  reads: [number, number][]
  gen: number
  top: number
}

/** A buffer of `lines`, each `[text, continuesTheRowAbove]`. */
function stub(lines: [string, boolean][], viewportRows: number, viewportY = 0): Stub {
  const s: Stub = {
    reads: [],
    gen: 0,
    top: viewportY,
    host: {
      readRows: (from, to) => {
        s.reads.push([from, to])
        const out: RowText[] = []
        for (let r = from; r <= to; r++) out.push(row(lines[r]?.[0] ?? ''))
        return out
      },
      readWrapFlags: (from, to) => {
        const out: boolean[] = []
        for (let r = from; r <= to; r++) out.push(lines[r]?.[1] ?? false)
        return out
      },
      viewportY: () => s.top,
      rows: () => viewportRows,
      totalRows: () => lines.length,
      bufferGen: () => s.gen,
      cols: () => COLS,
    },
  }
  return s
}

describe('LinkController', () => {
  it('finds a link on a plain row and reports the cells it covers', () => {
    const s = stub([['go https://a.example', false]], 1)
    const link = new LinkController(s.host).linkAt({ x: 5, y: 0 })
    expect(link).toMatchObject({ url: 'https://a.example', source: 'detected' })
    expect(link?.segments).toEqual([{ row: 0, from: 3, to: 19 }])
  })

  it('answers null off the end of a link and on a row with none', () => {
    const c = new LinkController(stub([['go https://a.example', false], ['plain text', false]], 2).host)
    expect(c.linkAt({ x: 2, y: 0 })).toBeNull()
    expect(c.linkAt({ x: 5, y: 1 })).toBeNull()
  })

  /** The case row-at-a-time detection gets wrong: one link, two rows. */
  it('joins a link across a wrap and covers both rows', () => {
    const s = stub([
      ['x https://example.co', false],
      ['m/deep/path here', true],
    ], 2)
    const link = new LinkController(s.host).linkAt({ x: 3, y: 1 })
    expect(link?.url).toBe('https://example.com/deep/path')
    expect(link?.segments).toEqual([
      { row: 0, from: 2, to: 19 },
      { row: 1, from: 0, to: 10 },
    ])
  })

  /** A link whose head is above the viewport still has to be a link on the row
   *  that is on screen — the alternative is half a URL, which still opens. */
  it('chases a line back above the viewport to find its start', () => {
    const s = stub([
      ['x https://example.co', false],
      ['m/tail rest', true],
    ], 1, 1)
    const link = new LinkController(s.host).linkAt({ x: 2, y: 1 })
    expect(link?.url).toBe('https://example.com/tail')
    // The row above was read even though it is off screen.
    expect(s.reads[0][0]).toBe(0)
  })

  /** Scoped to the viewport: reading the whole buffer to answer "what is under
   *  the cursor" is the one way this feature becomes expensive. */
  it('does not read the whole buffer', () => {
    const lines: [string, boolean][] = []
    for (let i = 0; i < 5000; i++) lines.push([`row ${i} https://a.example`, false])
    const s = stub(lines, 24, 4000)
    new LinkController(s.host).linksInViewport()
    const [from, to] = s.reads[0]
    expect(from).toBeGreaterThanOrEqual(4000 - 32)
    expect(to).toBeLessThanOrEqual(4000 + 24 + 32)
  })

  it('lists only links with a cell on screen', () => {
    const lines: [string, boolean][] = [
      ['https://off.example', false],
      ['https://on.example', false],
      ['https://below.example', false],
    ]
    const s = stub(lines, 1, 1)
    expect(new LinkController(s.host).linksInViewport().map((l) => l.url)).toEqual([
      'https://on.example',
    ])
  })

  it('parses once and reuses the result until the buffer or viewport moves', () => {
    const s = stub([['https://a.example', false], ['https://b.example', false]], 2)
    const c = new LinkController(s.host)
    c.linkAt({ x: 0, y: 0 })
    c.linkAt({ x: 1, y: 0 })
    c.linksInViewport()
    expect(s.reads).toHaveLength(1)

    s.gen++
    c.linkAt({ x: 0, y: 0 })
    expect(s.reads).toHaveLength(2)

    s.top = 1
    c.linkAt({ x: 0, y: 1 })
    expect(s.reads).toHaveLength(3)

    c.invalidate()
    c.linkAt({ x: 0, y: 1 })
    expect(s.reads).toHaveLength(4)
  })

  it('offers nothing on an empty buffer', () => {
    const s = stub([], 24)
    expect(new LinkController(s.host).linksInViewport()).toEqual([])
    expect(s.reads).toHaveLength(0)
  })

  /** Detection's rules are `urlDetect`'s, but they have to survive the trip
   *  through the join — a homograph host is not a link on screen either. */
  it('does not offer a deceptive host as a link', () => {
    const s = stub([['go https://аpple.com/x', false]], 1)
    expect(new LinkController(s.host).linkAt({ x: 5, y: 0 })).toBeNull()
  })

  describe('paths', () => {
    it('offers none unless the host asks for them', () => {
      const s = stub([['cat /etc/hosts', false]], 1)
      expect(new LinkController(s.host).linksInViewport()).toEqual([])
    })

    it('offers them, marked as paths, when it does', () => {
      const s = stub([['cat /etc/hosts', false]], 1)
      s.host.pathLinks = () => 'posix'
      const link = new LinkController(s.host).linkAt({ x: 6, y: 0 })
      expect(link).toMatchObject({ url: '/etc/hosts', kind: 'path' })
      expect(link?.segments).toEqual([{ row: 0, from: 4, to: 13 }])
    })

    it('lets a URL win over the path inside it', () => {
      const s = stub([['https://a.ex/b/c', false]], 1)
      s.host.pathLinks = () => 'posix'
      const links = new LinkController(s.host).linksInViewport()
      expect(links.map((l) => [l.kind, l.url])).toEqual([['url', 'https://a.ex/b/c']])
    })

    it('reparses when the setting changes', () => {
      const s = stub([['cat /etc/hosts', false]], 1)
      let on = false
      s.host.pathLinks = () => (on ? 'posix' : null)
      const c = new LinkController(s.host)
      expect(c.linksInViewport()).toEqual([])
      on = true
      expect(c.linksInViewport()).toHaveLength(1)
    })
  })
})
