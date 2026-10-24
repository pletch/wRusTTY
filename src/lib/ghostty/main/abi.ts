/**
 * The ghostty `main` C ABI, as constants and types; see
 * `docs/PORT_GHOSTTY_MAIN.md`.
 *
 * Pinned to ghostty-org/ghostty @ 8ef0ec1238220a5a714be452ed2844f0691fcf83.
 * Values are transcribed from that commit's headers, exercised against its
 * binary by `main/abi.parity.test.ts`, and struct layouts are checked against
 * the binary by `main/abi.manifest.test.ts`. Re-pinning means re-checking; a
 * falling export count is usually upstream consolidation, not a broken build.
 *
 * Where `main` replaces one of our named getters with a key, the old name is
 * noted so the mapping is greppable.
 */

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

/** `GhosttyResult`. Anything non-zero is a failure. */
export const GHOSTTY_SUCCESS = 0
export const GHOSTTY_OUT_OF_MEMORY = -1
export const GHOSTTY_INVALID_VALUE = -2
/** The caller's buffer was too small; the call also writes the size it
 *  needed, so grow and retry (see `KeyEncoder.encode`). */
export const GHOSTTY_OUT_OF_SPACE = -3
/**
 * A well-formed lookup with no answer (e.g. a scrollback cell asked for in
 * viewport coordinates): an ordinary miss, unlike INVALID_VALUE. Note -4, not
 * -3 (-3 is OUT_OF_SPACE).
 */
export const GHOSTTY_NO_VALUE = -4

/* -------------------------------------------------------------------------- */
/* Points and grid references                                                  */
/* -------------------------------------------------------------------------- */

/** `GhosttyPointTag`. */
export const POINT_TAG_ACTIVE = 0
export const POINT_TAG_VIEWPORT = 1
export const POINT_TAG_SCREEN = 2
export const POINT_TAG_HISTORY = 3

/**
 * `GhosttyPoint` layout, wasm32: **not** what the header reads as. The union
 * carries an 8-aligned member, so `value` begins at +8 and the struct is 24
 * bytes. Getting it wrong is silent (coordinates land in each other's fields).
 * Passed by pointer despite being by-value in C. Asserted by
 * `abi.manifest.test.ts`.
 */
export const POINT_SIZE = 24
export const POINT_OFF_TAG = 0
export const POINT_OFF_X = 8
export const POINT_OFF_Y = 12

/**
 * `GhosttyGridRef` layout, wasm32: `{ size_t size; void *node; uint16_t x, y; }`.
 * It lives in caller memory, so a row is walked by rewriting `x` rather than
 * resolving a point per cell; resolution is O(scrollback depth).
 */
export const GRID_REF_SIZE = 12
export const GRID_REF_OFF_SIZE = 0
export const GRID_REF_OFF_NODE = 4
export const GRID_REF_OFF_X = 8
export const GRID_REF_OFF_Y = 10

/* -------------------------------------------------------------------------- */
/* Selections and search                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `GhosttySelection`: a pair of grid refs and a rectangle flag; native search
 * matches come back as this. A sized struct: write `SELECTION_SIZE` into the
 * first word, including in every element of a `GhosttySelectionBuffer`.
 * Endpoints are inclusive, in either order, and untracked (valid only until the
 * next terminal write).
 */
export const SELECTION_SIZE = 32
export const SELECTION_OFF_SIZE = 0
export const SELECTION_OFF_START = 4
export const SELECTION_OFF_END = 16
export const SELECTION_OFF_RECTANGLE = 28

/**
 * `GhosttySelectionBuffer`: `{ GhosttySelection *ptr; size_t cap; size_t len; }`.
 * Two-call protocol: `ptr = 0, cap = 0` returns `GHOSTTY_OUT_OF_SPACE` with the
 * required count in `len`; then allocate and call again.
 */
export const SELECTION_BUFFER_SIZE = 12
export const SELECTION_BUFFER_OFF_PTR = 0
export const SELECTION_BUFFER_OFF_CAP = 4
export const SELECTION_BUFFER_OFF_LEN = 8

/** `GhosttyString` — a borrowed `{ const uint8_t *ptr; size_t len; }`. The
 *  needle is copied by the callee, so the buffer need not outlive the call. */
export const STRING_SIZE = 8
export const STRING_OFF_PTR = 0
export const STRING_OFF_LEN = 4

/**
 * `GhosttyPointCoordinate`: `{ uint16_t x; uint32_t y; }`, so `y` is at +4. The
 * out-parameter of `point_from_grid_ref`; not the same type as `GhosttyPoint`.
 */
export const POINT_COORDINATE_SIZE = 8
export const POINT_COORDINATE_OFF_X = 0
export const POINT_COORDINATE_OFF_Y = 4

/** `GhosttySearchStatus`. `COMPLETE` means caught up as of the last feed. */
export const SEARCH_STATUS_RUNNING = 0
export const SEARCH_STATUS_FEED_REQUIRED = 1
export const SEARCH_STATUS_COMPLETE = 2

/** `GhosttySearchOption`. The two select options take a NULL value. */
export const SEARCH_OPT_NEEDLE = 0
export const SEARCH_OPT_SELECT_NEXT = 1
export const SEARCH_OPT_SELECT_PREV = 2
export const SEARCH_OPT_SELECT_SCROLL = 3

/**
 * `GhosttySearchData`. `SELECTED_INDEX` counts newest-to-oldest (0 = newest);
 * `NativeSearchController` flips it for the find bar.
 */
export const SEARCH_DATA_STATUS = 0
export const SEARCH_DATA_NEEDLE = 1
export const SEARCH_DATA_TOTAL_MATCHES = 2
export const SEARCH_DATA_SELECTED_INDEX = 3
export const SEARCH_DATA_SELECTED_MATCH = 4
export const SEARCH_DATA_MATCHES = 5
export const SEARCH_DATA_VIEWPORT_MATCHES = 6
export const SEARCH_DATA_SELECT_SCROLL = 7

/** `GhosttySearchScroll`. We use `NONE`: the viewport offset is ours. */
export const SEARCH_SCROLL_IF_NEEDED = 0
export const SEARCH_SCROLL_NONE = 1

/* -------------------------------------------------------------------------- */
/* Cells                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `GhosttyCell` is a `uint64_t` (the whole cell, bit-cast), so it can be
 * unpacked in JS instead of queried per field. `ghostty_cell_get` takes it by
 * value, which is an i64 argument: pass a BigInt.
 */
export const CELL_U64_BYTES = 8

/** Low 2 bits of the packed cell are the content tag; the codepoint follows. */
export const CELL_CONTENT_TAG_MASK = 0x3
export const CELL_CODEPOINT_SHIFT = 2
export const CELL_CODEPOINT_MASK = 0x1fffff

/**
 * Unpack a codepoint from the low word of a packed cell (bits 2..22 never
 * cross the word boundary, which keeps BigInt out of the per-cell loop).
 */
export function codepointOf(lo: number): number {
  return (lo >>> CELL_CODEPOINT_SHIFT) & CELL_CODEPOINT_MASK
}

/** `GhosttyCellContentTag`. */
export const CELL_CONTENT_CODEPOINT = 0
export const CELL_CONTENT_CODEPOINT_GRAPHEME = 1
export const CELL_CONTENT_BG_COLOR_PALETTE = 2
export const CELL_CONTENT_BG_COLOR_RGB = 3

/**
 * Whether the packed payload is a codepoint. The content field is a union of
 * codepoint and background color; `codepointOf` on a color cell yields garbage.
 */
export function cellHasText(contentTag: number): boolean {
  return contentTag === CELL_CONTENT_CODEPOINT || contentTag === CELL_CONTENT_CODEPOINT_GRAPHEME
}

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
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `GhosttyStyle` layout, wasm32: 72 bytes. Colors carry a `uint64_t`, so each
 * is 8-aligned and 16 bytes wide. Read directly from caller memory (there is no
 * `ghostty_style_get`). `size` is versioned: write the buffer size in, and the
 * callee writes back what it filled.
 */
export const STYLE_SIZE = 72
export const STYLE_OFF_SIZE = 0
export const STYLE_OFF_FG_TAG = 8
export const STYLE_OFF_FG_VALUE = 16
export const STYLE_OFF_BG_TAG = 24
export const STYLE_OFF_BG_VALUE = 32
export const STYLE_OFF_UNDERLINE_TAG = 40
export const STYLE_OFF_UNDERLINE_VALUE = 48
export const STYLE_OFF_BOLD = 56
export const STYLE_OFF_ITALIC = 57
export const STYLE_OFF_FAINT = 58
export const STYLE_OFF_BLINK = 59
export const STYLE_OFF_INVERSE = 60
export const STYLE_OFF_INVISIBLE = 61
export const STYLE_OFF_STRIKETHROUGH = 62
export const STYLE_OFF_OVERLINE = 63
/** `int`, not a bool: 0 none, 1 single, 2 double, 3 curly, 4 dotted, 5 dashed. */
export const STYLE_OFF_UNDERLINE_STYLE = 64

/** `GhosttyStyleColorTag`. */
export const STYLE_COLOR_NONE = 0
export const STYLE_COLOR_PALETTE = 1
export const STYLE_COLOR_RGB = 2

/* -------------------------------------------------------------------------- */
/* Render state                                                                */
/* -------------------------------------------------------------------------- */

/** `GhosttyRenderStateData` — keys for `ghostty_render_state_get`. */
export const RS_DATA_COLS = 1 // was render_state_get_cols
export const RS_DATA_ROWS = 2 // was render_state_get_rows
export const RS_DATA_DIRTY = 3
/**
 * Yields the row iterator. `get` wants the slot holding the handle, not the
 * handle; passing the handle returns INVALID_VALUE.
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
/**
 * Structured cursor and color reads (upstream `16c833c5f`), replacing many
 * separate calls. Both are sized structs: write the struct's byte length into
 * the first field before the call.
 */
export const RS_DATA_CURSOR = 18
export const RS_DATA_COLORS = 19

/**
 * `GhosttyRenderStateCursor`, wasm32, 20 bytes, with alignment holes. When
 * `viewport_has_value` is false, `viewport_x`, `viewport_y` and `wide_tail` are
 * undefined.
 */
export const RS_CURSOR_SIZE = 20
export const RS_CURSOR_OFF_SIZE = 0
export const RS_CURSOR_OFF_VIEWPORT_HAS_VALUE = 4
export const RS_CURSOR_OFF_VIEWPORT_X = 6
export const RS_CURSOR_OFF_VIEWPORT_Y = 8
export const RS_CURSOR_OFF_WIDE_TAIL = 10
export const RS_CURSOR_OFF_VISIBLE = 11
export const RS_CURSOR_OFF_BLINKING = 12
export const RS_CURSOR_OFF_PASSWORD_INPUT = 13
export const RS_CURSOR_OFF_VISUAL_STYLE = 16

/**
 * `GhosttyRenderStateColors`, wasm32, 784 bytes (the 256-entry palette is
 * inline). The three colors are packed 3-byte RGB at +4, +7 and +10.
 */
export const RS_COLORS_SIZE = 784
export const RS_COLORS_OFF_SIZE = 0
export const RS_COLORS_OFF_BACKGROUND = 4
export const RS_COLORS_OFF_FOREGROUND = 7
export const RS_COLORS_OFF_CURSOR = 10
export const RS_COLORS_OFF_CURSOR_HAS_VALUE = 13
export const RS_COLORS_OFF_PALETTE = 14

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
 * Per-row dirty is cleared by the consumer via `row_set(iter, ROW_OPTION_DIRTY,
 * false)`; otherwise every row reads dirty from the second frame on.
 * `render_state_set(state, DIRTY, false)` is a different flag.
 */
export const RS_ROW_OPTION_DIRTY = 0

/** `GhosttyRenderStateRowData` — keys for `ghostty_render_state_row_get`. */
export const RS_ROW_DATA_DIRTY = 1 // was render_state_is_row_dirty
export const RS_ROW_DATA_RAW = 2
export const RS_ROW_DATA_CELLS = 3
export const RS_ROW_DATA_SELECTION = 4
/**
 * Writes a `GhosttyCellsView`: a borrowed contiguous run of the row's packed
 * cells, one call per row instead of one per cell. Invalidated by the next
 * `render_state_update`, and stale after any memory growth. Styles and
 * resolved colors still need the per-cell iterator; see `ViewportReader`.
 */
export const RS_ROW_DATA_CELLS_RAW = 5

/**
 * `GhosttyCellsView` layout, wasm32: `{ const GhosttyCell *ptr; size_t len; }`.
 */
export const CELLS_VIEW_SIZE = 8
export const CELLS_VIEW_OFF_PTR = 0
export const CELLS_VIEW_OFF_LEN = 4

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
/**
 * In/out key: write a `GhosttyTerminalModeConfig` and the core fills `value`.
 * See `MODE_CONFIG_*`.
 */
export const T_DATA_MODE = 37
export const T_DATA_SCROLLBACK_MAX_LINES = 35

/**
 * `GhosttyTerminalOption`: keys for `ghostty_terminal_set`. `vt_write` ignores
 * sequences with side effects or responses unless the effect callbacks
 * (`OPT_WRITE_PTY` and friends) are registered.
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
 * The core holds the configured default cursor across a RIS.
 */
export const T_OPT_DEFAULT_CURSOR_STYLE = 22
export const T_OPT_DEFAULT_CURSOR_BLINK = 23
export const T_OPT_PWD_CHANGED = 25
export const T_OPT_CLIPBOARD_WRITE = 26
/**
 * Both scrollback caps bind independently, so set both.
 */
export const T_OPT_SCROLLBACK_MAX_BYTES = 27
export const T_OPT_SCROLLBACK_MAX_LINES = 28
export const T_OPT_DESKTOP_NOTIFICATION = 29
export const T_OPT_PROGRESS_REPORT = 30
/**
 * Answer `CSI 21 t` (report window title). **Leave this off**: a remote host
 * that can set the title could read it back as typed input (command
 * injection). `effects.test.ts` asserts it stays unanswered with the PTY write
 * callback installed.
 */
export const T_OPT_TITLE_REPORT = 32

/**
 * Whether growing the rows may pull lines back out of scrollback. `bool*`,
 * default true, kept across a RIS. Off behind a ConPTY, which repaints its own
 * buffer after a resize and would overwrite the pulled rows.
 */
export const T_OPT_RESIZE_PULL_SCROLLBACK = 40

/**
 * `GhosttyTerminalRenderHoldFn`: `(terminal, userdata, bool held) -> void`,
 * called where synchronized output (mode 2026) begins and ends. The value is
 * the function pointer itself.
 */
export const T_OPT_RENDER_HOLD = 41

/**
 * Answer DECRQCRA with a screen-rectangle checksum. **Leave it off**: a remote
 * program could read the whole screen one cell at a time. `effects.test.ts`
 * asserts it stays unanswered.
 */
export const T_OPT_XT_CHECKSUM_REPORT = 44

/**
 * `GhosttyTerminalResetFn`: `(terminal, userdata) -> void`, called after a
 * full reset (RIS). The value is the function pointer itself.
 */
export const T_OPT_RESET = 43

/**
 * `ghostty_terminal_vt_write_until` boundaries (`GhosttyTerminalBoundary`),
 * bit flags. The call stops right after the first byte that reaches one.
 */
export const BOUNDARY_GROUND = 1 << 0
export const BOUNDARY_OSC_START = 1 << 5
export const BOUNDARY_OSC_END = 1 << 6

/** `GhosttyTerminalStringEnd`: how a string ended. */
export const STRING_END_ST_ESC = 0
export const STRING_END_ST_C1 = 1
export const STRING_END_CANCELLED = 2
export const STRING_END_ABORTED = 3
export const STRING_END_BEL = 4

/**
 * `GhosttyTerminalWriteStop`, a sized struct the caller provides. Checked
 * against `ghostty_type_json` by `abi.manifest.test.ts`.
 */
export const WRITE_STOP_SIZE = 28
export const WRITE_STOP_OFF_SIZE = 0
export const WRITE_STOP_OFF_CONSUMED = 4
export const WRITE_STOP_OFF_REACHED = 8
export const WRITE_STOP_OFF_KIND = 12
export const WRITE_STOP_OFF_END = 20

/**
 * Sets a mode via a `GhosttyTerminalModeConfig*`. Never fires the render-hold
 * callback, so it can end a hold the program never released.
 */
export const T_OPT_MODE = 34
/** DEC private mode 2026, synchronized output. */
export const MODE_SYNC_OUTPUT = 2026

/**
 * `GhosttyColorRgb` is 3 packed bytes, so a 256-entry palette is 768 bytes.
 */
export const COLOR_RGB_BYTES = 3
export const PALETTE_ENTRIES = 256
export const PALETTE_BYTES = PALETTE_ENTRIES * COLOR_RGB_BYTES

// `ghostty_terminal_set`'s `value` points at the data. For
// `T_OPT_COLOR_PALETTE` that's the array pointer itself; a pointer-to-pointer
// returns success and leaves the palette black.

/**
 * `GhosttyMode` is `uint16_t`: a DEC private mode is its number, an ANSI mode
 * has bit 15 set (`ghostty_mode_new`).
 */
export const MODE_ANSI_BIT = 0x8000
export function ansiMode(mode: number, isAnsi: boolean): number {
  return isAnsi ? mode | MODE_ANSI_BIT : mode
}

/**
 * `GhosttyTerminalModeConfig` (layout frozen upstream):
 * `{ GhosttyMode mode; bool value; }`, so `value` is at +2 and the size is 4.
 */
export const MODE_CONFIG_MODE_OFFSET = 0
export const MODE_CONFIG_VALUE_OFFSET = 2
export const MODE_CONFIG_SIZE = 4

/** `active_screen` values for `T_DATA_ACTIVE_SCREEN`. */
export const SCREEN_PRIMARY = 0
export const SCREEN_ALTERNATE = 1

/* -------------------------------------------------------------------------- */
/* Export surface                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The size of `size_t` on wasm32, for call sites that used the retired
 * `ghostty_wasm_alloc_usize`.
 */
export const USIZE_BYTES = 4

/**
 * The subset of `main`'s exports we use, each with a checked signature.
 */
export interface GhosttyMainExports {
  memory: WebAssembly.Memory

  /* Allocation. One generic allocator, aligned for any C struct. `free`
   * needs the original length back. */
  ghostty_wasm_alloc(len: number): number
  ghostty_wasm_free(ptr: number, len: number): void
  ghostty_wasm_alloc_opaque(): number
  ghostty_wasm_free_opaque(ptr: number): void
  /** Reads the pointer a constructor wrote into a slot. */
  ghostty_wasm_take_opaque(slot: number): number

  /* Terminal lifecycle. Scrollback is a `set` option, not a constructor
   * argument. */
  ghostty_terminal_new(alloc: number, resultSlot: number, cols: number, rows: number): number
  ghostty_terminal_free(term: number): void
  ghostty_terminal_resize(term: number, cols: number, rows: number): number
  ghostty_terminal_reset(term: number): number
  /**
   * Returns **void**, not a `GhosttyResult`; failures are reported via
   * `T_DATA_VT_PROCESSING_ERROR`. Don't wrap it in `expectOk`.
   */
  ghostty_terminal_vt_write(term: number, ptr: number, len: number): void
  /**
   * Like `vt_write`, but stops right after the first byte that reaches one of
   * `boundaries` and describes the stop in `stop` (a `GhosttyTerminalWriteStop`
   * with its size set). `GHOSTTY_SUCCESS` when a boundary was reached,
   * `GHOSTTY_NO_VALUE` when all input was consumed without one.
   */
  ghostty_terminal_vt_write_until(term: number, ptr: number, len: number, boundaries: number, stop: number): number

  /* generic accessors */
  ghostty_terminal_get(term: number, key: number, out: number): number
  ghostty_terminal_get_multi(term: number, n: number, keys: number, values: number, written: number): number
  ghostty_terminal_set(term: number, key: number, value: number): number
  // Modes are read and set through the generic accessors with `T_DATA_MODE`
  // (see `shim.ts`). The mode is one `GhosttyMode` with the ANSI bit folded in
  // (`ansiMode`), not a `(mode, is_ansi)` pair.
  ghostty_terminal_scroll_viewport(term: number, tag: number, delta: number): number

  /* render state */
  ghostty_render_state_new(alloc: number, slot: number): number
  ghostty_render_state_free(state: number): void
  ghostty_render_state_update(state: number, term: number): number
  ghostty_render_state_get(state: number, key: number, out: number): number
  ghostty_render_state_get_multi(state: number, n: number, keys: number, values: number, written: number): number
  ghostty_render_state_set(state: number, key: number, value: number): number

  /* row iteration */
  ghostty_render_state_row_iterator_new(alloc: number, slot: number): number
  ghostty_render_state_row_iterator_free(iter: number): void
  /**
   * Returns a **bool** (truthy = advanced), not a `GhosttyResult`. Don't wrap it
   * in `expectOk`.
   */
  ghostty_render_state_row_iterator_next(iter: number): number
  /**
   * Advances to the next row needing redraw, writing its viewport y to `outY`
   * (it can skip rows). Honors the global dirty state and clears nothing. A
   * bool, like `next`.
   */
  ghostty_render_state_row_iterator_next_dirty(iter: number, outY: number): number
  /**
   * Clears both the global dirty flag and every per-row flag. Clearing only
   * the global one leaves the rows dirty.
   */
  ghostty_render_state_clean(state: number): number
  ghostty_render_state_row_get(iter: number, key: number, out: number): number
  ghostty_render_state_row_get_multi(iter: number, n: number, keys: number, values: number, written: number): number
  ghostty_render_state_row_set(iter: number, key: number, value: number): number

  /* cell iteration within a row */
  ghostty_render_state_row_cells_new(alloc: number, slot: number): number
  ghostty_render_state_row_cells_free(cells: number): void
  /** Also a **bool**, not a result — see `row_iterator_next`. */
  ghostty_render_state_row_cells_next(cells: number): number
  ghostty_render_state_row_cells_get(cells: number, key: number, out: number): number
  ghostty_render_state_row_cells_get_multi(cells: number, n: number, keys: number, values: number, written: number): number

  /* grid references — the scrollback and hyperlink path */
  ghostty_terminal_grid_ref(term: number, point: number, outRef: number): number
  ghostty_grid_ref_cell(ref: number, outCell: number): number
  ghostty_grid_ref_row(ref: number, outRow: number): number
  ghostty_grid_ref_graphemes(ref: number, buf: number, bufLen: number, outLen: number): number
  ghostty_grid_ref_hyperlink_uri(ref: number, buf: number, bufLen: number, outLen: number): number
  /**
   * Fills a caller-owned `GhosttyStyle`; write `STYLE_SIZE` into its first
   * word first.
   */
  ghostty_grid_ref_style(ref: number, outStyle: number): number
  ghostty_style_default(outStyle: number): void
  ghostty_style_is_default(style: number): number

  /** Takes the packed cell **by value** — an i64 argument, so pass a BigInt. */
  ghostty_cell_get(cell: bigint, key: number, out: number): number
  ghostty_row_get(row: bigint, key: number, out: number): number

  /**
   * Converts a grid ref to coordinates. `out` is a `GhosttyPointCoordinate`.
   * Returns `GHOSTTY_NO_VALUE` (not a failure) when `tag`'s system can't express
   * the ref, which distinguishes scrollback matches from visible ones.
   */
  ghostty_terminal_point_from_grid_ref(term: number, ref: number, tag: number, out: number): number

  /* Native find-in-scrollback; see `../NativeSearchController.ts`. Reached
   * directly (no shim); absent on v1.3.1, where the engine falls back to the
   * JS `SearchController`. */
  ghostty_search_new(alloc: number, slot: number, term: number): number
  ghostty_search_free(search: number): void
  /** Bounded progress on data already copied; never touches the terminal.
   *  `outStatus` may be 0. */
  ghostty_search_tick(search: number, outStatus: number): number
  /** Reads the terminal; the only way the search learns of changes. */
  ghostty_search_feed(search: number): number
  /** Blocking feed-and-tick until complete; for tests and probes. */
  ghostty_search_run(search: number): number
  ghostty_search_set(search: number, option: number, value: number): number
  ghostty_search_get(search: number, data: number, value: number): number
  ghostty_search_get_multi(
    search: number,
    count: number,
    keys: number,
    values: number,
    written: number,
  ): number

  /* Key encoding; see `keyAbi.ts` and `../KeyEncoder.ts`. Reached directly;
   * `KeyEncoder.create` checks they exist. */
  ghostty_key_event_new(alloc: number, slot: number): number
  ghostty_key_event_free(event: number): void
  ghostty_key_event_set_action(event: number, action: number): void
  ghostty_key_event_set_key(event: number, key: number): void
  ghostty_key_event_set_mods(event: number, mods: number): void
  ghostty_key_event_set_consumed_mods(event: number, mods: number): void
  ghostty_key_event_set_composing(event: number, composing: number): void
  /** The text isn't copied; the buffer must outlive every `encode` that reads
   *  it. */
  ghostty_key_event_set_utf8(event: number, ptr: number, len: number): void
  ghostty_key_event_set_unshifted_codepoint(event: number, codepoint: number): void
  ghostty_key_encoder_new(alloc: number, slot: number): number
  ghostty_key_encoder_free(encoder: number): void
  /** `value` is a *pointer* to the value, whose type depends on the option. */
  ghostty_key_encoder_setopt(encoder: number, option: number, value: number): void
  ghostty_key_encoder_setopt_from_terminal(encoder: number, term: number): void
  /** Writes the byte count to `outLen` even when it returns `OUT_OF_SPACE`,
   *  in which case that count is the buffer size required. */
  ghostty_key_encoder_encode(encoder: number, event: number, out: number, outSize: number, outLen: number): number

  ghostty_mouse_event_new(alloc: number, slot: number): number
  ghostty_mouse_event_free(event: number): void
  ghostty_mouse_event_set_action(event: number, action: number): void
  ghostty_mouse_event_set_button(event: number, button: number): void
  /** "No button" (there is no button 0), for motion with nothing held. */
  ghostty_mouse_event_clear_button(event: number): void
  ghostty_mouse_event_set_mods(event: number, mods: number): void
  /** `position` points to a `GhosttyMousePosition` (two `f32`, surface
   *  pixels); by-value in the header, a pointer on wasm32. */
  ghostty_mouse_event_set_position(event: number, position: number): void
  ghostty_mouse_encoder_new(alloc: number, slot: number): number
  ghostty_mouse_encoder_free(encoder: number): void
  /** `value` is a *pointer* to the value, whose type depends on the option. */
  ghostty_mouse_encoder_setopt(encoder: number, option: number, value: number): void
  /** Sets tracking mode and output format from the terminal; leaves surface
   *  geometry and the any-button flag alone. */
  ghostty_mouse_encoder_setopt_from_terminal(encoder: number, term: number): void
  ghostty_mouse_encoder_reset(encoder: number): void
  /** Writes the byte count to `outLen` even when it returns `OUT_OF_SPACE`,
   *  in which case that count is the buffer size required. */
  ghostty_mouse_encoder_encode(encoder: number, event: number, out: number, outSize: number, outLen: number): number

  /** False for a newline or an embedded bracketed-paste terminator. */
  ghostty_paste_is_safe(data: number, len: number): number
  /**
   * **Modifies `data` in place** while encoding; a retry must refill it. `out`
   * may be 0 to ask only for the size.
   */
  ghostty_paste_encode(
    data: number,
    dataLen: number,
    bracketed: number,
    out: number,
    outSize: number,
    outWritten: number,
  ): number
}

/** Throws on any non-success result, naming the call. */
export function expectOk(result: number, what: string): void {
  if (result !== GHOSTTY_SUCCESS) {
    throw new Error(`${what} failed: GhosttyResult ${result}`)
  }
}
