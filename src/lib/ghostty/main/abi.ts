/**
 * The ghostty `main` C ABI, as constants and types.
 *
 * This is the target of the port described in `docs/PORT_GHOSTTY_MAIN.md`, not
 * yet the ABI the app talks to — `../wasmBindings.ts` still is. Nothing here
 * imports from there or is imported by it, so the two can coexist until the
 * read path moves over.
 *
 * Pinned to ghostty-org/ghostty @ f523504ea5c9f41d150d1eb93cc7a748b90f9361.
 * Every value below is transcribed from that commit's headers and exercised
 * against that commit's binary by `main/abi.parity.test.ts`, and the struct
 * layouts are checked against the binary itself by `main/abi.manifest.test.ts`.
 *
 * Re-pinning means re-checking, and the surface keeps moving *down* as upstream
 * consolidates: 187 -> 202, then 201 (`mode_get`/`mode_set` folded into the
 * generic accessors), now **180** — this pin retired the type-specific wasm
 * allocators for one generic `ghostty_wasm_alloc`, and `render_state_colors_get`
 * for a `RS_DATA_COLORS` key. A falling export count is consolidation, not a
 * broken build.
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
 * The caller's buffer was too small. The call also writes the size it needed,
 * so the recovery is to grow and repeat — see `KeyEncoder.encode`.
 */
export const GHOSTTY_OUT_OF_SPACE = -3
/**
 * Returned when a lookup is well-formed but has no answer — e.g. a scrollback
 * cell asked for in viewport coordinates. Distinct from INVALID_VALUE, and the
 * difference matters: one is a bug, the other is an ordinary miss.
 *
 * **-4, not -3.** It was transcribed as -3 here until the key encoder needed
 * `OUT_OF_SPACE`, which is what -3 actually is. Nothing had gone wrong yet
 * because nothing compared against it — the constant was declared and never
 * read — but a `!== GHOSTTY_NO_VALUE` test would have treated a too-small
 * buffer as a missing value, and that reads as an empty answer rather than as
 * an error.
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
 *
 * **`POINT_SIZE` was 16 until the manifest was consulted; it is 24.** The
 * offsets above were probed correctly — `value` really does begin at +8 — but
 * the probe could only find where the fields *are*, never where the struct
 * *ends*, and the union is 16 bytes rather than the 8 its coordinate arm uses.
 * Nothing was visibly wrong: the core reads 24 bytes from what we allocated as
 * 16, the surplus is the union's unused tail, and `grid_ref` returns SUCCESS
 * either way (checked, both sizes). What it did break was the zeroing loop in
 * `ScrollbackReader.resolve`, which cleared 16 of 24 bytes while its own
 * comment explained that a stale byte in the union is read as part of it.
 *
 * `abi.manifest.test.ts` now asserts every one of these against
 * `ghostty_type_json`, so the next one of these is caught rather than probed.
 */
export const POINT_SIZE = 24
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
/* Selections and search                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `GhosttySelection` — a pair of grid refs and a rectangle flag, and the type
 * every native search match comes back as.
 *
 * Sized struct: write `SELECTION_SIZE` into its first word before handing it to
 * the core, including into **every element** of a `GhosttySelectionBuffer`,
 * which the core reads element by element.
 *
 * The endpoints are inclusive and may be in either order. Both are *untracked*
 * snapshots, so they follow grid-ref lifetime rules — valid only until the next
 * terminal write. See `NativeSearchController`, which never keeps one.
 */
export const SELECTION_SIZE = 32
export const SELECTION_OFF_SIZE = 0
export const SELECTION_OFF_START = 4
export const SELECTION_OFF_END = 16
export const SELECTION_OFF_RECTANGLE = 28

/**
 * `GhosttySelectionBuffer` — `{ GhosttySelection *ptr; size_t cap; size_t len; }`.
 *
 * Two-call protocol, the same one `GhosttyBuffer` uses: pass `ptr = 0` with
 * `cap = 0` to be told the required count in `len` (the call returns
 * `GHOSTTY_OUT_OF_SPACE`, **not** success), then allocate and pass it again.
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
 * `GhosttyPointCoordinate` — `{ uint16_t x; uint32_t y; }`, so `y` is at +4,
 * not +2. This is the out-parameter of `point_from_grid_ref`, and it is a
 * different (smaller, unwrapped) type from `GhosttyPoint` above.
 */
export const POINT_COORDINATE_SIZE = 8
export const POINT_COORDINATE_OFF_X = 0
export const POINT_COORDINATE_OFF_Y = 4

/** `GhosttySearchStatus`. `COMPLETE` means caught up as of the last feed, never
 *  finished forever — a later write needs another feed to be seen. */
export const SEARCH_STATUS_RUNNING = 0
export const SEARCH_STATUS_FEED_REQUIRED = 1
export const SEARCH_STATUS_COMPLETE = 2

/** `GhosttySearchOption`. The two select options take a NULL value. */
export const SEARCH_OPT_NEEDLE = 0
export const SEARCH_OPT_SELECT_NEXT = 1
export const SEARCH_OPT_SELECT_PREV = 2
export const SEARCH_OPT_SELECT_SCROLL = 3

/**
 * `GhosttySearchData`.
 *
 * `SELECTED_INDEX` indexes the **newest-to-oldest** ordering of `MATCHES`,
 * where 0 is the newest. Our find bar has always counted the other way; the
 * flip lives in `NativeSearchController`.
 */
export const SEARCH_DATA_STATUS = 0
export const SEARCH_DATA_NEEDLE = 1
export const SEARCH_DATA_TOTAL_MATCHES = 2
export const SEARCH_DATA_SELECTED_INDEX = 3
export const SEARCH_DATA_SELECTED_MATCH = 4
export const SEARCH_DATA_MATCHES = 5
export const SEARCH_DATA_VIEWPORT_MATCHES = 6
export const SEARCH_DATA_SELECT_SCROLL = 7

/** `GhosttySearchScroll` — whether selecting a match moves the core's own
 *  viewport. We set `NONE`: the viewport offset is ours (`_viewportOffset`),
 *  and a core-side scroll would leave the two disagreeing. */
export const SEARCH_SCROLL_IF_NEEDED = 0
export const SEARCH_SCROLL_NONE = 1

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

/**
 * Whether the packed payload is a codepoint at all.
 *
 * The cell's content field is a **union**: a codepoint for a cell with text, or
 * a background colour for one without. `codepointOf` is only meaningful when
 * this is true — running it over a `BG_COLOR_*` cell yields whatever the low
 * bits of the colour happen to be, which for `0x445566` is a plain `1`. A
 * cleared row then reads as a row of control characters, and nothing about that
 * looks wrong until the bytes are compared.
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
 * `GhosttyStyle` layout, wasm32 — 72 bytes, offsets found by probing, not by
 * reading `style.h`.
 *
 * The header declares `{ size_t size; GhosttyStyleColor fg, bg, underline;
 * bool bold..overline; int underline; }`, which looks 4-aligned. It is not:
 * `GhosttyStyleColorValue` carries a `uint64_t`, so every colour is 8-aligned
 * and 16 bytes wide, and the booleans start well past where a naive reading
 * puts them.
 *
 * There is no `ghostty_style_get` — unlike cells and rows, a style is read
 * directly out of caller memory. `size` is a **versioned-struct** field: write
 * the buffer size in before the call, and the callee writes back the size it
 * actually filled (72 at the pin). A style that reads back a different size is
 * the signal that this block needs revisiting.
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
/**
 * Structured reads added upstream in `16c833c5f`. A renderer reconstructing the
 * cursor used to need eight separate `render_state_get` calls, which showed up
 * per frame in wasm profiles; these return the whole thing at once. The same
 * commit removed the dedicated `ghostty_render_state_colors_get` in favour of
 * `RS_DATA_COLORS`.
 *
 * Both are **sized structs**: the caller writes the struct's own byte length
 * into its first field before the call, and the callee fills what it knows and
 * writes back how much that was. Skipping that write is the failure mode to
 * watch for — it is a plain `0`, which no version of the struct is, so the call
 * fails rather than silently half-filling. `STYLE_SIZE` works the same way.
 */
export const RS_DATA_CURSOR = 18
export const RS_DATA_COLORS = 19

/**
 * `GhosttyRenderStateCursor`, wasm32. 20 bytes.
 *
 * Note the holes: `viewport_x` is at +6 rather than +5, because a `uint16_t`
 * cannot follow a `bool` unaligned, and `visual_style` is at +16 rather than
 * +14 for the same reason at 4-byte width. Transcribed from the manifest rather
 * than counted off the header, and asserted against it by `abi.manifest.test.ts`.
 *
 * **When `viewport_has_value` is false, `viewport_x`, `viewport_y` and
 * `wide_tail` are explicitly undefined** — upstream says so in `render.h`, and
 * reading them anyway is how a cursor scrolled out of the viewport gets drawn
 * at (0,0).
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
 * `GhosttyRenderStateColors`, wasm32. **784 bytes** — it carries the whole
 * 256-entry palette inline, which is most of it.
 *
 * The three colours are `GhosttyColorRgb`, three *packed* bytes each, so they
 * sit at +4, +7 and +10 with no padding between them. A reader that assumed a
 * 4-byte stride would take the foreground's red as the background's alpha and
 * every colour after it would be shifted by one — plausible-looking and wrong,
 * which is the same trap `PALETTE_BYTES` documents.
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
/**
 * New in the `6b22215c` pin. Writes a `GhosttyCellsView`, giving a **borrowed**
 * contiguous run of the row's packed u64 cells — one call per row where
 * `RS_CELLS_RAW` costs one per cell.
 *
 * Borrowed is the whole hazard: the run is invalidated by the next
 * `render_state_update`, so it must be consumed inside the frame that fetched
 * it and never cached across one. It also points into wasm linear memory, so a
 * `DataView` over it is stale after any allocation that grows memory.
 *
 * Measured with `tools/parse-probes/iter.mjs` on this binary, codepoints only:
 * **0.1x** of the v1.3.1 batched `get_viewport` (1.9µs vs 14.1µs at 80x24,
 * 10.3µs vs 90.1µs at 200x60), and 5.8x-11.4x faster than the per-cell
 * `RS_CELLS_RAW`. A consumer that also needs styles or resolved colours still
 * pays the per-cell iterator for those — see `ViewportReader`.
 */
export const RS_ROW_DATA_CELLS_RAW = 5

/**
 * `GhosttyCellsView` layout, wasm32: `{ const GhosttyCell *ptr; size_t len; }`
 * — two u32s. `ptr` addresses `len` contiguous `CELL_U64_BYTES` cells.
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
 * In/out key, unlike every other `T_DATA_*`: the caller writes a
 * `GhosttyTerminalModeConfig` in and the core fills its `value` field.
 * See `MODE_CONFIG_*` below. Replaces `ghostty_terminal_mode_get`/`_mode_set`,
 * removed upstream in `cfc19e805` (flagged ABI BREAKING).
 */
export const T_DATA_MODE = 37
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
/**
 * Enable answering `CSI 21 t` (report window title). **Leave this off.**
 *
 * We never set it, and this constant exists to document *why* rather than to be
 * used. Before upstream `38e891e6c` (landed in this pin) there was no switch:
 * merely registering the PTY write callback — which `MainEffects` must do, or
 * every query a program makes waits out its timeout — also made the terminal
 * echo the window title back into the input stream. A remote host that can set
 * a title via OSC 0/2 could then read it back as if the user had typed it,
 * which is command injection with one keystroke of user interaction. We connect
 * to remote hosts for a living, so this was our exposure, not a theoretical one.
 *
 * Upstream now defaults it to disabled and gates it behind this option.
 * `effects.test.ts` asserts the default holds with the callback installed, so
 * turning it on — here or upstream — fails the suite rather than shipping.
 */
export const T_OPT_TITLE_REPORT = 32

/**
 * Whether growing the rows may pull lines back out of scrollback. `bool*`;
 * the core defaults to true and keeps the setting across a RIS.
 *
 * Off for anything behind a ConPTY. The pseudoconsole keeps its own screen
 * buffer with no scrollback, so it cannot follow a pull. Measured on a real
 * one: after the resize it repaints its buffer from the top, so the screen
 * comes out right — but the rows we pulled back are painted over, and they are
 * gone from history too. A 10 -> 20 row grow after 40 lines lost lines 22-31.
 * Upstream `c55f213aa` (#14294), which reports output landing on the wrong
 * rows instead — what a ConPTY that did not repaint would show.
 */
export const T_OPT_RESIZE_PULL_SCROLLBACK = 40

/**
 * `GhosttyTerminalRenderHoldFn`: `(terminal, userdata, bool held) -> void`,
 * called at the byte where synchronized output (mode 2026) begins and again
 * when it ends — by the program, by a RIS, or by a resize. Upstream
 * `e50779498` (#14317). The value is the function pointer itself, as for
 * `T_OPT_WRITE_PTY`.
 */
export const T_OPT_RENDER_HOLD = 41

/**
 * Sets a mode, taking a `GhosttyTerminalModeConfig*` (see `MODE_CONFIG_*`).
 * Unlike the program setting it, this never fires the render-hold callback —
 * which is what makes it the way to end a hold the program never released.
 */
export const T_OPT_MODE = 34
/** DEC private mode 2026, synchronized output. */
export const MODE_SYNC_OUTPUT = 2026

/**
 * `GhosttyColorRgb` is **3 packed bytes**, no padding, so a 256-entry palette is
 * 768 bytes. Verified: at stride 4 a palette of `rgb(i, 100, 200)` resolved
 * index 7 to `(100, 200, 0)` — shifted by one channel, a plausible colour that
 * is simply wrong.
 */
export const COLOR_RGB_BYTES = 3
export const PALETTE_ENTRIES = 256
export const PALETTE_BYTES = PALETTE_ENTRIES * COLOR_RGB_BYTES

/**
 * `ghostty_terminal_set`'s `value` always points **at** the data.
 *
 * For a scalar option that means a pointer to the scalar; for
 * `T_OPT_COLOR_PALETTE`, whose declared input type is already
 * `GhosttyColorRgb[256]*`, it means the array pointer itself and *not* a pointer
 * to it. Passing a pointer-to-pointer there returns GHOSTTY_SUCCESS and leaves
 * every palette colour black.
 */

/**
 * `GhosttyMode` folds our `(mode, is_ansi)` pair into one number: a DEC private
 * mode is its bare number, an ANSI mode is the number with bit 15 set.
 *
 * This was originally probed rather than read, because `GhosttyMode` lived in a
 * header we did not vendor: after `ESC [ 4 h` (IRM, an ANSI mode), `4` reads
 * back false — because DEC 4 also exists and is unset — while `4 | 0x8000` reads
 * back true. The probe was right, and upstream's `modes.h` now states it
 * outright: `typedef uint16_t GhosttyMode`, built by
 * `ghostty_mode_new(value, ansi) => (value & 0x7FFF) | (ansi << 15)`.
 */
export const MODE_ANSI_BIT = 0x8000
export function ansiMode(mode: number, isAnsi: boolean): number {
  return isAnsi ? mode | MODE_ANSI_BIT : mode
}

/**
 * `GhosttyTerminalModeConfig` — the in/out struct for `T_DATA_MODE`. Upstream
 * documents the layout as frozen ("will not gain fields in future versions"):
 *
 * ```c
 * typedef struct { GhosttyMode mode; bool value; } GhosttyTerminalModeConfig;
 * ```
 *
 * `GhosttyMode` is `uint16_t`, so `value` sits at offset 2 and the struct is
 * 4 bytes after tail padding to the u16 alignment.
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
 * The subset of `main`'s 202 exports this port needs. Deliberately not the whole
 * surface: an export listed here is one we have a use for and have checked the
 * signature of, which is the property that made the current `wasmBindings.ts`
 * worth trusting.
 */
/**
 * What the retired `ghostty_wasm_alloc_usize` reserved: `size_t` on wasm32.
 * Call sites that used it now ask `ghostty_wasm_alloc` for this many bytes and
 * hand the same number back to `ghostty_wasm_free`.
 */
export const USIZE_BYTES = 4

export interface GhosttyMainExports {
  memory: WebAssembly.Memory

  /* allocation.
   *
   * One generic byte allocator since upstream `a8e9b413f`, which removed the
   * type-specific `_u8_array` / `_usize` pairs (a dozen-odd exports, and the
   * bulk of this pin's 201 -> 180 drop). The returned address is aligned to the
   * target's maximum C ABI alignment, so a buffer from here is safe to hand to
   * any struct-shaped out-parameter — which the old `alloc_u8_array` did not
   * promise, and several call sites here quietly relied on.
   *
   * `free` needs the original length back. `USIZE_BYTES` is what the retired
   * `alloc_usize` reserved. */
  ghostty_wasm_alloc(len: number): number
  ghostty_wasm_free(ptr: number, len: number): void
  ghostty_wasm_alloc_opaque(): number
  ghostty_wasm_free_opaque(ptr: number): void
  /** Reads the pointer a constructor wrote into a slot, replacing a manual
   *  `DataView.getUint32(slot, true)` at every call site. */
  ghostty_wasm_take_opaque(slot: number): number

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
  // `ghostty_terminal_mode_get`/`_mode_set` used to be declared here. Upstream
  // `cfc19e805` removed them — flagged ABI BREAKING — in favour of the generic
  // accessors above under `T_DATA_MODE`, so that mode work can gain fields
  // without breaking the ABI again. `shim.ts` does the in/out struct dance.
  //
  // Kept as a note because the old signature was a live trap and someone
  // reading a pre-pin call site needs to know why it vanished: it took **three**
  // arguments, not four, since main folds our `(mode, is_ansi)` pair into one
  // `GhosttyMode` (see `ansiMode` above). Calling it with four failed in the
  // worst available way — JS drops the extra argument, so the *out pointer*
  // landed in the mode slot, the write went to address 0, the call still
  // returned `GHOSTTY_SUCCESS`, and the mode query answered "still set"
  // forever. The same folding applies to the replacement, so the trap moved
  // rather than closed.
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
   * Returns a **bool**, not a `GhosttyResult` — truthy means it advanced. Both
   * `_next` calls break the convention every neighbouring function follows, so
   * an `expectOk` around either treats a successful advance (1) as a failure
   * and a exhausted iterator (0) as success.
   */
  ghostty_render_state_row_iterator_next(iter: number): number
  /**
   * Advances to the next row that needs redrawing, writing its **viewport y**
   * to `outY`. Added upstream in `ad6e72ddc`.
   *
   * It writes the y because it *jumps*: unlike the sequential `next`, a caller
   * cannot keep count itself. Honours the global dirty state — nothing when
   * FALSE, clean rows skipped when PARTIAL, every row when FULL — and clears
   * nothing, so the caller still has to consume the dirty state afterwards.
   *
   * A bool, not a result, with the same inversion hazard as `next`.
   */
  ghostty_render_state_row_iterator_next_dirty(iter: number, outY: number): number
  /**
   * Unsets **both** layers of dirty state — the global flag and every per-row
   * flag — in one call.
   *
   * This is the fix for a trap `render.h` calls "an extremely important
   * detail": the two layers are independent, and clearing the global one does
   * not clear the rows. Setting `RS_OPTION_DIRTY` to FALSE, which is what
   * `mark_clean` used to do alone, leaves all 24 rows of an 80x24 viewport
   * still reading dirty — measured, not inferred.
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
   * Fills a caller-owned `GhosttyStyle`. Write `STYLE_SIZE` into the buffer's
   * first word first — it is a versioned struct and the callee reads it.
   */
  ghostty_grid_ref_style(ref: number, outStyle: number): number
  ghostty_style_default(outStyle: number): void
  ghostty_style_is_default(style: number): number

  /** Takes the packed cell **by value** — an i64 argument, so pass a BigInt. */
  ghostty_cell_get(cell: bigint, key: number, out: number): number
  ghostty_row_get(row: bigint, key: number, out: number): number

  /**
   * Converts a grid ref back into coordinates. `tag` is a `POINT_TAG_*`;
   * `out` is a `GhosttyPointCoordinate`, not a `GhosttyPoint`.
   *
   * Returns `GHOSTTY_NO_VALUE` — an ordinary answer, not a failure — for a ref
   * the requested system cannot express, which is how a scrollback match is
   * told apart from a visible one.
   */
  ghostty_terminal_point_from_grid_ref(term: number, ref: number, tag: number, out: number): number

  /* native find-in-scrollback — see `../NativeSearchController.ts`.
   *
   * Absent from the v1.3.1 build, and reached directly rather than through the
   * shim for the same reason the key encoder is: there is nothing on that
   * build to shim them to. `NativeSearchController.create` checks for them and
   * the engine falls back to the JS `SearchController` when they are missing. */
  ghostty_search_new(alloc: number, slot: number, term: number): number
  ghostty_search_free(search: number): void
  /** Bounded progress on data already copied; never touches the terminal.
   *  `outStatus` may be 0. */
  ghostty_search_tick(search: number, outStatus: number): number
  /** Reads the terminal. The **only** way the search learns it changed, so an
   *  un-fed search reports stale counts while output keeps arriving. */
  ghostty_search_feed(search: number): number
  /** Blocking feed-and-tick until complete. Kept for tests and probes: on a
   *  full scrollback this is exactly the stall the tick/feed split avoids. */
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

  /* key encoding — see `keyAbi.ts` and `../KeyEncoder.ts`.
   *
   * These have no counterpart in our 83-export ABI and are therefore reached
   * directly rather than through the shim: there is nothing on the v1.3.1
   * build for it to shim them *to*. `KeyEncoder.create` checks for them and
   * says so plainly if they are missing. */
  ghostty_key_event_new(alloc: number, slot: number): number
  ghostty_key_event_free(event: number): void
  ghostty_key_event_set_action(event: number, action: number): void
  ghostty_key_event_set_key(event: number, key: number): void
  ghostty_key_event_set_mods(event: number, mods: number): void
  ghostty_key_event_set_consumed_mods(event: number, mods: number): void
  ghostty_key_event_set_composing(event: number, composing: number): void
  /** The text does **not** become the event's to own; the buffer must outlive
   *  every `encode` that reads it. */
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
  /** "No button", which is what a motion event with nothing held carries.
   *  Distinct from button 0 — there is no button 0. */
  ghostty_mouse_event_clear_button(event: number): void
  ghostty_mouse_event_set_mods(event: number, mods: number): void
  /** `position` is a *pointer* to a `GhosttyMousePosition` — two `f32` in
   *  surface pixels. The header passes the struct by value; on wasm32 that
   *  lowers to a pointer, which the binary's signature confirms. */
  ghostty_mouse_event_set_position(event: number, position: number): void
  ghostty_mouse_encoder_new(alloc: number, slot: number): number
  ghostty_mouse_encoder_free(encoder: number): void
  /** `value` is a *pointer* to the value, whose type depends on the option. */
  ghostty_mouse_encoder_setopt(encoder: number, option: number, value: number): void
  /** Sets the tracking mode and the output format from the terminal. It does
   *  *not* touch the surface geometry or the any-button flag, so those have to
   *  be set separately and survive this call. */
  ghostty_mouse_encoder_setopt_from_terminal(encoder: number, term: number): void
  ghostty_mouse_encoder_reset(encoder: number): void
  /** Writes the byte count to `outLen` even when it returns `OUT_OF_SPACE`,
   *  in which case that count is the buffer size required. */
  ghostty_mouse_encoder_encode(encoder: number, event: number, out: number, outSize: number, outLen: number): number

  /** Conservative, and deliberately independent of terminal state: false for
   *  a newline and for an embedded bracketed-paste terminator. */
  ghostty_paste_is_safe(data: number, len: number): number
  /**
   * **Modifies `data` in place** while encoding — the unsafe-byte stripping
   * happens in the input buffer. A caller that retries has to refill it.
   * `out` may be 0 to ask only for the size.
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
