/**
 * The ghostty `main` C ABI, as constants and types.
 *
 * This is the target of the port described in `docs/PORT_GHOSTTY_MAIN.md`, not
 * yet the ABI the app talks to — `../wasmBindings.ts` still is. Nothing here
 * imports from there or is imported by it, so the two can coexist until the
 * read path moves over.
 *
 * Pinned to ghostty-org/ghostty @ 48d85eaeb06ac9fc49073815bda5bac97de655ca.
 * Every value below is transcribed from that commit's headers and exercised
 * against that commit's binary by `main/abi.parity.test.ts`. Re-pinning means
 * re-checking: the export surface moved from 187 to 202 in the weeks before it.
 *
 * Where `main` replaces one of our named getters with a key, the old name is
 * given so the mapping stays greppable from both directions.
 */

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

/** `GhosttyResult`. Anything non-zero is a failure. */
export const GHOSTTY_SUCCESS = 0
export const GHOSTTY_OUT_OF_MEMORY = -1
export const GHOSTTY_INVALID_VALUE = -2
/**
 * Returned when a lookup is well-formed but has no answer — e.g. a scrollback
 * cell asked for in viewport coordinates. Distinct from INVALID_VALUE, and the
 * difference matters: one is a bug, the other is an ordinary miss.
 */
export const GHOSTTY_NO_VALUE = -3

/* -------------------------------------------------------------------------- */
/* Points and grid references                                                  */
/* -------------------------------------------------------------------------- */

/** `GhosttyPointTag`. */
export const POINT_TAG_ACTIVE = 0
export const POINT_TAG_VIEWPORT = 1
export const POINT_TAG_SCREEN = 2
export const POINT_TAG_HISTORY = 3

/**
 * `GhosttyPoint` layout, wasm32 — **not** what the header reads as.
 *
 * `point.h` declares `{ tag; value }` over `{ uint16_t x; uint32_t y; }`, which
 * on a 4-aligned target looks like `x@+4, y@+8`. It is not: the union carries an
 * 8-aligned member, so `value` begins at +8. Verified by probing offsets against
 * known grid content — see `docs/PORT_GHOSTTY_MAIN.md`.
 *
 * Getting this wrong is silent. The coordinates land in each other's fields and
 * you read a real cell from entirely the wrong place; the tell is `y=1`
 * returning column 1 of row 0.
 *
 * The struct is passed **by pointer** despite being by-value in C.
 */
export const POINT_SIZE = 16
export const POINT_OFF_TAG = 0
export const POINT_OFF_X = 8
export const POINT_OFF_Y = 12

/**
 * `GhosttyGridRef` layout, wasm32: `{ size_t size; void *node; uint16_t x, y; }`.
 *
 * It lives in caller memory, which is the whole performance story of the search
 * path: a row is walked by writing `x` and calling `grid_ref_cell` again, rather
 * than resolving a fresh point per cell. Resolution is O(scrollback depth) —
 * 14 ns at row 0, 188 ns at row 39,540 — so one resolve per row is affordable
 * and one per cell is 9x.
 */
export const GRID_REF_SIZE = 12
export const GRID_REF_OFF_SIZE = 0
export const GRID_REF_OFF_NODE = 4
export const GRID_REF_OFF_X = 8
export const GRID_REF_OFF_Y = 10

/* -------------------------------------------------------------------------- */
/* Cells                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `GhosttyCell` is a `uint64_t`, not an opaque handle — the whole cell
 * bit-cast, identical to `ROW_CELLS_DATA_RAW`. So it can be unpacked in JS
 * instead of queried field by field, which is worth 1.7x on a scrollback walk.
 *
 * It is passed to `ghostty_cell_get` **by value**: in the wasm ABI that is a
 * single i64 argument, so JS must hand it over as a BigInt.
 */
export const CELL_U64_BYTES = 8

/** Low 2 bits of the packed cell are the content tag; the codepoint follows. */
export const CELL_CONTENT_TAG_MASK = 0x3
export const CELL_CODEPOINT_SHIFT = 2
export const CELL_CODEPOINT_MASK = 0x1fffff

/**
 * Unpack a codepoint from the low word of a packed cell.
 *
 * Takes the low 32 bits rather than the u64 because the codepoint occupies bits
 * 2..22 and therefore never crosses the word boundary — which keeps this off
 * BigInt entirely. BigInt in the per-cell loop costs more than the WASM call it
 * would be saving.
 */
export function codepointOf(lo: number): number {
  return (lo >>> CELL_CODEPOINT_SHIFT) & CELL_CODEPOINT_MASK
}

/** `GhosttyCellContentTag`. */
export const CELL_CONTENT_CODEPOINT = 0
export const CELL_CONTENT_CODEPOINT_GRAPHEME = 1
export const CELL_CONTENT_BG_COLOR_PALETTE = 2
export const CELL_CONTENT_BG_COLOR_RGB = 3

/** `GhosttyCellWide`. */
export const CELL_WIDE_NARROW = 0
export const CELL_WIDE_WIDE = 1
export const CELL_WIDE_SPACER_TAIL = 2
export const CELL_WIDE_SPACER_HEAD = 3

/** `GhosttyCellData` — keys for `ghostty_cell_get`. */
export const CELL_DATA_CODEPOINT = 1
export const CELL_DATA_CONTENT_TAG = 2
export const CELL_DATA_WIDE = 3
export const CELL_DATA_HAS_TEXT = 4
export const CELL_DATA_HAS_STYLING = 5
export const CELL_DATA_STYLE_ID = 6
export const CELL_DATA_HAS_HYPERLINK = 7
export const CELL_DATA_PROTECTED = 8
export const CELL_DATA_SEMANTIC_CONTENT = 9
export const CELL_DATA_COLOR_PALETTE = 10
export const CELL_DATA_COLOR_RGB = 11

/** `GhosttyRowData` — keys for `ghostty_row_get`. */
export const ROW_DATA_WRAP = 1
export const ROW_DATA_WRAP_CONTINUATION = 2
export const ROW_DATA_GRAPHEME = 3
export const ROW_DATA_STYLED = 4
export const ROW_DATA_HYPERLINK = 5
export const ROW_DATA_SEMANTIC_PROMPT = 6
export const ROW_DATA_KITTY_VIRTUAL_PLACEHOLDER = 7
export const ROW_DATA_DIRTY = 8

/* -------------------------------------------------------------------------- */
/* Render state                                                                */
/* -------------------------------------------------------------------------- */

/** `GhosttyRenderStateData` — keys for `ghostty_render_state_get`. */
export const RS_DATA_COLS = 1 // was render_state_get_cols
export const RS_DATA_ROWS = 2 // was render_state_get_rows
export const RS_DATA_DIRTY = 3
/**
 * Yields the row iterator. `get` wants the **slot holding the handle**, not the
 * handle: `render.zig` does `const it = out.* orelse ...` and populates what the
 * slot points at. Passing the handle returns INVALID_VALUE.
 */
export const RS_DATA_ROW_ITERATOR = 4
export const RS_DATA_COLOR_BACKGROUND = 5 // was render_state_get_bg_color
export const RS_DATA_COLOR_FOREGROUND = 6 // was render_state_get_fg_color
export const RS_DATA_COLOR_CURSOR = 7
export const RS_DATA_COLOR_CURSOR_HAS_VALUE = 8
export const RS_DATA_COLOR_PALETTE = 9
export const RS_DATA_CURSOR_VISUAL_STYLE = 10 // was render_state_get_cursor_style
export const RS_DATA_CURSOR_VISIBLE = 11 // was render_state_get_cursor_visible
export const RS_DATA_CURSOR_BLINKING = 12 // was render_state_get_cursor_blinking
export const RS_DATA_CURSOR_PASSWORD_INPUT = 13
export const RS_DATA_CURSOR_VIEWPORT_HAS_VALUE = 14
export const RS_DATA_CURSOR_VIEWPORT_X = 15 // was render_state_get_cursor_x
export const RS_DATA_CURSOR_VIEWPORT_Y = 16 // was render_state_get_cursor_y
export const RS_DATA_CURSOR_VIEWPORT_WIDE_TAIL = 17

/** `GhosttyRenderStateDirty`. */
export const RS_DIRTY_FALSE = 0
export const RS_DIRTY_PARTIAL = 1
export const RS_DIRTY_FULL = 2

/** `GhosttyRenderStateCursorVisualStyle` (DECSCUSR). */
export const RS_CURSOR_BAR = 0
export const RS_CURSOR_BLOCK = 1
export const RS_CURSOR_UNDERLINE = 2
export const RS_CURSOR_BLOCK_HOLLOW = 3

/** `GhosttyRenderStateOption` / `...RowOption` — keys for the `set` calls. */
export const RS_OPTION_DIRTY = 0
/**
 * Per-row dirty is cleared by the **consumer**. `render_state_update` sets it
 * and nothing resets it, so unless every row read is cleared through
 * `row_set(iter, ROW_OPTION_DIRTY, false)`, every row reads dirty from the
 * second frame on and a dirty-rows-only pass quietly becomes a full one.
 * `render_state_set(state, DIRTY, false)` is a different flag and will not do it.
 */
export const RS_ROW_OPTION_DIRTY = 0

/** `GhosttyRenderStateRowData` — keys for `ghostty_render_state_row_get`. */
export const RS_ROW_DATA_DIRTY = 1 // was render_state_is_row_dirty
export const RS_ROW_DATA_RAW = 2
export const RS_ROW_DATA_CELLS = 3
export const RS_ROW_DATA_SELECTION = 4

/** `GhosttyRenderStateRowCellsData` — keys for `..._row_cells_get`. */
export const RS_CELLS_RAW = 1
export const RS_CELLS_STYLE = 2
export const RS_CELLS_GRAPHEMES_LEN = 3 // was render_state_get_grapheme
export const RS_CELLS_GRAPHEMES_BUF = 4 // ...and its buffer half
export const RS_CELLS_BG_COLOR = 5
export const RS_CELLS_FG_COLOR = 6
export const RS_CELLS_SELECTED = 7
export const RS_CELLS_HAS_STYLING = 8
export const RS_CELLS_GRAPHEMES_UTF8 = 9

/* -------------------------------------------------------------------------- */
/* Terminal                                                                    */
/* -------------------------------------------------------------------------- */

/** `GhosttyTerminalData` — keys for `ghostty_terminal_get`. */
export const T_DATA_COLS = 1
export const T_DATA_ROWS = 2
export const T_DATA_CURSOR_X = 3
export const T_DATA_CURSOR_Y = 4
export const T_DATA_CURSOR_PENDING_WRAP = 5
export const T_DATA_ACTIVE_SCREEN = 6 // was terminal_is_alternate_screen
export const T_DATA_CURSOR_VISIBLE = 7
export const T_DATA_KITTY_KEYBOARD_FLAGS = 8
export const T_DATA_SCROLLBAR = 9
export const T_DATA_CURSOR_STYLE = 10
export const T_DATA_MOUSE_TRACKING = 11 // was terminal_has_mouse_tracking
export const T_DATA_TITLE = 12
export const T_DATA_PWD = 13
export const T_DATA_TOTAL_ROWS = 14
export const T_DATA_SCROLLBACK_ROWS = 15 // was terminal_get_scrollback_length
export const T_DATA_COLOR_FOREGROUND = 18
export const T_DATA_COLOR_BACKGROUND = 19
export const T_DATA_COLOR_CURSOR = 20
export const T_DATA_COLOR_PALETTE = 21
export const T_DATA_SELECTION = 31
export const T_DATA_VIEWPORT_ACTIVE = 32
export const T_DATA_VT_PROCESSING_ERROR = 33
export const T_DATA_SCROLLBACK_MAX_BYTES = 34
export const T_DATA_SCROLLBACK_MAX_LINES = 35

/**
 * `GhosttyTerminalOption` — keys for `ghostty_terminal_set`.
 *
 * The effect callbacks (`OPT_WRITE_PTY` and friends) are the model change in
 * this port: `vt_write` by default *ignores* sequences that have side effects or
 * require responses, so until these are registered the grid renders correctly
 * and device-attribute and status queries silently go unanswered. That is the
 * worst failure shape in the whole move — it looks like it works.
 */
export const T_OPT_USERDATA = 0
/** Replaces `terminal_has_response` / `terminal_read_response`. */
export const T_OPT_WRITE_PTY = 1
export const T_OPT_BELL = 2
export const T_OPT_ENQUIRY = 3
export const T_OPT_XTVERSION = 4
export const T_OPT_TITLE_CHANGED = 5
export const T_OPT_SIZE = 6
export const T_OPT_COLOR_SCHEME = 7
export const T_OPT_DEVICE_ATTRIBUTES = 8
export const T_OPT_TITLE = 9
export const T_OPT_PWD = 10
export const T_OPT_COLOR_FOREGROUND = 11
export const T_OPT_COLOR_BACKGROUND = 12
export const T_OPT_COLOR_CURSOR = 13
export const T_OPT_COLOR_PALETTE = 14
export const T_OPT_SELECTION = 21
/**
 * Between them these are why `terminal_last_reset_seq` and
 * `terminal_last_cursor_style_seq` are expected to become unnecessary: the core
 * holds the configured default across a RIS, so the host no longer has to order
 * a reset against the application setting its own cursor.
 */
export const T_OPT_DEFAULT_CURSOR_STYLE = 22
export const T_OPT_DEFAULT_CURSOR_BLINK = 23
export const T_OPT_PWD_CHANGED = 25
export const T_OPT_CLIPBOARD_WRITE = 26
/**
 * Both scrollback caps bind independently. Setting only MAX_LINES left 456 rows
 * of a requested 10,000 at 200 columns, byte-pruned — set both.
 *
 * Note MAX_LINES is new relative to our ABI, where the only control was a byte
 * budget that reads like a row count. That trap shipped as a bug twice; see
 * `vendor/README.md`.
 */
export const T_OPT_SCROLLBACK_MAX_BYTES = 27
export const T_OPT_SCROLLBACK_MAX_LINES = 28
export const T_OPT_DESKTOP_NOTIFICATION = 29
export const T_OPT_PROGRESS_REPORT = 30

/** `active_screen` values for `T_DATA_ACTIVE_SCREEN`. */
export const SCREEN_PRIMARY = 0
export const SCREEN_ALTERNATE = 1

/* -------------------------------------------------------------------------- */
/* Export surface                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The subset of `main`'s 202 exports this port needs. Deliberately not the whole
 * surface: an export listed here is one we have a use for and have checked the
 * signature of, which is the property that made the current `wasmBindings.ts`
 * worth trusting.
 */
export interface GhosttyMainExports {
  memory: WebAssembly.Memory

  /* allocation */
  ghostty_wasm_alloc_u8_array(len: number): number
  ghostty_wasm_free_u8_array(ptr: number, len: number): void
  ghostty_wasm_alloc_usize(): number
  ghostty_wasm_free_usize(ptr: number): void
  ghostty_wasm_alloc_opaque(): number
  ghostty_wasm_free_opaque(ptr: number): void

  /* terminal lifecycle. Note the four-argument constructor: no options struct,
   * and scrollback is a `set` option rather than a constructor argument. */
  ghostty_terminal_new(alloc: number, resultSlot: number, cols: number, rows: number): number
  ghostty_terminal_free(term: number): void
  ghostty_terminal_resize(term: number, cols: number, rows: number): number
  ghostty_terminal_reset(term: number): number
  /**
   * Returns **void**, not a `GhosttyResult` — unlike almost everything else
   * here. Processing failures are reported out-of-band through
   * `T_DATA_VT_PROCESSING_ERROR`, which is what that key is for. Do not wrap
   * this in `expectOk`: it will compare `undefined` against 0 and throw on a
   * write that succeeded.
   */
  ghostty_terminal_vt_write(term: number, ptr: number, len: number): void

  /* generic accessors */
  ghostty_terminal_get(term: number, key: number, out: number): number
  ghostty_terminal_get_multi(term: number, n: number, keys: number, values: number, written: number): number
  ghostty_terminal_set(term: number, key: number, value: number): number
  ghostty_terminal_mode_get(term: number, mode: number, isAnsi: number, out: number): number
  ghostty_terminal_mode_set(term: number, mode: number, isAnsi: number, value: number): number
  ghostty_terminal_scroll_viewport(term: number, tag: number, delta: number): number

  /* render state */
  ghostty_render_state_new(alloc: number, slot: number): number
  ghostty_render_state_free(state: number): void
  ghostty_render_state_update(state: number, term: number): number
  ghostty_render_state_get(state: number, key: number, out: number): number
  ghostty_render_state_get_multi(state: number, n: number, keys: number, values: number, written: number): number
  ghostty_render_state_set(state: number, key: number, value: number): number
  ghostty_render_state_colors_get(state: number, key: number, out: number): number

  /* row iteration */
  ghostty_render_state_row_iterator_new(alloc: number, slot: number): number
  ghostty_render_state_row_iterator_free(iter: number): void
  ghostty_render_state_row_iterator_next(iter: number): number
  ghostty_render_state_row_get(iter: number, key: number, out: number): number
  ghostty_render_state_row_get_multi(iter: number, n: number, keys: number, values: number, written: number): number
  ghostty_render_state_row_set(iter: number, key: number, value: number): number

  /* cell iteration within a row */
  ghostty_render_state_row_cells_new(alloc: number, slot: number): number
  ghostty_render_state_row_cells_free(cells: number): void
  ghostty_render_state_row_cells_next(cells: number): number
  ghostty_render_state_row_cells_get(cells: number, key: number, out: number): number
  ghostty_render_state_row_cells_get_multi(cells: number, n: number, keys: number, values: number, written: number): number

  /* grid references — the scrollback and hyperlink path */
  ghostty_terminal_grid_ref(term: number, point: number, outRef: number): number
  ghostty_grid_ref_cell(ref: number, outCell: number): number
  ghostty_grid_ref_row(ref: number, outRow: number): number
  ghostty_grid_ref_graphemes(ref: number, buf: number, bufLen: number, outLen: number): number
  ghostty_grid_ref_hyperlink_uri(ref: number, buf: number, bufLen: number, outLen: number): number
  ghostty_grid_ref_style(ref: number, outStyle: number): number

  /** Takes the packed cell **by value** — an i64 argument, so pass a BigInt. */
  ghostty_cell_get(cell: bigint, key: number, out: number): number
  ghostty_row_get(row: bigint, key: number, out: number): number
}

/** Throws on any non-success result, naming the call. */
export function expectOk(result: number, what: string): void {
  if (result !== GHOSTTY_SUCCESS) {
    throw new Error(`${what} failed: GhosttyResult ${result}`)
  }
}
