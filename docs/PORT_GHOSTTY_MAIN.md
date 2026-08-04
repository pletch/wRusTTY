# Porting the engine to ghostty `main`

Working notes for the move off the vendored v1.3.1 build and onto `main`'s
render/terminal C API. Written to be picked up cold — the decision behind it,
the pin, what each of our exports becomes, and what is actually done so far.

## Why this is happening now

Three measurements, all in `tools/parse-probes/`, and one source check:

- **Render path** (`iter.mjs`). `ROW_CELLS_DATA_RAW` returns the whole cell as
  one u64, so the frame reads at **0.9x-1.3x** the batched `get_viewport` for
  cells alone and **1.4x-2.5x** with resolved colors. Skipping clean rows —
  which the batched read cannot do at all — is **0.05x-0.14x**.
- **Search path** (`search.mjs`). **0.8x-0.9x**, and it holds at depth (0.65x at
  40k rows, 0.86x at 100k). This was the last plausible objection and it went
  the other way.
- **Absolute numbers.** The worst full redraw is 0.21 ms against an 8.3 ms
  frame. None of the above was ever the bottleneck; this is not a perf project.
- **Patch burden.** Of the three carried `ghostty-web` fixes, #142 is already on
  `main` and #177 is moot, leaving **#176 (`ESC k`), ~25 lines**, against 1,648
  lines across 11 files today. That is the real argument.

## The pin

```
ghostty-org/ghostty @ 48d85eaeb06ac9fc49073815bda5bac97de655ca
```

Chosen deliberately, not merely "what was current":

- It is the commit every measurement and every ABI fact below was verified
  against.
- It is **7 commits behind `main`** as of 2026-08-04, and those seven touch only
  `macos/`, `src/datastruct/` and `src/input/Binding.zig` — **nothing under
  `src/terminal/` or `include/ghostty/`**. The VT library is unchanged.
- It is the only commit we hold a **built binary** for, and rebuilding needs Zig
  0.16.0 on Linux/WSL, which this machine does not have. Re-pinning later means
  re-measuring, so it should be a deliberate act.

`main`'s surface has been moving — 187 exports when first measured, 202 at the
pin — so re-pin only with a reason and re-run the probes when you do.

### Building the pinned binary

```sh
git clone https://github.com/ghostty-org/ghostty.git
cd ghostty && git checkout 48d85eaeb06ac9fc49073815bda5bac97de655ca
git apply ../patches/ghostty-main-esc-k.patch   # #176, the only carried fix
zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
# -> zig-out/bin/ghostty-vt.wasm
```

Requires **Zig 0.16.0** (`minimum_zig_version` in `build.zig.zon`), against
0.15.2 for the v1.3.1 build. Linux or WSL — building natively on Windows hits a
Zig `ftruncate`/`FileTooBig` bug in the unicode table generator.

## ABI facts that cost time to find

None of these are derivable by reading the headers, and each fails *silently*.

- **`GhosttyPoint` is `tag@0, x@+8, y@+12`, 16 bytes, passed by pointer.**
  `point.h` declares `{ tag; value }` over `{ uint16_t x; uint32_t y; }`, which
  reads as `x@+4, y@+8`. The union carries an 8-aligned member so `value` starts
  at +8. Get it wrong and the coordinates land in each other's fields — you read
  a real cell from the wrong place, with no error. The tell is `y=1` returning
  column 1 of row 0.
- **`GhosttyCell` is a `uint64_t`**, the same packed cell as
  `ROW_CELLS_DATA_RAW` — not an opaque handle. `codepoint = (lo >>> 2) & 0x1FFFFF`.
  It is passed to `ghostty_cell_get` **by value**, i.e. as an i64 argument.
- **`GhosttyGridRef` is `{ size u32 @0, node ptr @4, x u16 @8, y u16 @10 }`** in
  caller memory, so a row is walked by **mutating `ref.x`** rather than
  re-resolving. This is the difference between 0.8x and 9.1x.
- **`grid_ref` resolution is O(scrollback depth)** — 14 ns at row 0, 188 ns at
  row 39,540. One resolve per row amortises it over `cols` cells; one per cell
  does not.
- **`get(state, ROW_ITERATOR, out)` wants the slot holding the handle**, not the
  handle. `render.zig` does `const it = out.* orelse ...`. Otherwise -2.
- **The constructor is `ghostty_terminal_new(alloc, result, cols, rows)`** —
  four args, no options struct. Scrollback is a `terminal_set` option.
- **Per-row dirty is cleared by the consumer.** Unless each row read is cleared
  with `row_set(iter, ROW_OPTION_DIRTY, false)`, every row reads dirty from the
  second frame on and a dirty-only pass quietly becomes a full one.
- **Both scrollback caps bind independently.** Setting only
  `OPT_SCROLLBACK_MAX_LINES` left 456 rows of a requested 10,000 at 200 cols,
  byte-pruned. Set `OPT_SCROLLBACK_MAX_BYTES` too.
- **`ghostty_terminal_vt_write` returns `void`**, not a `GhosttyResult`, unlike
  almost every neighbouring call. Processing failures come back out-of-band via
  `T_DATA_VT_PROCESSING_ERROR`. Wrapping it in an `expectOk`-style check
  compares `undefined` against 0 and throws on a write that worked.
- **`row_iterator_next` and `row_cells_next` return bools**, not results, so a
  result check around either inverts it exactly: a successful advance (1) reads
  as failure and an exhausted iterator (0) reads as success.
- **`GhosttyStyle` is read out of caller memory** — there is no `style_get` —
  and its 72-byte layout is not what `style.h` reads as: the colour union is
  8-aligned, putting the booleans at 56-63. `size` is versioned in both
  directions; the callee writes back what it filled.
- **`GhosttyColorRgb` is 3 packed bytes.** At stride 4 a palette of
  `rgb(i, 100, 200)` resolves index 7 to `(100, 200, 0)` — shifted, plausible,
  wrong.
- **`terminal_set`'s `value` points *at* the data.** For a scalar that is a
  pointer to the scalar; for `OPT_COLOR_PALETTE` it is the array pointer itself.
  A pointer-to-pointer returns `SUCCESS` and leaves every colour black.
- **Cells with no explicit colour report `INVALID_VALUE`**, not a colour. Our
  ABI pre-resolves defaults on the far side of the boundary, so any reader has
  to substitute the configured foreground/background itself.

## What each export becomes

Our 83 exports against `main`'s 202: 54 names are shared, 29 are not. None of
the 29 is a blocker. Full mapping:

### Direct key lookup on the generic `get`/`set` (18)

| ours | `main` |
| --- | --- |
| `render_state_get_cols` | `render_state_get` + `DATA_COLS` |
| `render_state_get_rows` | `DATA_ROWS` |
| `render_state_get_cursor_x` | `DATA_CURSOR_VIEWPORT_X` |
| `render_state_get_cursor_y` | `DATA_CURSOR_VIEWPORT_Y` |
| `render_state_get_cursor_visible` | `DATA_CURSOR_VISIBLE` |
| `render_state_get_cursor_style` | `DATA_CURSOR_VISUAL_STYLE` |
| `render_state_get_cursor_blinking` | `DATA_CURSOR_BLINKING` |
| `render_state_get_fg_color` | `DATA_COLOR_FOREGROUND` |
| `render_state_get_bg_color` | `DATA_COLOR_BACKGROUND` |
| `render_state_is_row_dirty` | `row_get` + `ROW_DATA_DIRTY` |
| `render_state_mark_clean` | `row_set` + `ROW_OPTION_DIRTY` |
| `render_state_get_grapheme` | `row_cells_get` + `GRAPHEMES_LEN`/`GRAPHEMES_BUF` |
| `terminal_get_mode` | `terminal_mode_get` |
| `terminal_write` | `terminal_vt_write` |
| `terminal_is_alternate_screen` | `terminal_get` + `DATA_ACTIVE_SCREEN` |
| `terminal_has_mouse_tracking` | `DATA_MOUSE_TRACKING` |
| `terminal_get_scrollback_length` | `DATA_SCROLLBACK_ROWS` |
| `terminal_new_with_config` | `terminal_new` + `terminal_set` per option |

### Replaced by design (1)

`render_state_get_viewport` → the row/cell iterator. This is the rewrite.

### Moves to `grid_ref` (6)

`terminal_is_row_wrapped`, `terminal_is_scrollback_row_wrapped`,
`terminal_get_scrollback_line`, `terminal_get_scrollback_grapheme`,
`terminal_get_hyperlink_uri`, `terminal_get_scrollback_hyperlink_uri`.

`grid_ref` addresses scrollback and viewport alike, so our viewport/scrollback
split collapses into one path. `ghostty_grid_ref_hyperlink_uri` and
`ghostty_grid_ref_graphemes` exist; wrap comes off `ghostty_row_get` +
`ROW_DATA_WRAP` / `ROW_DATA_WRAP_CONTINUATION`.

### Changes model (4)

- `terminal_has_response` / `terminal_read_response` → **`OPT_WRITE_PTY`**, a
  registered callback, instead of polling a queue. **This is the one with a
  correctness cliff**: `vt_write` by default *"only process sequences that
  directly affect terminal state and ignores sequences that have side effect
  behavior or require responses"*. Until effects are wired, everything renders
  correctly and device-attribute/status queries silently go unanswered.
- `terminal_last_reset_seq` / `terminal_last_cursor_style_seq` → **probably
  obsolete.** They exist because RIS discards a configured cursor and the host
  wants it back only if the application did not then set its own. `main` has
  `OPT_DEFAULT_CURSOR_STYLE` and `OPT_DEFAULT_CURSOR_BLINK`, so the core holds
  the default across a reset. Confirm before deleting them.

## Status

- [x] Decision evidence gathered (`iter.mjs`, `search.mjs`, `gridrefdepth.mjs`)
- [x] Upstream pin chosen and justified
- [x] Full export mapping
- [x] `src/lib/ghostty/main/abi.ts` — constants and typed export surface
- [x] `abi.parity.test.ts` — the constants driven against a real build at the
      pin. Six checks, green. Skips when no binary is provided, which is CI.
- [x] **Grid parity: identical bytes through both binaries, compared per cell.**
      `src/bench/gridSnapshotMain.ts` + its test. Nine cases green: text and
      cursor, all eight attributes, all five underline styles plus overline,
      palette and rgb colors, default colors, wide glyphs, scrolling, and a
      styled full screen. `search.mjs check` covers the scrollback half.
- [x] `GhosttyStyle` mapped onto our `flags` / `attrs2` bytes
- [x] **Viewport read onto the iterator** — `main/ViewportReader.ts`, asserted
      **byte-identical** to `get_viewport` across ten cases. It fills the same
      packed 16-byte buffer the renderer already consumes, so nothing
      downstream changes.
- [ ] **Select the reader in `GhosttyEngine` / `WebGLRenderer`.** Blocked on the
      binary, not on design: the shipped build is v1.3.1 and has no iterator
      API, so a pane using this reader fails at the first `render_state_new`.
      Two call sites, both replacing
      `get_viewport(term, buf, cols * rows)` with `source.read(buf, cols, rows)`:
      `WebGLRenderer.updateStaticGrid` and `GhosttyEngine.readRows`.
      `ViewportSource` names the shape.
- [ ] **Scrollback reads onto `grid_ref`.** `readRows` also calls
      `get_scrollback_line` and `get_scrollback_grapheme` per row; those move to
      `grid_ref` (resolve once per row, step `ref.x`), priced at 0.8x-0.9x by
      `search.mjs`. Same seam, not yet written.
- [ ] Responses onto `OPT_WRITE_PTY` (the silent-failure one — see above)
- [ ] `#176` extracted as a standalone patch against the pin
- [ ] Rebuild + `vendorIntegrity` hash + `gridSnapshot` green

### Not startable on this machine

Producing the new binary needs **Zig 0.16.0 on Linux/WSL**, which is not
installed here (`wsl -l -v` shows a stopped Debian with no Zig). Everything
above the rebuild line can be developed and verified against the already-built
binary at the pin; the rebuild itself is yours to run.
