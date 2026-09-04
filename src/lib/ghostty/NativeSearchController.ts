import type { SearchOptions, SearchResult } from '../terminalEngine'
import type { SearchHighlight } from './WebGLRenderer'
import type { GhosttyWasm } from './wasmBindings'
import * as abi from './main/abi'

/**
 * Find-in-scrollback done by the core, through `ghostty_search_*`.
 *
 * ## Why this exists next to `SearchController` rather than replacing it
 *
 * The JS controller reads the whole scrollback out of WASM on every query and
 * matches it here. That works, and it is wrong in ways it cannot fix: its
 * match list is keyed on a buffer generation, so a resize invalidates nothing
 * and leaves stale rows highlighted, an alternate-screen round trip (opening
 * and leaving `vim`) restarts it from nothing, and scrollback pruning silently
 * shifts every row index it is holding.
 *
 * The core has none of those problems — it tracks the matches against the live
 * screens and reconciles them on every feed — but it cannot do regex and has
 * no case-sensitive mode: `search.h` says matching is "byte-exact except ASCII
 * letters, which compare case-insensitively", and there is no option to change
 * that. Both of those are shipped toggles on our find bar.
 *
 * So the engine routes: plain case-insensitive queries come here, and the two
 * toggles keep the JS path. `docs/NATIVE_SEARCH_PLAN.md` is the long form of
 * that decision, including the alternative (drop the toggles) and why it is a
 * product call rather than a refactor.
 *
 * ## The three rules this API imposes that the JS one never had
 *
 * 1. **Matches are snapshots with a lifetime.** A returned `GhosttySelection`
 *    holds untracked grid refs, valid only until the next terminal write. So
 *    nothing here is cached across frames: every read is feed, read, use, and
 *    the row numbers that come out of it are converted to plain integers
 *    before anything else can write. Caching the match list — exactly what
 *    `SearchController` does — is not available.
 * 2. **Feeding is not optional.** The search only learns the terminal changed
 *    when it is fed, so an un-fed search reports stale counts while output
 *    keeps arriving. `onFrame` feeds while a query is live, which is also what
 *    refreshes `VIEWPORT_MATCHES` after the user scrolls.
 * 3. **We are single-threaded.** The tick/feed split exists so ghostty can
 *    tick on a background thread; we get from it only the ability to bound
 *    work per frame. `ghostty_search_run` would block until the whole
 *    scrollback is searched, so it is used by tests and probes and never here.
 */

/** What the controller needs from the engine — the same shape of favour the JS
 *  controller asks for, minus everything to do with reading rows, which is now
 *  the core's job. */
export interface NativeSearchHost {
  /** Hand the renderer the highlights to draw, or `null` for none. Also
   *  responsible for marking the view dirty. */
  setHighlights(byRow: Map<number, SearchHighlight[]> | null): void
  /** Scroll the least amount that brings absolute `row` into view. */
  revealRow(row: number): void
  /** Report the current match index and total to the frontend. */
  emit(result: SearchResult): void
  /** Absolute row at the top of the viewport, for noticing a scroll. */
  viewportY(): number
  /** Bumped on every write, for noticing new output. */
  bufferGen(): number
  /** Grid width, for the rows a multi-row match covers in full. */
  cols(): number
  /** Grid height. Only used to notice a resize, which is one of the things a
   *  feed exists to reconcile and the one thing that changes nothing else the
   *  gate below watches. */
  rows(): number
}

/** How long one frame may spend ticking before giving the frame back. Ticks are
 *  bounded internally too; this bounds how many of them run at once. A search
 *  that needs longer continues on the next frame — the count in the find bar
 *  climbs rather than the pane freezing. */
const TICK_BUDGET_MS = 3

/** Scratch big enough for the common case; grown on demand from the capacity
 *  the core reports. Viewport matches are page-scoped, so this is normally
 *  plenty and the two-call protocol never runs a second time. */
const INITIAL_MATCH_CAPACITY = 64

export class NativeSearchController {
  private readonly ex: abi.GhosttyMainExports
  private readonly host: NativeSearchHost
  private readonly handle: number
  /** The terminal the search is bound to. The search holds it too, but
   *  `point_from_grid_ref` is a terminal call and needs it here. */
  private readonly term: number

  /** Scratch, allocated once. Every one of these is a struct-shaped
   *  out-parameter; `ghostty_wasm_alloc` guarantees the alignment they need. */
  private readonly statusSlot: number
  private readonly usizeSlot: number
  private readonly selSlot: number
  private readonly bufSlot: number
  private readonly coordSlot: number
  private readonly strSlot: number
  private needleBuf = 0
  private needleCap = 0
  private matchBuf = 0
  private matchCap = 0

  private view: DataView
  private readonly encoder = new TextEncoder()

  /** The query the core is currently holding. Empty means idle. */
  private query = ''
  /** Whether anything is selected. The core selects nothing on its own — the
   *  first `SELECT_NEXT` is ours. */
  private selected = false
  /** What the last `refresh` drew, so a still pane does no work. */
  private signature = ''
  /**
   * What the terminal looked like at the last feed.
   *
   * A feed is bounded but not free — measured at 0.7 ms on a 10,000-row
   * scrollback, and it does not get cheaper with depth (`search.mjs`,
   * `native-feed`). Feeding on every frame regardless would spend that on a
   * pane where nothing whatever has happened, so this gates it on the two
   * things a feed exists to notice here: new output, and a resize.
   */
  private fedAt = ''
  /** The status the last tick reported. Anything but COMPLETE means the search
   *  still has work it cannot do without another feed, so the gate has to let
   *  one through even on a terminal that has not moved — otherwise a search
   *  that ran out of frame budget stops half-finished and never resumes. */
  private status = abi.SEARCH_STATUS_COMPLETE

  private constructor(
    ex: abi.GhosttyMainExports,
    handle: number,
    term: number,
    host: NativeSearchHost,
  ) {
    this.ex = ex
    this.handle = handle
    this.term = term
    this.host = host
    this.view = new DataView(ex.memory.buffer)

    this.statusSlot = ex.ghostty_wasm_alloc(4)
    this.usizeSlot = ex.ghostty_wasm_alloc(abi.USIZE_BYTES)
    this.selSlot = ex.ghostty_wasm_alloc(abi.SELECTION_SIZE)
    this.bufSlot = ex.ghostty_wasm_alloc(abi.SELECTION_BUFFER_SIZE)
    this.coordSlot = ex.ghostty_wasm_alloc(abi.POINT_COORDINATE_SIZE)
    this.strSlot = ex.ghostty_wasm_alloc(abi.STRING_SIZE)

    // Selecting a match must not move the core's viewport: the offset the
    // renderer draws from is ours (`_viewportOffset`), and a core-side scroll
    // would leave the two disagreeing about where the screen is. We do the
    // scrolling ourselves through `revealRow`, which also parks the hit a third
    // of the way down the way the JS path always has.
    const scroll = ex.ghostty_wasm_alloc(4)
    this.dv().setUint32(scroll, abi.SEARCH_SCROLL_NONE, true)
    ex.ghostty_search_set(handle, abi.SEARCH_OPT_SELECT_SCROLL, scroll)
    ex.ghostty_wasm_free(scroll, 4)
  }

  /**
   * A controller over a live terminal, or null when the binary has no search
   * API in it.
   *
   * Null is not an error: `instantiateGhosttyModule` can still land on the
   * v1.3.1 build, which predates the whole API. The engine reads it as "use the
   * JS controller", which it has to be able to do anyway for regex and
   * case-sensitive queries.
   */
  static create(wasm: GhosttyWasm, term: number, host: NativeSearchHost): NativeSearchController | null {
    const ex = wasm.instance.exports as unknown as abi.GhosttyMainExports
    if (typeof ex.ghostty_search_new !== 'function') return null
    if (typeof ex.ghostty_terminal_point_from_grid_ref !== 'function') return null
    const slot = ex.ghostty_wasm_alloc_opaque()
    const rc = ex.ghostty_search_new(0, slot, term)
    const ptr = new DataView(ex.memory.buffer).getUint32(slot, true)
    ex.ghostty_wasm_free_opaque(slot)
    if (rc !== abi.GHOSTTY_SUCCESS || ptr === 0) return null
    return new NativeSearchController(ex, ptr, term, host)
  }

  /** Re-made only when linear memory growth has detached the previous one. */
  private dv(): DataView {
    if (this.view.buffer !== this.ex.memory.buffer) {
      this.view = new DataView(this.ex.memory.buffer)
    }
    return this.view
  }

  /**
   * Runs or advances a search.
   *
   * Called on every keystroke of an incremental search as well as on
   * next/previous. Re-submitting the same needle is explicitly cheap in the
   * core — it keeps the existing results rather than restarting — so the
   * keystroke case costs a feed and a bounded tick.
   */
  search(query: string, options?: SearchOptions): void {
    if (!query) {
      this.clear()
      return
    }

    if (query !== this.query) {
      this.setNeedle(query)
      this.query = query
      this.selected = false
    }

    this.pump(true)

    if (!this.selected) {
      // Nothing selected yet, so this is a fresh query. `SELECT_NEXT` takes the
      // newest match — the bottom of the screen, working up into history —
      // which is the direction a search started at a prompt wants. The JS path
      // instead takes the first match at or after the top of the viewport;
      // this is the one deliberate behaviour difference between them.
      this.selected = this.select(abi.SEARCH_OPT_SELECT_NEXT)
    } else if (!options?.incremental) {
      // Ours counts oldest-first, so "next" moves toward newer content, which
      // is the core's SELECT_PREV. Getting this pair the wrong way round makes
      // the find bar walk backwards, which is why they are named here rather
      // than passed through.
      this.select(options?.back ? abi.SEARCH_OPT_SELECT_NEXT : abi.SEARCH_OPT_SELECT_PREV)
    }

    this.refresh(true)
  }

  /**
   * One frame's worth of upkeep, called from the render loop while a query is
   * live.
   *
   * This is what rule 2 above buys: output that arrives after the search was
   * set up still counts, the highlight list follows the viewport when the user
   * scrolls, and a scrollback deep enough to need several frames of ticking
   * fills in visibly rather than blocking the first one.
   */
  onFrame(): void {
    if (!this.query) return
    this.pump(false)
    this.refresh(false)
  }

  /** Drops the needle and the highlights. The core returns to idle and
   *  releases the tracked state it was holding inside the terminal. */
  clear(): void {
    if (this.query) {
      // A NULL value clears the needle; the search keeps its handle.
      this.ex.ghostty_search_set(this.handle, abi.SEARCH_OPT_NEEDLE, 0)
    }
    this.query = ''
    this.selected = false
    this.signature = ''
    this.fedAt = ''
    this.status = abi.SEARCH_STATUS_COMPLETE
    this.host.setHighlights(null)
  }

  /** Frees the search. Safe in either order against the terminal's own free —
   *  the core detaches rather than dangling — but doing it here first releases
   *  the state the search holds *inside* the terminal. */
  dispose(): void {
    this.ex.ghostty_search_free(this.handle)
  }

  /* ---------------------------------------------------------------------- */

  private setNeedle(query: string): void {
    const bytes = this.encoder.encode(query)
    if (bytes.length > this.needleCap) {
      if (this.needleBuf) this.ex.ghostty_wasm_free(this.needleBuf, this.needleCap)
      this.needleCap = Math.max(bytes.length, 64)
      this.needleBuf = this.ex.ghostty_wasm_alloc(this.needleCap)
    }
    new Uint8Array(this.ex.memory.buffer, this.needleBuf, bytes.length).set(bytes)
    const d = this.dv()
    d.setUint32(this.strSlot + abi.STRING_OFF_PTR, this.needleBuf, true)
    d.setUint32(this.strSlot + abi.STRING_OFF_LEN, bytes.length, true)
    // The bytes are copied by the callee, so the buffer above is free to be
    // overwritten by the next keystroke.
    abi.expectOk(
      this.ex.ghostty_search_set(this.handle, abi.SEARCH_OPT_NEEDLE, this.strSlot),
      'search_set needle',
    )
  }

  /** Feeds once, then ticks until caught up or out of time. */
  private pump(force: boolean): void {
    const { ex } = this
    // The feed is what notices new output, a scroll, a resize or a screen
    // switch — nothing else does. `search()` always forces one, because the
    // user has just asked a question and a stale answer is worse than the
    // work.
    // Not the viewport: nothing read here depends on where the core thinks
    // the screen is (see `buildHighlights`), so a scroll needs a redraw but
    // not a feed. Only new output and a resize do.
    const state = `${this.host.bufferGen()}:${this.host.cols()}x${this.host.rows()}`
    if (force || state !== this.fedAt || this.status !== abi.SEARCH_STATUS_COMPLETE) {
      this.fedAt = state
      if (ex.ghostty_search_feed(this.handle) !== abi.GHOSTTY_SUCCESS) return
    }

    const deadline = performance.now() + TICK_BUDGET_MS
    for (;;) {
      if (ex.ghostty_search_tick(this.handle, this.statusSlot) !== abi.GHOSTTY_SUCCESS) return
      this.status = this.dv().getUint32(this.statusSlot, true)
      // FEED_REQUIRED means ticking cannot make progress until the next feed,
      // which is the next frame. COMPLETE means caught up as of that feed.
      if (this.status !== abi.SEARCH_STATUS_RUNNING) return
      if (performance.now() >= deadline) return
    }
  }

  /** Moves the selection. False when the core says there is nothing to select,
   *  which is an ordinary answer for a query that matches nothing. */
  private select(option: number): boolean {
    return this.ex.ghostty_search_set(this.handle, option, 0) === abi.GHOSTTY_SUCCESS
  }

  private readUsize(data: number): number | null {
    const rc = this.ex.ghostty_search_get(this.handle, data, this.usizeSlot)
    if (rc !== abi.GHOSTTY_SUCCESS) return null
    return this.dv().getUint32(this.usizeSlot, true)
  }

  /** Absolute (screen) coordinates of a grid ref, or null for one the screen
   *  cannot express — a match evicted by scrollback pruning between the feed
   *  and this read. */
  private toScreen(refPtr: number): { x: number; y: number } | null {
    const rc = this.ex.ghostty_terminal_point_from_grid_ref(
      this.term,
      refPtr,
      abi.POINT_TAG_SCREEN,
      this.coordSlot,
    )
    if (rc !== abi.GHOSTTY_SUCCESS) return null
    const d = this.dv()
    return {
      x: d.getUint16(this.coordSlot + abi.POINT_COORDINATE_OFF_X, true),
      y: d.getUint32(this.coordSlot + abi.POINT_COORDINATE_OFF_Y, true),
    }
  }

  /**
   * Reads the current state and redraws from it.
   *
   * `force` is set by `search()`, which has just moved the selection and must
   * paint whatever the outcome was. `onFrame` passes false, and the signature
   * below turns a still pane into a handful of loads.
   */
  private refresh(force: boolean): void {
    const count = this.readUsize(abi.SEARCH_DATA_TOTAL_MATCHES) ?? 0
    const sig = `${count}:${this.host.viewportY()}:${this.host.bufferGen()}:${this.query}`
    if (!force && sig === this.signature) return
    this.signature = sig

    if (count === 0) {
      this.host.setHighlights(null)
      this.host.emit({ index: -1, count: 0 })
      return
    }

    // Newest-first upstream, oldest-first here. A find bar that renders
    // "index + 1 of count" would otherwise count down as the user walks
    // forward.
    const rawIndex = this.readUsize(abi.SEARCH_DATA_SELECTED_INDEX)
    const index = rawIndex === null ? -1 : count - 1 - rawIndex

    const active = this.readSelectedMatch()
    if (force && active) this.host.revealRow(active.startY)
    this.host.setHighlights(this.buildHighlights(active))
    this.host.emit({ index, count })
  }

  /** The selected match in absolute coordinates, or null when nothing is
   *  selected or it has been pruned away. */
  private readSelectedMatch(): { startY: number; startX: number; endY: number; endX: number } | null {
    this.dv().setUint32(this.selSlot + abi.SELECTION_OFF_SIZE, abi.SELECTION_SIZE, true)
    const rc = this.ex.ghostty_search_get(this.handle, abi.SEARCH_DATA_SELECTED_MATCH, this.selSlot)
    if (rc !== abi.GHOSTTY_SUCCESS) return null
    return this.spanOf(this.selSlot)
  }

  private spanOf(selPtr: number): { startY: number; startX: number; endY: number; endX: number } | null {
    const start = this.toScreen(selPtr + abi.SELECTION_OFF_START)
    const end = this.toScreen(selPtr + abi.SELECTION_OFF_END)
    if (!start || !end) return null
    // The endpoints are documented as being in either order.
    if (end.y < start.y || (end.y === start.y && end.x < start.x)) {
      return { startY: end.y, startX: end.x, endY: start.y, endX: start.x }
    }
    return { startY: start.y, startX: start.x, endY: end.y, endX: end.x }
  }

  /**
   * The highlights for the rows the pane is actually showing.
   *
   * **Not `VIEWPORT_MATCHES`, and that is the whole point of this comment.**
   * That field is relative to the *core's* viewport, and the core's viewport
   * never moves here: the offset the renderer draws from is ours, and the
   * search is set to `SEARCH_SCROLL_NONE` so that selecting a match does not
   * fight it. The first version of this used `VIEWPORT_MATCHES` and drew
   * nothing at all whenever the pane was scrolled back — which is precisely
   * where a search leaves you, so in practice it drew nothing whenever it
   * mattered. `nativeSearch.test.ts` pins the scrolled case now.
   *
   * `MATCHES` is the whole list and is ordered newest to oldest, so it is
   * sorted descending by row. That makes the visible window a binary search
   * plus a walk over the handful of matches inside it, rather than converting
   * every match on the screen's behalf — the conversion is the cost here, one
   * `point_from_grid_ref` per endpoint.
   */
  private buildHighlights(
    active: { startY: number; startX: number; endY: number; endX: number } | null,
  ): Map<number, SearchHighlight[]> | null {
    const total = this.queryCapacity(abi.SEARCH_DATA_MATCHES)
    if (total === 0) return null

    this.ensureMatchCapacity(total)
    const written = this.fillMatches(abi.SEARCH_DATA_MATCHES, this.matchCap)
    if (written === 0) return null

    const top = this.host.viewportY()
    const bottom = top + this.host.rows() - 1
    const cols = this.host.cols()
    const byRow = new Map<number, SearchHighlight[]>()

    // First entry whose row is at or above the bottom of the screen. Rows
    // descend with the index, so this is a lower_bound on a reversed order.
    let lo = 0
    let hi = written
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const y = this.startRowOf(mid)
      if (y === null || y > bottom) lo = mid + 1
      else hi = mid
    }

    // Then walk older until the matches drop off the top of the screen. The
    // slack either side is for a match that wraps across the boundary: its
    // head can sit outside the window while its tail is on screen.
    const SLACK = 2
    for (let i = Math.max(0, lo - SLACK); i < written; i++) {
      const span = this.spanOf(this.matchBuf + i * abi.SELECTION_SIZE)
      if (!span) continue
      if (span.endY < top - SLACK) break
      if (span.startY > bottom + SLACK) continue
      const isActive =
        active !== null &&
        span.startY === active.startY &&
        span.startX === active.startX &&
        span.endY === active.endY &&
        span.endX === active.endX
      // A match that crosses a wrap is one hit on several rows, and each row
      // gets the part of it that lands there. This is the whole of what
      // `logicalLines`/`segmentsFor` had to reconstruct on the JS path.
      for (let y = span.startY; y <= span.endY; y++) {
        const from = y === span.startY ? span.startX : 0
        const to = y === span.endY ? span.endX : cols - 1
        let list = byRow.get(y)
        if (!list) byRow.set(y, (list = []))
        list.push({ from, to, active: isActive })
      }
    }
    return byRow.size === 0 ? null : byRow
  }

  /** The start row of match `i`, for the search above. One conversion, and
   *  null for a match the screen can no longer express. */
  private startRowOf(i: number): number | null {
    return this.toScreen(this.matchBuf + i * abi.SELECTION_SIZE + abi.SELECTION_OFF_START)?.y ?? null
  }

  /** How many entries a buffer-valued read needs. The query answers
   *  `GHOSTTY_OUT_OF_SPACE` rather than success, so it deliberately does not
   *  go through `expectOk`. */
  private queryCapacity(data: number): number {
    const d = this.dv()
    d.setUint32(this.bufSlot + abi.SELECTION_BUFFER_OFF_PTR, 0, true)
    d.setUint32(this.bufSlot + abi.SELECTION_BUFFER_OFF_CAP, 0, true)
    d.setUint32(this.bufSlot + abi.SELECTION_BUFFER_OFF_LEN, 0, true)
    this.ex.ghostty_search_get(this.handle, data, this.bufSlot)
    return this.dv().getUint32(this.bufSlot + abi.SELECTION_BUFFER_OFF_LEN, true)
  }

  private ensureMatchCapacity(needed: number): void {
    if (needed <= this.matchCap) return
    if (this.matchBuf) this.ex.ghostty_wasm_free(this.matchBuf, this.matchCap * abi.SELECTION_SIZE)
    this.matchCap = Math.max(needed, INITIAL_MATCH_CAPACITY)
    this.matchBuf = this.ex.ghostty_wasm_alloc(this.matchCap * abi.SELECTION_SIZE)
  }

  /** Fills `matchBuf` and returns how many entries came back. Every element
   *  carries its own `size` field, which the core reads per element. */
  private fillMatches(data: number, cap: number): number {
    const d = this.dv()
    for (let i = 0; i < cap; i++) {
      d.setUint32(this.matchBuf + i * abi.SELECTION_SIZE + abi.SELECTION_OFF_SIZE, abi.SELECTION_SIZE, true)
    }
    d.setUint32(this.bufSlot + abi.SELECTION_BUFFER_OFF_PTR, this.matchBuf, true)
    d.setUint32(this.bufSlot + abi.SELECTION_BUFFER_OFF_CAP, cap, true)
    d.setUint32(this.bufSlot + abi.SELECTION_BUFFER_OFF_LEN, 0, true)
    if (this.ex.ghostty_search_get(this.handle, data, this.bufSlot) !== abi.GHOSTTY_SUCCESS) return 0
    return this.dv().getUint32(this.bufSlot + abi.SELECTION_BUFFER_OFF_LEN, true)
  }
}
