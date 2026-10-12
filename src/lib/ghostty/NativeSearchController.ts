import type { SearchOptions, SearchResult } from '../terminalEngine'
import type { SearchHighlight } from './WebGLRenderer'
import type { GhosttyWasm } from './wasmBindings'
import * as abi from './main/abi'

/**
 * Find-in-scrollback done by the core, through `ghostty_search_*`.
 *
 * Unlike the JS `SearchController`, the core tracks matches against the live
 * screens, so resizes, alternate-screen round trips and scrollback pruning
 * don't leave stale results. But it can't do regex or case-sensitive matching,
 * so those queries stay on the JS path. See `docs/NATIVE_SEARCH_PLAN.md`.
 *
 * Rules this API imposes:
 *
 * 1. **Matches are snapshots.** Returned selections hold untracked grid refs,
 *    valid only until the next terminal write, so nothing is cached across
 *    frames: feed, read, convert to plain row numbers.
 * 2. **Feeding is required.** The search only sees changes when fed; `onFrame`
 *    feeds while a query is live.
 * 3. **Single-threaded.** Work is bounded per frame by ticking;
 *    `ghostty_search_run` (blocking) is for tests and probes only.
 */

/** What the controller needs from the engine. */
export interface NativeSearchHost {
  /** Hand the renderer the highlights (or `null`) and mark the view dirty. */
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
  /** Grid height, to notice a resize (which a feed must reconcile). */
  rows(): number
}

/** How long one frame may spend ticking; a long search continues on later
 *  frames (the count climbs) instead of freezing the pane. */
const TICK_BUDGET_MS = 3

/** Initial match buffer size; grown on demand from the reported count. */
const INITIAL_MATCH_CAPACITY = 64

export class NativeSearchController {
  private readonly ex: abi.GhosttyMainExports
  private readonly host: NativeSearchHost
  private readonly handle: number
  /** The terminal the search is bound to, for `point_from_grid_ref`. */
  private readonly term: number

  /** Scratch out-parameters, allocated once (`ghostty_wasm_alloc` aligns them). */
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
  /** Whether anything is selected; the core selects nothing on its own. */
  private selected = false
  /** What the last `refresh` drew, so a still pane does no work. */
  private signature = ''
  /**
   * What the terminal looked like at the last feed. A feed costs ~0.7 ms on a
   * 10,000-row scrollback, so it's skipped unless there's new output or a
   * resize.
   */
  private fedAt = ''
  /**
   * Where the viewport was when the query was typed, or -1 once the selection
   * has settled. The scan runs newest to oldest across frames, so each frame
   * steps the selection further back toward this row as matches are found.
   */
  private anchorTop = -1
  /** The last tick's status. Anything but COMPLETE forces another feed, or a
   *  search that ran out of frame budget would never resume. */
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

    // Selecting must not move the core's viewport, since the renderer's offset
    // is ours; we scroll via `revealRow` (which parks the hit a third down).
    const scroll = ex.ghostty_wasm_alloc(4)
    this.dv().setUint32(scroll, abi.SEARCH_SCROLL_NONE, true)
    ex.ghostty_search_set(handle, abi.SEARCH_OPT_SELECT_SCROLL, scroll)
    ex.ghostty_wasm_free(scroll, 4)
  }

  /**
   * A controller over a live terminal, or null when the binary has no search
   * API (v1.3.1); the engine then uses the JS controller.
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

  /** Re-created only when memory growth detached the previous one. */
  private dv(): DataView {
    if (this.view.buffer !== this.ex.memory.buffer) {
      this.view = new DataView(this.ex.memory.buffer)
    }
    return this.view
  }

  /**
   * Runs or advances a search, on every incremental keystroke and on
   * next/previous. Re-submitting the same needle keeps existing results.
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
      // A fresh query starts from what the user is looking at: the first match
      // at or after the top of the viewport (as on the JS path).
      this.anchorTop = this.host.viewportY()
      this.selected = this.stepTowardAnchor()
    } else if (!options?.incremental) {
      // The user took over; drop the anchor.
      this.anchorTop = -1
      // We count oldest-first, so "next" is the core's SELECT_PREV.
      this.select(options?.back ? abi.SEARCH_OPT_SELECT_NEXT : abi.SEARCH_OPT_SELECT_PREV)
    }

    this.refresh(true)
  }

  /**
   * Per-frame upkeep while a query is live: picks up new output, follows the
   * viewport on scroll, and continues a long scan.
   */
  onFrame(): void {
    if (!this.query) return
    this.pump(false)
    if (this.anchorTop >= 0) {
      // Still converging on the anchor; forced, since the signature can't see a
      // selection that moved without the count changing.
      this.stepTowardAnchor()
      this.refresh(true)
      return
    }
    this.refresh(false)
  }

  /** Drops the needle and highlights; the core releases its tracked state. */
  clear(): void {
    if (this.query) {
      // A NULL value clears the needle.
      this.ex.ghostty_search_set(this.handle, abi.SEARCH_OPT_NEEDLE, 0)
    }
    this.query = ''
    this.selected = false
    this.anchorTop = -1
    this.signature = ''
    this.fedAt = ''
    this.status = abi.SEARCH_STATUS_COMPLETE
    this.host.setHighlights(null)
  }

  /** Frees the search (safe in either order against freeing the terminal). */
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
    // The callee copies the bytes.
    abi.expectOk(
      this.ex.ghostty_search_set(this.handle, abi.SEARCH_OPT_NEEDLE, this.strSlot),
      'search_set needle',
    )
  }

  /** Feeds once, then ticks until caught up or out of time. */
  private pump(force: boolean): void {
    const { ex } = this
    // Feed on new output or a resize (a scroll only needs a redraw; see
    // `buildHighlights`), and always when `search()` forces it.
    const state = `${this.host.bufferGen()}:${this.host.cols()}x${this.host.rows()}`
    if (force || state !== this.fedAt || this.status !== abi.SEARCH_STATUS_COMPLETE) {
      this.fedAt = state
      if (ex.ghostty_search_feed(this.handle) !== abi.GHOSTTY_SUCCESS) return
    }

    const deadline = performance.now() + TICK_BUDGET_MS
    for (;;) {
      if (ex.ghostty_search_tick(this.handle, this.statusSlot) !== abi.GHOSTTY_SUCCESS) return
      this.status = this.dv().getUint32(this.statusSlot, true)
      // FEED_REQUIRED waits for the next frame's feed; COMPLETE is caught up.
      if (this.status !== abi.SEARCH_STATUS_RUNNING) return
      if (performance.now() >= deadline) return
    }
  }

  /** Moves the selection; false when there's nothing to select. */
  private select(option: number): boolean {
    return this.ex.ghostty_search_set(this.handle, option, 0) === abi.GHOSTTY_SUCCESS
  }

  /**
   * Steps the selection back toward `anchorTop`: the oldest match at or after
   * the top of the viewport. The core only has SELECT_NEXT/PREV (the first NEXT
   * selects the newest match), so the target index is found by binary search in
   * the newest-to-oldest match list and stepped to. Re-run each frame while the
   * anchor is live, since the list grows as the scan proceeds.
   */
  private stepTowardAnchor(): boolean {
    const total = this.queryCapacity(abi.SEARCH_DATA_MATCHES)
    if (total === 0) return this.selected
    this.ensureMatchCapacity(total)
    const written = this.fillMatches(abi.SEARCH_DATA_MATCHES, this.matchCap)
    if (written === 0) return this.selected

    // First index whose row is above the anchor; the one before it is wanted.
    let lo = 0
    let hi = written
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const y = this.startRowOf(mid)
      if (y === null || y >= this.anchorTop) lo = mid + 1
      else hi = mid
    }
    // Every match so far is above the anchor: fall back to the newest.
    const target = lo === 0 ? 0 : lo - 1

    // Until COMPLETE, a target at the end of the list may not be final; keep
    // the anchor and retry next frame.
    if (this.status === abi.SEARCH_STATUS_COMPLETE || target < written - 1) this.anchorTop = -1

    let ok = this.selected
    const current = this.selected ? (this.readUsize(abi.SEARCH_DATA_SELECTED_INDEX) ?? 0) : -1
    for (let i = current; i < target; i++) {
      ok = this.select(abi.SEARCH_OPT_SELECT_NEXT)
      if (!ok) break
    }
    return ok
  }

  private readUsize(data: number): number | null {
    const rc = this.ex.ghostty_search_get(this.handle, data, this.usizeSlot)
    if (rc !== abi.GHOSTTY_SUCCESS) return null
    return this.dv().getUint32(this.usizeSlot, true)
  }

  /** Absolute (screen) coordinates of a grid ref, or null if pruned since the
   *  feed. */
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
   * Reads the current state and redraws. `force` (from `search()`) always
   * repaints; otherwise an unchanged signature skips the work.
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

    // Newest-first upstream, oldest-first in the find bar.
    const rawIndex = this.readUsize(abi.SEARCH_DATA_SELECTED_INDEX)
    const index = rawIndex === null ? -1 : count - 1 - rawIndex

    const active = this.readSelectedMatch()
    if (force && active) this.host.revealRow(active.startY)
    this.host.setHighlights(this.buildHighlights(active))
    this.host.emit({ index, count })
  }

  /** The selected match in absolute coordinates, or null. */
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
    // Endpoints may be in either order.
    if (end.y < start.y || (end.y === start.y && end.x < start.x)) {
      return { startY: end.y, startX: end.x, endY: start.y, endX: start.x }
    }
    return { startY: start.y, startX: start.x, endY: end.y, endX: end.x }
  }

  /**
   * Highlights for the rows actually on screen. Not `VIEWPORT_MATCHES`, which is
   * relative to the core's viewport (which never moves here, since our offset
   * drives the renderer). `MATCHES` is ordered newest to oldest, so the visible
   * window is a binary search plus a short walk.
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

    // First entry at or above the bottom row (rows descend with the index).
    let lo = 0
    let hi = written
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const y = this.startRowOf(mid)
      if (y === null || y > bottom) lo = mid + 1
      else hi = mid
    }

    // Walk older until matches leave the top; slack catches matches wrapping
    // across the window edge.
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
      // A wrapped match highlights its part of each row.
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

  /** The start row of match `i`, or null if the screen can't express it. */
  private startRowOf(i: number): number | null {
    return this.toScreen(this.matchBuf + i * abi.SELECTION_SIZE + abi.SELECTION_OFF_START)?.y ?? null
  }

  /** How many entries a buffer read needs. Returns `GHOSTTY_OUT_OF_SPACE`, so it
   *  doesn't use `expectOk`. */
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

  /** Fills `matchBuf` and returns the count; each element needs its `size`. */
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
