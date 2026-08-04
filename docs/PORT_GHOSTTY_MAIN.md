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
- **The packed cell's payload is a union** — a codepoint, *or* a background
  colour for a cell with no text. Unpacking it unconditionally turns a blank
  painted by `ED`/`EL` into a control character: a cleared row with background
  `0x445566` reads back as codepoint 1. Check the content tag first.
- **`grid_ref` has no resolved-colour accessor.** The render iterator's
  `FG_COLOR`/`BG_COLOR` keys flatten a cell's colour from its three sources;
  `grid_ref` hands over the raw cell and the style and nothing else, so a reader
  has to reproduce the rule — foreground from the style with palette indices
  resolved, background from the cell's **content tag ahead of** the style. The
  order only shows on cleared regions.
- **`grid_ref_graphemes` does not answer a null-buffer length query.** Asked
  with `buf = 0, len = 0` it reports nothing rather than the size required.
  Give it a real buffer; it writes the needed length even when it has no room.
- **Callback options take the function pointer *itself* as `value`** — not a
  pointer to it, unlike every scalar option. The wrong form returns
  `GHOSTTY_SUCCESS` and then traps inside `vt_write` with "table index is out of
  bounds", because the core used the address as a table index.
- **A JS closure cannot be installed as a callback.** It is not a `funcref`;
  `Table.set` rejects it and `WebAssembly.Function` is unavailable. An exported
  wasm function is valid, so `effects.ts` carries a hand-assembled trampoline
  module. The build exports `__indirect_function_table` and it is growable,
  which is what makes this possible at all.
- **Effect callbacks fire *during* `vt_write`, not after**, and must not
  re-enter it on the same terminal. Buffer and hand over once the write returns.
- **Replies are only valid for the duration of the callback.** Copy them; a view
  over wasm memory is overwritten by the next write.
- **`ghostty_terminal_mode_get` takes three arguments, not four.** Our ABI takes
  `(mode, is_ansi)`; `main` folds both into one `GhosttyMode` — a DEC private
  mode is its bare number, an ANSI mode is `number | 0x8000`. The four-argument
  call fails in the worst available way: JS drops the extra argument, the *out
  pointer* lands in the mode slot, the write goes to address 0, and the call
  returns `SUCCESS` while the caller reads its own stale buffer. A mode query
  then answers "still set" forever. `GhosttyMode` is declared in a header we do
  not vendor, so the encoding was probed: after `ESC [ 4 h`, mode `4` reads back
  false (DEC 4 exists and is unset) and `4 | 0x8000` reads back true.
- **Our `is_row_wrapped` is main's `ROW_DATA_WRAP_CONTINUATION`**, not
  `ROW_DATA_WRAP`. The pair are the two ends of one wrap, both answer plausibly,
  and `logicalLines` joins on "this row continues the one above". Taking `WRAP`
  shifts every joined line up by a row: on a two-row line the vendored build
  flags row 1 and `WRAP` flags row 0.
- **The cursor style enum is renumbered.** Ours is block=0, bar=1; main's is
  bar=0, block=1 (underline and hollow agree). Passing the value through gives
  every DECSCUSR the other shape, with no call ever failing.
- **Cursor viewport coordinates are `uint16_t`,** as are `COLS`/`ROWS` — reading
  them as words happens to work only while the scratch above them is zeroed.
  Their validity is gated by `CURSOR_VIEWPORT_HAS_VALUE`; when it is false the
  x/y are explicitly undefined, so "visible" on our side has to mean both.
- **A default foreground only sticks if a background is set too.** Set
  `OPT_COLOR_FOREGROUND` alone and the *render state* reports plain white
  forever, while `terminal_get(COLOR_FOREGROUND)` reports the colour that was
  set — the two disagree, so nothing looks wrong. Set both, in either order,
  and both apply; black counts. This bites through our config, where `0` means
  "let the core pick": a theme whose background is `#000000` packs as 0, the
  background set gets skipped, and every unstyled cell in the pane is drawn in
  the wrong foreground. The shim therefore writes both always, substituting the
  core's current value for a zero field. Found by the `run-wrustty` driver, not
  by the suite — no test had a black background.
- **The default scrollback budget is 10,000 *bytes*** — 370 rows at 200 columns.
  Measured, not read. Anything that creates a terminal and does not set
  `OPT_SCROLLBACK_MAX_BYTES` has a scrollback of nothing much. Setting bytes
  alone is enough; `MAX_LINES` is unset by default and does not bind.

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
| `terminal_get_mode` | `terminal_mode_get` (three args; `is_ansi` is bit 15 of the mode) |
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
  registered callback, instead of polling a queue. **Done** — `main/effects.ts`.
  This was the one with a correctness cliff: `vt_write` by default *"only
  process sequences that directly affect terminal state and ignores sequences
  that have side effect behavior or require responses"*, so until effects are
  wired everything renders correctly and device-attribute/status queries
  silently go unanswered. A test pins that default so it stays a known fact
  rather than a rediscovered one.
- `terminal_last_reset_seq` / `terminal_last_cursor_style_seq` → **superseded,
  but not yet replaced.** They exist because RIS discards a configured cursor
  and the host wants it back only if the application did not then set its own.
  `main` has `OPT_DEFAULT_CURSOR_STYLE` and `OPT_DEFAULT_CURSOR_BLINK`, so the
  core holds the default across a reset and the ordering question disappears.
  Setting them needs a cursor style in `TerminalConfig`, which it does not
  carry, so the shim answers both with 0 and `restoreCursorAfterReset` never
  fires. Tracked in the status list — it is the port's one open behaviour gap.

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
- [x] **The shim: our whole export surface over `main`** — `main/shim.ts`.
      Supersedes the "two call sites" plan below, which was too narrow: the
      viewport is two call sites, but `GhosttyEngine` reaches for twenty-odd
      exports across the render loop, search, links, mouse reporting and resize,
      and all of them move with the binary. So the boundary moves instead of the
      callers — `shimMainWasm(instance)` hands back exactly the `GhosttyExports`
      object the app already talks to. 24 cases in `shim.test.ts`, each driving
      **both builds through the same call sequence** and comparing: viewport
      bytes, cursor position and shape, dimensions, modes, alternate screen,
      mouse tracking, scrollback depth and rows, wrap in both coordinate spaces,
      graphemes, replies, and two terminals in one instance.
      `isMainBuild(instance)` selects on the binary rather than a build flag.
- [x] **`instantiateGhosttyModule` selects the ABI from the binary.** One
      branch on `isMainBuild(instance)`, so which `.wasm` is vendored is the
      whole of the switch and no build flag can fall out of step with it.
- [x] **Cursor restore across RIS, without the host doing it.**
      `TerminalConfig` carries `cursorStyle` / `cursorBlink` into
      `OPT_DEFAULT_CURSOR_STYLE` / `_BLINK`, and the core holds the preference
      across the reset. `last_reset_seq` / `last_cursor_style_seq`,
      `restoreCursorAfterReset` and `shouldRestoreCursor` are **removed** —
      `cursorResetLive.test.ts` passes unchanged through the new mechanism,
      which is what made deleting the old one safe rather than hopeful. The
      residue: a preference changed *after* a pane opens reaches the live cursor
      but not that pane's reset default.
- [x] **Scrollback reads onto `grid_ref`** — `main/ScrollbackReader.ts`, also
      byte-identical, nine cases including cleared regions and clusters.
- [x] **Responses onto `OPT_WRITE_PTY`** — `main/effects.ts`. Ten cases,
      including a *negative* one pinning the silent default (no callback, no
      replies) and a comparison against what the vendored queue answers for the
      same queries.
- [x] `#176` extracted as a standalone patch against the pin, and a binary at
      the pin built with it applied — `patches/ghostty-main-esc-k.patch`,
      `main/vendor-main/`. The parity suite asserts the *behaviour* (an `ESC k`
      payload is swallowed), not `git apply`'s exit code.
- [x] **The binary swapped.** `vendor/ghostty-vt.wasm` is `main` at the pin,
      stripped: 1,308,136 bytes against 742,403, the port's whole size cost.
      `vendorIntegrity` re-pinned, `gridSnapshot` (against xterm.js) green, and
      the full suite green — 906 tests, the engine running on `main` throughout.
      The v1.3.1 build moved to `vendor-131/` and is now the comparison oracle:
      without a second implementation the parity suites would be comparing
      `main` with `main` and passing for nothing.
- [x] **Scrollback re-measured, because its costs are the core's.** A row costs
      ~9.2 bytes per cell on `main` against 12.65 on v1.3.1, and the bigger
      binary moves every WASM heap step, so both `SCROLLBACK_BYTES_PER_CELL` and
      the footprint tier table were re-derived by flooding the new core. The
      tiers now buy *more* depth from smaller budgets. Nothing but
      `scrollbackLimit.test.ts` would have noticed: the setting is a byte budget
      and every symptom of getting it wrong is silent.

### Left open

- **Two exports the app no longer needs.** `render_state_is_row_dirty` has no
  caller (the shim implements it honestly anyway — a stub answering "clean" is
  the shape of bug that hides itself), and `hyperlinkId` is 0 on every cell
  because main's render iterator does not carry one. `LinkController` works off
  text, so nothing reads it; a hyperlink-aware feature would need `grid_ref`.
- **Per-row dirty is unused.** The renderer redraws the whole viewport. Main can
  skip clean rows at 0.05x-0.14x of a full read (`iter.mjs`), which is the one
  measured *improvement* the new API offers and the obvious next thing to take.

### Rebuilding

Producing the binary needs **Zig 0.16.0 on Linux/WSL** — it is installed in the
WSL Debian on this machine; drive it with `wsl.exe -e bash -lc`. The recipe,
the strip step and what has to be re-measured afterwards are in
`src/lib/ghostty/vendor/README.md`. Build under `~`, not `/mnt/c`.
