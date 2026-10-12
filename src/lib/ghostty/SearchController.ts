import type { SearchOptions, SearchResult } from '../terminalEngine'
import type { SearchHighlight } from './WebGLRenderer'
import type { RowText } from './rowText'
import { logicalLines, segmentsFor, type Segment } from './logicalLines'

/**
 * Find-in-scrollback, extracted from `GhosttyEngine`. The engine keeps row
 * reads, wrap flags and the viewport; this owns the match list and
 * highlights.
 */

/** One search hit. `row`/`from`/`to` are its head; `segments` covers every
 *  row, so a hit across a wrap highlights on each while counting once. */
export interface SearchMatch {
  row: number
  from: number
  to: number
  segments: Segment[]
}

/**
 * What the controller needs from the engine: buffer reads, and requests to
 * move or repaint the view.
 */
export interface SearchHost {
  /** Absolute rows `from..to` inclusive. */
  readRows(from: number, to: number): RowText[]
  /** Which absolute rows continue the row above them. */
  readWrapFlags(total: number): boolean[]
  /** Total absolute rows: scrollback plus the active screen. A call, since it
   *  changes with every write. */
  scrollbackLength(): number
  /** Bumped on every write; with the query, the match list's cache key. */
  bufferGen(): number
  /** Sets the highlights (or `null`) and marks the view dirty. */
  setHighlights(byRow: Map<number, SearchHighlight[]> | null): void
  /** Absolute row at the top of the viewport. */
  viewportY(): number
  /** Scrolls the least amount that brings `row` into view. */
  revealRow(row: number): void
  /** Reports the current match index and total to the frontend. */
  emit(result: SearchResult): void
}

export class SearchController {
  private matches: SearchMatch[] = []
  private index = -1
  /** The query the current `matches` were found for. */
  private signature = ''
  /** The `bufferGen` they were found against. */
  private gen = -1

  private readonly host: SearchHost

  // A plain field: `erasableSyntaxOnly` forbids parameter properties.
  constructor(host: SearchHost) {
    this.host = host
  }

  /**
   * Runs or advances a search. Called on every incremental keystroke, so the
   * signature/generation check comes before any row is read.
   */
  search(query: string, options?: SearchOptions): void {
    if (!query) {
      this.clear()
      return
    }

    const flags = `g${options?.caseSensitive ? '' : 'i'}`
    const pattern = options?.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const signature = `${pattern} ${flags}`

    // A throwing regex is one being typed, not an error worth clearing for.
    let re: RegExp
    try {
      re = new RegExp(pattern, flags)
    } catch {
      this.reset()
      return
    }

    // Rebuilt only when the query or buffer changed.
    if (signature !== this.signature || this.gen !== this.host.bufferGen()) {
      this.signature = signature
      this.gen = this.host.bufferGen()
      this.matches = this.findMatches(re)
      this.index = -1
    }

    const count = this.matches.length
    if (count === 0) {
      this.reset()
      return
    }

    if (this.index < 0) {
      // A fresh query starts from what's on screen, not the top of scrollback.
      const firstVisible = this.host.viewportY()
      const at = this.matches.findIndex((m) => m.row >= firstVisible)
      this.index = at === -1 ? count - 1 : at
    } else if (!options?.incremental) {
      this.index = options?.back ? (this.index - 1 + count) % count : (this.index + 1) % count
    } else if (this.index >= count) {
      this.index = 0
    }

    this.host.revealRow(this.matches[this.index].row)
    this.applyHighlights()
    this.host.emit({ index: this.index, count })
  }

  /** Drops matches, highlights and the query, so the next search re-reads. */
  clear(): void {
    this.matches = []
    this.index = -1
    this.signature = ''
    this.host.setHighlights(null)
  }

  /** No matches, but the query is kept ("nothing found", not "done"). */
  private reset(): void {
    this.matches = []
    this.index = -1
    this.applyHighlights()
    this.host.emit({ index: -1, count: 0 })
  }

  private applyHighlights(): void {
    if (this.matches.length === 0) {
      this.host.setHighlights(null)
      return
    }
    const byRow = new Map<number, SearchHighlight[]>()
    for (let i = 0; i < this.matches.length; i++) {
      // Every row the match covers, not just its head.
      for (const seg of this.matches[i].segments) {
        let list = byRow.get(seg.row)
        if (!list) byRow.set(seg.row, (list = []))
        list.push({ from: seg.from, to: seg.to, active: i === this.index })
      }
    }
    this.host.setHighlights(byRow)
  }

  /**
   * Matches over logical lines, so hits straddling a wrap are found, in the
   * scrollback too. The join lives in `logicalLines`, shared with link
   * detection. Each match carries its per-row segments for highlighting, while
   * navigation treats it as one hit.
   */
  private findMatches(re: RegExp): SearchMatch[] {
    const total = this.host.scrollbackLength()
    const rows = this.host.readRows(0, total - 1)
    const wrapped = this.host.readWrapFlags(rows.length)
    const out: SearchMatch[] = []

    for (const line of logicalLines(rows, wrapped)) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line.text)) !== null) {
        if (m[0].length === 0) {
          // An empty match would otherwise spin.
          re.lastIndex++
          continue
        }
        const segments = segmentsFor(line, m.index, m.index + m[0].length - 1)
        if (segments.length === 0) continue
        // The head doubles as the match's position for reveal and ordering.
        out.push({ ...segments[0], segments })
      }
    }
    return out
  }
}
