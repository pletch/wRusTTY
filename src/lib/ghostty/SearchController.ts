import type { SearchOptions, SearchResult } from '../terminalEngine'
import type { SearchHighlight } from './WebGLRenderer'
import type { RowText } from './rowText'
import { logicalLines, segmentsFor, type Segment } from './logicalLines'

/**
 * Find-in-scrollback, extracted from `GhosttyEngine`.
 *
 * The engine had grown to ~2,000 lines and ~55 fields covering WASM
 * lifecycle, WebGL context loss, mouse tracking, selection, OSC dispatch,
 * clipboard, search, cursor blink and viewport maths in one object. The
 * concern boundaries were already visible in the field names — these four
 * (`searchMatches`, `searchIndex`, `searchSignature`, `searchGen`) plus
 * `findMatches` and `applySearchHighlights` only ever talked to each other.
 *
 * What's left behind on the engine is what genuinely belongs to it: reading
 * rows out of WASM linear memory, the wrap flags, the viewport, and the
 * handler set that is part of its public interface.
 */

/** One search hit. `row`/`from`/`to` are its head, which is all a match that
 *  does not wrap ever needs; `segments` is every row it covers, so a hit
 *  across a wrapped line highlights on each of them while still counting
 *  once. */
export interface SearchMatch {
  row: number
  from: number
  to: number
  segments: Segment[]
}

/**
 * What the controller needs from the engine.
 *
 * Deliberately narrow, and deliberately not the engine itself: everything
 * here is either a read of buffer state or a request to move/repaint the
 * view, which is the whole of what searching is allowed to do.
 */
export interface SearchHost {
  /** Absolute rows `from..to` inclusive. */
  readRows(from: number, to: number): RowText[]
  /** Which absolute rows continue the row above them. */
  readWrapFlags(total: number): boolean[]
  /** Total absolute rows: scrollback plus the active screen. A call rather
   *  than a property so the host can hand over plain arrow functions — these
   *  are live reads, and a snapshot taken at construction would be wrong by
   *  the first keystroke. */
  scrollbackLength(): number
  /** Bumped on every write. Cache key for the match list, together with the
   *  query — this is what stops incremental search re-reading ten thousand
   *  rows on every keystroke. */
  bufferGen(): number
  /** Hand the renderer the highlights to draw, or `null` for none. Also
   *  responsible for marking the view dirty. */
  setHighlights(byRow: Map<number, SearchHighlight[]> | null): void
  /** Absolute row at the top of the viewport. */
  viewportY(): number
  /** Scroll the least amount that brings `row` into view. */
  revealRow(row: number): void
  /** Report the current match index and total to the frontend. */
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

  // A plain field rather than a parameter property: `erasableSyntaxOnly`
  // is on, and a parameter property emits code rather than erasing.
  constructor(host: SearchHost) {
    this.host = host
  }

  /**
   * Runs or advances a search.
   *
   * Called on every keystroke of an incremental search as well as on
   * next/previous, so the common case has to be cheap — hence the
   * signature/generation check before any row is read.
   */
  search(query: string, options?: SearchOptions): void {
    if (!query) {
      this.clear()
      return
    }

    const flags = `g${options?.caseSensitive ? '' : 'i'}`
    const pattern = options?.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const signature = `${pattern} ${flags}`

    // A throwing regex is the user halfway through typing one, not an error
    // worth clearing the view for.
    let re: RegExp
    try {
      re = new RegExp(pattern, flags)
    } catch {
      this.reset()
      return
    }

    // Rebuilt only when the query or the buffer moved. Incremental search fires
    // on every keystroke, and re-reading ten thousand rows per keystroke is the
    // difference between usable and not.
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
      // Opening on a fresh query starts from what is on screen rather than from
      // the top of a scrollback the user may be nowhere near.
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

  /** Drops the matches and the highlights, and forgets the query — so the
   *  next search re-reads even if it repeats the last one. */
  clear(): void {
    this.matches = []
    this.index = -1
    this.signature = ''
    this.host.setHighlights(null)
  }

  /** No matches, but the query is kept: this is "nothing found for what you
   *  typed", not "search is over". */
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
      // Every row the match covers, not just its head: a match across a wrap
      // is one hit but two or more highlights.
      for (const seg of this.matches[i].segments) {
        let list = byRow.get(seg.row)
        if (!list) byRow.set(seg.row, (list = []))
        list.push({ from: seg.from, to: seg.to, active: i === this.index })
      }
    }
    this.host.setHighlights(byRow)
  }

  /**
   * Matches over *logical* lines, not visual rows.
   *
   * A wrapped line is several rows on screen but one line of text, and
   * searching row by row missed anything straddling the wrap. That used to be
   * unavoidable: the core answered `is_row_wrapped` only for the active screen,
   * so a hit that had scrolled into history could not be reassembled. Our own
   * shim now exports the scrollback form too, so rows are joined into the line
   * they belong to before matching. The join itself lives in `logicalLines`,
   * shared with link detection — two ideas of what a line is would be two
   * answers within a week.
   *
   * A match still highlights per row — it has to, the rows are apart on screen
   * — so each carries the segments it covers, while navigation treats it as the
   * single hit it is.
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
          // A pattern that can match nothing would otherwise spin here.
          re.lastIndex++
          continue
        }
        const segments = segmentsFor(line, m.index, m.index + m[0].length - 1)
        if (segments.length === 0) continue
        // The head doubles as the match's own position, so reveal and ordering
        // keep working on matches that never wrap.
        out.push({ ...segments[0], segments })
      }
    }
    return out
  }
}
