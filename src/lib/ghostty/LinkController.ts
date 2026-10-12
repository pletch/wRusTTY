import { findPaths, type PathFlavor } from '../pathDetect'
import { findUrls } from '../urlDetect'
import { logicalLines, segmentsFor, type Segment } from './logicalLines'
import type { RowText } from './rowText'
import type { Point } from './SelectionController'

/**
 * Which cells are a link, and what they point at. Answers what's under a cell
 * and what's on screen; Ctrl+click and hint mode are both built on that.
 */

/**
 * Where a link came from. Only `'detected'` is produced today; OSC 8 would be
 * a second producer for this same path. The distinction matters: an OSC 8
 * link's text is arbitrary, so it must disclose its real target before
 * opening.
 */
export type LinkSource = 'detected' | 'osc8'

/**
 * What a link points at. A `'url'` goes to the platform opener behind
 * `isOpenableUrl`; a `'path'` never reaches the opener and is shown in the
 * files panel. Separate at the type so neither can pass for the other.
 */
export type LinkKind = 'url' | 'path'

export interface Link {
  /** The URL, or for a `'path'` link the path as written. */
  url: string
  kind: LinkKind
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
  /** A call, since a resize reflows every row. */
  cols(): number
  /** Whether to detect file paths too, and in which syntax. Only panes with
   *  somewhere to send one ask; absent or null means no. */
  pathLinks?(): PathFlavor | null
}

/**
 * How far outside the viewport a logical line is chased, so a URL crossing
 * the edge isn't cut in half (half a URL still opens). Bounded, since output
 * without newlines can make the whole scrollback one line.
 */
const WRAP_CHASE_ROWS = 32

export class LinkController {
  private readonly host: LinkHost

  /** Links for the cached window, or null when nothing has been parsed. */
  private cached: Link[] | null = null
  /** Buffer generation, viewport top and width at build time. */
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

  /** Drops the cache, for teardown or a buffer change that doesn't bump the
   *  generation. */
  invalidate(): void {
    this.cached = null
    this.cacheKey = ''
  }

  /**
   * The links in the current window, parsed at most once per
   * viewport/generation. Not the whole buffer: links are only activated on
   * screen.
   */
  private links(): Link[] {
    const top = this.host.viewportY()
    const paths = this.host.pathLinks?.() ?? null
    const key = `${this.host.bufferGen()}:${top}:${this.host.cols()}:${paths}`
    if (this.cached !== null && key === this.cacheKey) return this.cached

    const parsed = this.parse(top, paths)
    this.cached = parsed
    this.cacheKey = key
    return parsed
  }

  private parse(top: number, paths: PathFlavor | null): Link[] {
    const total = this.host.totalRows()
    if (total <= 0) return []
    const viewTop = Math.max(0, Math.min(top, total - 1))
    const viewBottom = Math.min(total - 1, viewTop + this.host.rows() - 1)

    // Widen to hold whole logical lines, reading the flags once.
    const lo = Math.max(0, viewTop - WRAP_CHASE_ROWS)
    const hi = Math.min(total - 1, viewBottom + WRAP_CHASE_ROWS)
    const flags = this.host.readWrapFlags(lo, hi)

    // Back to the start of the first row's line. If the chase runs out, the
    // partial line is treated as its own, as the user sees it.
    let from = viewTop
    while (from > lo && flags[from - lo]) from--
    // Forward to the end of the line the viewport's last row belongs to.
    let to = viewBottom
    while (to < hi && flags[to + 1 - lo]) to++

    const rows = this.host.readRows(from, to)
    const lines = logicalLines(rows, flags.slice(from - lo, to - lo + 1), from)

    const out: Link[] = []
    for (const line of lines) {
      const found: { start: number; end: number; url: string; kind: LinkKind }[] = findUrls(
        line.text,
      ).map((m) => ({ ...m, kind: 'url' }))
      if (paths) {
        const urls = found.slice()
        for (const m of findPaths(line.text, paths)) {
          // The URL wins over a path inside it.
          if (urls.some((u) => m.start < u.end && m.end > u.start)) continue
          found.push({ start: m.start, end: m.end, url: m.path, kind: 'path' })
        }
        // Reading order, which is how hint mode assigns labels.
        found.sort((a, b) => a.start - b.start)
      }
      for (const match of found) {
        // `end` is half-open; `segmentsFor` takes an inclusive last character.
        const segments = segmentsFor(line, match.start, match.end - 1)
        if (segments.length === 0) continue
        // A chased-in link must have some cell on screen.
        if (!segments.some((s) => s.row >= viewTop && s.row <= viewBottom)) continue
        out.push({ url: match.url, kind: match.kind, segments, source: 'detected' })
      }
    }
    return out
  }
}
