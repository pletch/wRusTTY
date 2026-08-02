import { findUrls } from '../urlDetect'
import { logicalLines, segmentsFor, type Segment } from './logicalLines'
import type { RowText } from './rowText'
import type { Point } from './SelectionController'

/**
 * Which cells are a link, and what they point at.
 *
 * The third controller of this shape, after `SelectionController` and
 * `MarkModeController`: a narrow host interface, no DOM of its own, and its
 * own tests. It answers two questions — what is under this cell, and what is
 * on screen — and both the pointer path (Ctrl+click) and the keyboard path
 * (hint mode) are built on those answers rather than on detection of their
 * own.
 */

/**
 * Where a link came from.
 *
 * Only `'detected'` is ever produced today. It is carried from the start
 * because OSC 8 — a program declaring a URI for a run of cells — belongs as a
 * second *producer* feeding this same hit-testing, hover and activation path,
 * not as a parallel system beside it. The distinction is load-bearing rather
 * than decorative: an OSC 8 link's display text is arbitrary and may read
 * `https://your-bank.com` while pointing elsewhere, so it has to disclose its
 * true target before opening, while a detected link is its own text and needs
 * no such disclosure.
 */
export type LinkSource = 'detected' | 'osc8'

export interface Link {
  url: string
  /** Every row the link covers; more than one when it crosses a wrap. */
  segments: Segment[]
  source: LinkSource
}

/** What the controller needs from the engine. */
export interface LinkHost {
  /** Absolute rows `from..to` inclusive. */
  readRows(from: number, to: number): RowText[]
  /** Which of the absolute rows `from..to` continue the row above them. */
  readWrapFlags(from: number, to: number): boolean[]
  /** Absolute row at the top of the viewport. */
  viewportY(): number
  /** Viewport height in rows. */
  rows(): number
  /** Total absolute rows: scrollback plus the active screen. */
  totalRows(): number
  /** Bumped on every write; part of the cache key. */
  bufferGen(): number
  /** Live read — a value snapshotted at construction is wrong after a resize,
   *  and a resize reflows every row. */
  cols(): number
}

/**
 * How far outside the viewport a logical line is chased.
 *
 * A URL can begin on the row above the viewport's first, or run onto the row
 * below its last, and a line cut at the viewport edge would detect half a URL
 * — worse than none, since half a URL still opens. Bounded because "join
 * until the wrapping stops" is unbounded in principle: a program that never
 * emits a newline makes the whole scrollback one logical line, and chasing
 * that on hover is the one way this feature becomes expensive.
 */
const WRAP_CHASE_ROWS = 32

export class LinkController {
  private readonly host: LinkHost

  /** Links for the cached window, or null when nothing has been parsed. */
  private cached: Link[] | null = null
  /** What the cache was built against: buffer generation, viewport top and
   *  width. A scroll changes which rows are in the window, a write changes
   *  what they hold, and a resize reflows every one of them. */
  private cacheKey = ''

  constructor(host: LinkHost) {
    this.host = host
  }

  /** The link under an absolute buffer position, or null. */
  linkAt(pos: Point): Link | null {
    for (const link of this.links()) {
      for (const seg of link.segments) {
        if (seg.row === pos.y && pos.x >= seg.from && pos.x <= seg.to) return link
      }
    }
    return null
  }

  /** Every link with at least one cell on screen — hint mode's input. */
  linksInViewport(): Link[] {
    return this.links()
  }

  /** Drops the cache. For teardown and for anything that changes the buffer
   *  without bumping the generation the key is built from. */
  invalidate(): void {
    this.cached = null
    this.cacheKey = ''
  }

  /**
   * The links in the current window, parsed at most once per
   * viewport/generation.
   *
   * Deliberately **not** over the whole buffer. Search reads `0..total-1`
   * because a search is *for* the scrollback; a link is only ever activated
   * where the pointer is or where a label is painted, both of which are on
   * screen. Reading ten thousand rows to answer "what is under the cursor" is
   * the one change that would make this expensive.
   */
  private links(): Link[] {
    const top = this.host.viewportY()
    const key = `${this.host.bufferGen()}:${top}:${this.host.cols()}`
    if (this.cached !== null && key === this.cacheKey) return this.cached

    const parsed = this.parse(top)
    this.cached = parsed
    this.cacheKey = key
    return parsed
  }

  private parse(top: number): Link[] {
    const total = this.host.totalRows()
    if (total <= 0) return []
    const viewTop = Math.max(0, Math.min(top, total - 1))
    const viewBottom = Math.min(total - 1, viewTop + this.host.rows() - 1)

    // Widen far enough to hold whole logical lines, then read the flags once
    // for the widened range so both ends can be resolved from the same read.
    const lo = Math.max(0, viewTop - WRAP_CHASE_ROWS)
    const hi = Math.min(total - 1, viewBottom + WRAP_CHASE_ROWS)
    const flags = this.host.readWrapFlags(lo, hi)

    // Back to the start of the line the viewport's first row belongs to. If the
    // chase runs out, the window simply starts mid-line — `logicalLines` does
    // not honour a leading continuation flag, so the partial line is treated as
    // its own, which is the same thing the user can see.
    let from = viewTop
    while (from > lo && flags[from - lo]) from--
    // Forward to the end of the line the viewport's last row belongs to.
    let to = viewBottom
    while (to < hi && flags[to + 1 - lo]) to++

    const rows = this.host.readRows(from, to)
    const lines = logicalLines(rows, flags.slice(from - lo, to - lo + 1), from)

    const out: Link[] = []
    for (const line of lines) {
      for (const match of findUrls(line.text)) {
        // `end` is half-open; `segmentsFor` takes an inclusive last character.
        const segments = segmentsFor(line, match.start, match.end - 1)
        if (segments.length === 0) continue
        // A link chased in from outside the window is only interesting if some
        // of it is on screen — nothing can point at or label a row nobody can
        // see, and hint mode would otherwise hand out labels for them.
        if (!segments.some((s) => s.row >= viewTop && s.row <= viewBottom)) continue
        out.push({ url: match.url, segments, source: 'detected' })
      }
    }
    return out
  }
}
