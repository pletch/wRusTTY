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
ghostty-org/ghostty @ 622b4eecd7d2ce1a10930537c17f0d61abdba817
```

Chosen deliberately, not merely "what was current":

- It is the commit every ABI fact below was verified against.
- It is the commit we hold a **built binary** for. Rebuilding needs Zig 0.16.0
  on Linux/WSL, so re-pinning is a deliberate act rather than a routine bump.

`main`'s surface keeps moving — 187 exports when first measured, 202, then 201,
180, 181, 189, **189 here** — so re-pin only with a reason and re-run the checks
when you do. The long run of it going *down* was consolidation rather than a
broken build (see the ABI breaks below); the step back up was the search API at
`492300ca`.

### Moving from `492300ca` (2026-09-04) to this pin

190 commits over nineteen days, a clean fast-forward and **no ABI break**: every
exported name is unchanged (189, 187 of them functions), and the two new
terminal options were appended to the enum as `OPT_RESIZE_PULL_SCROLLBACK = 40`
and `OPT_RENDER_HOLD = 41`, so no existing key moved. The headers otherwise
changed only in comments. `abi.manifest.test.ts`, `abi.parity.test.ts` and the
whole suite passed against the new binary before anything here was touched.

Taken for three things, all reachable:

- **`9dc0d974e` + `3beb6d717`** (#14236, #14237) — ANSI DECRQM. Only the DEC
  private form (`CSI ? Ps $ p`) reached the mode-query handler; `CSI Ps $ p`
  was dropped without a reply, so a program asking about IRM or LNM waited out
  its timeout. Separately, the query identifier was truncated to 15 bits, so
  `CSI ? 32885 $ p` was answered as DEC 117. Both are pinned in
  `effects.test.ts`, and both new assertions were run against the previous
  binary and watched to fail with exactly those answers.
- **`c55f213aa`** (#14294) — `OPT_RESIZE_PULL_SCROLLBACK`. Growing the rows
  pulls lines back out of scrollback, which a ConPTY cannot follow: it keeps
  its own buffer with no scrollback, so the two disagree about what is on
  screen and later output lands on the wrong rows. `Terminal.tsx` turns it
  off for local and elevated panes through a shim-only
  `ghostty_terminal_set_resize_pull_scrollback`; `shim.test.ts` pins both
  behaviours against the shipped binary, so it runs on CI.
- **`e50779498`** (#14317) — `OPT_RENDER_HOLD`, a callback at the exact byte
  where synchronized output (mode 2026) begins and ends. Before it the core
  only set the mode bit, and we did not read that either.

Also taken: **`079502e23`**, a sorted-set mode lookup (a mode get 10.5 ns ->
3.2 ns upstream), and **`12542b392`**, Unicode 18 through `uucode`. The latter
changes widths only for the new codepoints, which nothing in
`gridSnapshot.test.ts` uses.

Inert here: Windows page reclaim (`95cfbbb05`, gated on `.windows`), the Windows
`TinyIo` (`f6cb8312b`), kitty's Windows path blocklist (`0b5446364`),
NULL-for-empty from the `*_alloc` formatters (`dd2edd760` — we call none of
them), and `compressPage`'s smaller memset (we never call `compress`).

One build-side change to know about before the next rebuild: `translate_c` is
now a path dependency (`pkg/translate-c`) whose own dependency is fetched from
**codeberg.org**, eagerly, because `build.zig` imports it at top level. The
first build at this pin failed on a codeberg outage with `unable to connect to
server: Timeout`, and there is no mirror on `deps.files.ghostty.org` or GitHub.
Waiting it out worked; `zig fetch <url>` run from the checkout pre-seeds the
cache (hash `translate_c-0.0.0-Q_BUWhVNBwDOEcIqub4VFPJPB6D9dgwzUMHTX5KWr8Xr`).

The binary grew **2,526 bytes** (1,127,956 -> 1,130,482). `scrollbackLimit.test.ts`
passes unchanged, so `SCROLLBACK_BYTES_PER_CELL` and the tier table stand, and
both parse probes land inside the ranges quoted above (search 0.8x-0.9x, raw
cells 0.9x-1.2x).

### Moving from `4540d499` (2026-08-28) to `492300ca`

148 commits over seven days, 27 of them in the vt library, a clean fast-forward
and **no ABI break**: no header changed at all, so the shim needed nothing. The
export count went 181 -> 189, all eight of them the new search API
(`ghostty_search_{new,free,tick,feed,run,set,get,get_multi}`), plus
`ghostty_terminal_point_from_grid_ref` which is not new but is now reachable
work for us. None are wired up; see `NATIVE_SEARCH_PLAN.md`.

Taken for the **key encoder**, which we drive live from `KeyEncoder.ts` on every
keystroke. Upstream built a harness comparing every US-layout combination
against xterm patch 411 and fixed what it found:

- **`4406cea3`** (#14144) — Ctrl-modified characters were encoded as C0 bytes
  under xterm's `modifyOtherKeys` 2. They are not: MOK2 wants the `CSI 27;...~`
  form. Ctrl+A went from the byte 0x01 to `CSI 27;5;97~` here. Any program that
  turns the mode on and leaves it on — emacs is the usual one — was
  reading the wrong thing from us for every Ctrl+key.
- **`e7bdda99`, `cc3fd8a7`, `37e3cdd2`, `636a2f35`** (#14145) — F13 through F25
  gained xterm's editing-key codes (F13 `CSI 25~`, F25 `CSI 46~`), Help and
  Context Menu became 28 and 29, Alt+Escape gained `CSI 27;3;27~` under MOK2,
  and the numeric keypad stopped falling through to a generic MOK2 encoding in
  normal mode. Context Menu is a physical key on most Windows keyboards, and
  before this it encoded to nothing at all.
- **`587e08f3`** (#14146) — legacy Alt-as-Escape prefixed only the first byte of
  a non-ASCII character. Alt+é sent `ESC` plus half of a two-byte sequence; it
  now sends the whole of it.

All of that is pinned in `KeyEncoder.test.ts`, including a `modifyOtherKeys`
case that did not exist before, and each new assertion was run against the
previous binary and watched to fail — Alt+é, F13 and MOK2 Ctrl+A are the three
that do.

Also taken, and worth nothing to us on its own: **`c2906398`** (#14081), the
`RefCountedSet.addWithId` over-count that over-provisions style memory.

Inert here: **#14137**, the big "treat zero as empty so fresh mmap pages are
never touched" work (48 KB -> 16 KB dirty per empty terminal upstream), reaches
nothing on wasm — `PageList.zig` `@memset`s the page anyway on freestanding
because "the WasmAllocator reuses freed slots without zeroing". **#14138** does
apply, being plain heap: the 1 KiB kitty temp-dir buffer is allocated only when
set (we never set it), `DynamicPalette` stops carrying a second 1 KiB copy of
the default palette, and the pin pool preheats two pins instead of eight.

The binary grew **7,883 bytes** (1,120,073 -> 1,127,956) — the search API is
45,478 bytes of that, measured by building the same commit with
`-Dvt-features=-search` (1,082,478 bytes), so everything else is a net saving.

`SCROLLBACK_BYTES_PER_CELL` was re-measured across all four tiers at 80 and 200
columns, old binary against new: 8.56-10.50 bytes per cell on both, differing by
at most 0.08, with the heap landing on the same step every time. `d2ff6d77`
cache-line-aligns the cell array and it costs nothing measurable. 9.2 and the
tier table stand.

### Moving from `5851d986` (2026-08-22) to `4540d499`

131 commits over six days, a clean fast-forward, and **no ABI break**: nothing
was removed and one export was added, `ghostty_terminal_paste` (`60a1ae2d`),
which the shim ignores. `abi.manifest.test.ts` re-verified every struct layout
against the new binary.

Unlike the previous bump, this one was taken for **six** terminal-core fixes,
all of them reachable from ordinary remote output:

- **`eb722cb2`** — erasing a wrapped wide character at the start of a row (ECH
  or DCH) also clears the spacer head at the end of the *previous* row, but only
  the cursor row was marked dirty. With both rows visible an incremental render
  kept the stale spacer head on screen. This is the one that matters most here,
  because the renderer is driven off exactly those per-row dirty flags.
- **`0f35043c`** — the ground-state UTF-8 fast paths classified only 0x00-0x0F
  and ESC as C0, so 0x10-0x1A and 0x1C-0x1F were decoded as ordinary codepoints
  and printed. Wrong grid, and bizarre font fallback with it (U+0014 finding CJK
  fonts). Upstream #14021.
- **`40a40f84`** — the same fast paths printed UTF-8-*decoded* C1 controls.
  Now dropped, matching xterm; libvte executes them and there appears to be no
  standard either way.
- **`4e817e79`** — `dcs_passthrough` forwarded only 0x00-0x7E, so any DCS
  payload carrying UTF-8 was corrupted: in "Ü" (0xC3 0x9C) the 0x9C acted as
  8-bit ST and ended the string mid-character, and a payload byte of 0x9B moved
  the parser to `csi_entry`, executing the remainder of the payload as control
  sequences. Fixed in the parse table only, deliberately diverging from
  vt100.net exactly as `osc_string` already does.
- **`b31fbc84`** — scroll, line-insert and erase cleared cells but left row
  metadata (wrap flags, semantic prompt state) behind, which the fast paths in
  `grow` and resize then adopted. Upstream #13940; benchmarked as free.
- **`9313d580`** — clearing the screen into scrollback across a page boundary
  left the cursor holding style and hyperlink IDs belonging to its old page. A
  debug build traps; a release build silently corrupts reference counts, which
  is what we ship. Found by fuzzing in #13991.

The three parser fixes were checked differentially against the previous binary
before this was written: `A\x14\x15\x16B` printed the control codes, `A<U+0085>
<U+009B>B` printed both C1s, and `ESC P q ; Ü ; tail ST X` printed `;tailX`
instead of `X`. All three are correct on this pin.

Inert here, as before: the large kitty clipboard / paste / drag-and-drop batch
(`6959fd46`..`bc2f7d7d`, plus mode 5522) needs callbacks we do not register, and
`94b6dae4` explicitly gates 5522 reports on a clipboard-read callback — which
sits well with leaving `CLIPBOARD_READ = 38` unset. `dda8e6f3`'s secure-random
override is a swappable pointer used only by clipboard grants. `ee8095d3` is
snapshot-only and we call no snapshot API. `8c5bc3d2` SIMD-optimises OSC string
reading, which is the path `oscScanner.ts` runs ahead of; both parse probes were
re-run and are unchanged.

That batch is most of the cost: the binary grew **71 kB** (1,049,099 ->
1,120,073) for six fixes we wanted and a clipboard protocol we cannot reach.
Which is the sharpest argument yet for `-Dvt-features` below.

`scrollbackLimit.test.ts` drives this binary for both the footprint staircase
and the retention band, and passes unchanged — so `SCROLLBACK_BYTES_PER_CELL`
and the tier table still hold at 9.2 and their measured budgets despite the
extra static data.

### Moving from `d9ffbbf17` (2026-08-19) to `5851d986`

131 commits, a clean fast-forward, and **no ABI break at all** — the export
surface is byte-for-byte the same 180 names, and every struct layout `abi.ts`
transcribes is unmoved (`abi.manifest.test.ts` re-verified against the new
binary). The bump was taken for one commit:

- **`33cda4dc`** — a use-after-free in `Terminal.print`'s wide/grapheme path.
  Four sites held a raw cell pointer across an operation that can grow, and so
  replace, the page underneath it: the spacer-tail write growing the page to fit
  the cursor hyperlink, the grapheme move after a wrap, the `appendGrapheme`
  loop, and `printCell`'s assert after a failed hyperlink write. In wasm the
  result is a write into freed linear memory — silent corruption, not a trap.
  The hyperlink variants need OSC 8 output (`ls --hyperlink`, `gh`, `delta`)
  alongside an emoji; the wrap variant needs only a VS16-widened character
  landing at the right margin, which is ordinary remote output. Upstream
  #11261.

Everything else in the range is inert here: kitty graphics (animation, relative
placements, validation), the new kitty clipboard protocol (OSC 5522), and OSC 99
desktop notifications. The binary grew 19.5 kB (1,029,546 -> 1,049,099) carrying
them, which is the argument for `-Dvt-features` below rather than against the
bump.

One addition worth knowing about and **deliberately not adopted**:
`GHOSTTY_TERMINAL_OPT_CLIPBOARD_READ = 38` (`e03475c0`), which answers OSC 52
`?` queries. Leaving it unset is the point — it is a read channel from the
user's clipboard to whatever is on the far end of the connection.

### Moving from `6b22215c` (2026-08-14) to `d9ffbbf17`

120 commits, another clean fast-forward, and **two more ABI breaks**:

- **`a8e9b413f`** retired the type-specific wasm allocators.
  `ghostty_wasm_alloc_u8_array` / `_free_u8_array` / `_alloc_usize` /
  `_free_usize` are gone; there is one `ghostty_wasm_alloc(len)` /
  `ghostty_wasm_free(ptr, len)`, plus a new `ghostty_wasm_take_opaque(slot)` that
  replaces reading the slot with a `DataView`. Buffers are now aligned to the
  target's maximum C ABI alignment (16), which several call sites here were
  quietly assuming. This is most of the 201 -> 180 drop.
- **`16c833c5f`** removed `ghostty_render_state_colors_get` in favour of an
  `RS_DATA_COLORS` key, and added `RS_DATA_CURSOR` — a structured cursor read
  that replaces the eight separate gets a renderer needed per frame.

Note the split this exposed: `KeyEncoder`, `MouseEncoder` and `pasteEncode` live
outside `main/` but talk to the **raw** `main` ABI, not the shimmed one. They are
easy to miss when migrating and the failure is a load-time
`ghostty_wasm_alloc_u8_array is not a function`. `tools/parse-probes/` boot both
binaries in one process, so they keep the legacy names and get them supplied over
whichever API the binary has — see `tools/parse-probes/allocCompat.mjs`.

Two things adopted but not yet used: `RS_DATA_CURSOR`/`RS_DATA_COLORS`, and
upstream's `-Dvt-features` (`1fdbb8c91`) for trimming the binary. The shipped
`.wasm` fell 22% on its own (1,319 kB -> 1,030 kB) without it.

### Moving from `48d85eae` (2026-08-04) to `6b22215c`

This pin is 294 commits ahead, a clean fast-forward. Three things matter:

- **ABI BREAKING (upstream `cfc19e805`).** `ghostty_terminal_mode_get` and
  `_mode_set` are **gone**, folded into the generic
  `ghostty_terminal_get`/`_set` under `GHOSTTY_TERMINAL_DATA_MODE = 37`, which
  is an *in/out* key taking a `GhosttyTerminalModeConfig`. This is the whole
  export-count decrease (−2), partly offset by `+ghostty_terminal_vt_write_until_ground`.
  `main/shim.ts` does the struct dance; `main/abi.ts` carries the offsets.
- **wasm now builds with `simd128` by default** (upstream `87f69a12e`), and the
  batched parse path is no longer gated on `build_options.simd`. Same build
  command, different code. See `../src/lib/ghostty/vendor/README.md`.
- **Measurements below are from the previous pin unless stated.** Upstream
  landed a large wasm-embedder performance push in this range (`vt_write`
  1.4x-13x, full-screen cell reads ~10x via a new bulk row API). Nothing here
  has been re-benchmarked against it, so treat the numbers as conservative
  rather than current.

Note also that both `tools/parse-probes` scripts need the **v1.3.1** binary as
their comparison arm (`vendor-131/`), not `vendor/` — that path has held a
*main* build since the port, and passing it produces
`ghostty_terminal_new_with_config is not a function`, which looks like a bad
build and is not one. The default was corrected on 2026-08-14.

### Building the pinned binary

```sh
git clone https://github.com/ghostty-org/ghostty.git
cd ghostty && git checkout 622b4eecd7d2ce1a10930537c17f0d61abdba817
git apply ../patches/ghostty-main-esc-k.patch   # #176, the only carried fix
zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
# -> zig-out/bin/ghostty-vt.wasm
```

Requires **Zig 0.16.0** (`minimum_zig_version` in `build.zig.zon`), against
0.15.2 for the v1.3.1 build. Linux or WSL — building natively on Windows hits a
Zig `ftruncate`/`FileTooBig` bug in the unicode table generator.

## ABI facts that cost time to find

None of these are derivable by reading the headers, and each fails *silently*.

- **`GhosttyPoint` is `tag@0, x@+8, y@+12`, and it is 24 bytes, passed by
  pointer.** `point.h` declares `{ tag; value }` over
  `{ uint16_t x; uint32_t y; }`, which reads as `x@+4, y@+8`. The union carries
  an 8-aligned member so `value` starts at +8. Get the offsets wrong and the
  coordinates land in each other's fields — you read a real cell from the wrong
  place, with no error. The tell is `y=1` returning column 1 of row 0.

  **The size said 16 here until 2026-08-19 and that was wrong.** The union is 16
  bytes, not the 8 its coordinate arm uses, so the struct runs to 24. Probing
  found every offset and could not find the size, because a field nobody reads
  has no observable position. Nothing broke — the core over-read into the unused
  arm — but `ScrollbackReader` under-allocated it and zeroed two thirds of what
  its own comment said had to be zeroed. This class of error is now caught by
  `src/lib/ghostty/main/abi.manifest.test.ts`, which asserts every layout here
  against `ghostty_type_json`; prefer that over probing for anything new.
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

## Native search, and the four types it brought with it

`NativeSearchController` is the second thing after `KeyEncoder` to reach past
the shim and talk to `main` exports directly, for the same reason: the v1.3.1
build has no `ghostty_search_*` at all, so there is nothing to shim them to.
`create` returns null when they are missing and the engine keeps the JS
`SearchController` — which it has to keep anyway, because the core's matcher is
byte-exact except for ASCII case and cannot do regex or a case-sensitive query.
`GhosttyEngine.search` routes on exactly that. `docs/NATIVE_SEARCH_PLAN.md` is
the full record.

The ABI facts, none of them guessable and all of them now asserted against
`ghostty_type_json` in `abi.manifest.test.ts`:

- **`GhosttySelection` is 32 bytes**: `size@0`, `start@4`, `end@16`,
  `rectangle@28`, where the endpoints are 12-byte `GhosttyGridRef`s rather than
  coordinates. It is a *sized* struct, so its first word must be written before
  the core reads it — including into **every element** of a selection buffer,
  which the core reads element by element rather than taking the first one's
  word for it.
- **`GhosttySelectionBuffer` is the two-call protocol**: `{ ptr, cap, len }`,
  and asking for the required size (`ptr = 0, cap = 0`) answers
  `GHOSTTY_OUT_OF_SPACE` with the count in `len` — **not** success. Code that
  runs the query through `expectOk` throws on the normal path.
- **`GhosttyPointCoordinate` is not `GhosttyPoint`.** It is the out-parameter of
  `point_from_grid_ref`, it is 8 bytes, and `y` is at +4 (a u32 after a u16 is
  aligned), against the 24-byte union-carrying `GhosttyPoint` above.
- **`GhosttyString` is `{ ptr, len }`** and the needle's bytes are copied, so
  the buffer they came from is free the moment the call returns.

And three facts about behaviour that cost as much to find as any layout:

- **A match is only valid until the next terminal write.** Every read here is
  feed, read, convert to plain integers, done — nothing is cached across a
  frame, which is the opposite of what `SearchController` does.
- **Counts are stale until fed.** A write with no feed leaves
  `TOTAL_MATCHES` reporting the old number while the status still says
  COMPLETE, which reads exactly like a correct answer. `nativesearch.mjs`
  demonstrates it on purpose.
- **`VIEWPORT_MATCHES` is the core's viewport, not ours.** We scroll by our own
  offset and never move the core's, so that field describes the bottom of the
  buffer no matter where the pane is looking. It shipped that way for an hour
  and drew no highlights at all on a scrolled-back pane. The controller uses
  `MATCHES` — the whole list, descending by row — and binary-searches it for
  the visible window.

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

### What reaches past the shim

The three input encoders: keys (`lib/ghostty/KeyEncoder.ts`, constants in
`main/keyAbi.ts`), the mouse (`lib/ghostty/MouseEncoder.ts`, constants in
`main/mouseAbi.ts`), and paste (`lib/ghostty/pasteEncode.ts`). They are the
only things in the app that talk to `main`'s exports directly rather than
through `GhosttyExports`, and the reason is structural rather than laziness:
the shim's job is to present *our* 83-export ABI over main's 202, and our ABI
has no input encoding in it at all — there is nothing on the v1.3.1 build for
it to be shimmed *to*. Adding it to `GhosttyExports` would mean inventing an
export that only one of the two implementations could ever answer, which is
exactly the shape the shim exists to avoid.

So each of them checks its exports are present and says so when they are not —
`create` returning null for the two encoders, `hasPasteEncoder` for the third.
That means a pane with no control keys, one that reports no mouse, or one that
falls back to counting lines before a paste; only the oracle build can produce
any of it and no user can reach it.

Paste is a module of functions rather than a class because that is what it is
upstream: no handle, no terminal, no state. Bracketing is passed in by the
caller, since DEC 2004 is the only terminal state involved.

That surface is 30 exports (`ghostty_key_event_*`, `ghostty_key_encoder_*`,
`ghostty_mouse_event_*`, `ghostty_mouse_encoder_*`, `ghostty_paste_*`),
declared on `GhosttyMainExports` with the same rule as the rest of that
interface: listed because there is a use for it and the signature has been
checked. Checked literally, for the mouse: `GhosttyMousePosition` is two floats
passed *by value* in the header, and on wasm32 that lowers to a pointer, which
was read off the binary's own type section rather than assumed. And for paste,
`ghostty_paste_encode` modifies its **input** buffer in place, so a retry has
to refill it rather than reuse what the failed call left behind.

With paste done, the hand-rolled input paths are gone. What is left out here is
policy rather than encoding: which button is held, how often motion is worth
sending, and whether to ask before pasting.

### Left open

- **Two exports the app no longer needs.** `render_state_is_row_dirty` has no
  caller (the shim implements it honestly anyway — a stub answering "clean" is
  the shape of bug that hides itself), and `hyperlinkId` is 0 on every cell
  because main's render iterator does not carry one. `LinkController` works off
  text, so nothing reads it; a hyperlink-aware feature would need `grid_ref`.
- **Per-row dirty is now correct, and still uncalled** (`2e62b73`). Two things
  were wrong under the honest implementation and only findable by measuring:
  `mark_clean` cleared the global flag and not the per-row layer, so a viewport
  stayed every-row-dirty forever after — invisible while nothing reads it, and
  quietly wrong on the *second* frame for the first thing that does — and
  `rowDirty` walked the iterator y times to reach row y instead of using
  `next_dirty` to jump between dirty rows. Both fixed, with the two-frame test
  that is the only kind that catches the first. Worth knowing before adopting
  dirty-row rendering: the rows offered include the one the cursor *left*, so a
  one-row edit reports two.
- **The renderer still redraws the whole viewport.** Main can
  skip clean rows at 0.05x-0.14x of a full read (`iter.mjs`), which is the one
  measured *improvement* the new API offers. It was the obvious next thing to
  take; it is now deliberately **not** being taken. Same page, same probe: the
  worst full redraw is 0.21 ms against an 8.3 ms frame, so the saving is a
  fraction of ~2.5% of budget, bought with the most invasive renderer change on
  the list. Tracked as B3 in `docs/EVALUATION_DECISIONS.md`, where it is now
  closed as rejected rather than deferred. The capability is real and stays
  documented here for whoever finds an actual bottleneck on this path — but
  reach for it then, not on the strength of the ratio alone.

### Rebuilding

Producing the binary needs **Zig 0.16.0 on Linux/WSL** — it is installed in the
WSL Debian on this machine; drive it with `wsl.exe -e bash -lc`. The recipe,
the strip step and what has to be re-measured afterwards are in
`src/lib/ghostty/vendor/README.md`. Build under `~`, not `/mnt/c`.
