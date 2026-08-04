# `ghostty-131-wasm-api.patch`

The WASM terminal API our engine talks to, rebased onto the **Ghostty v1.3.1
release tag**. This is what builds `src/lib/ghostty/vendor/ghostty-vt.wasm`.

We carry it ourselves rather than tracking `coder/ghostty-web`. That project has
been bursty — a four-month gap from Feb 24 to Jun 26, then a short burst, with 27
open PRs and the whole Feb-April backlog unmerged, including three fixes this
build depends on. Owning the patch also pins us to a **released tag** instead of
unreleased upstream, and — the load-bearing reason — lets us keep the **batched**
`get_viewport`, one call for the whole viewport. Ghostty `main`'s newer render
API replaces that with a per-cell row/cell iterator that measured **2.9x-4.1x**
more expensive (`tools/parse-probes/iter.mjs`).

**That gap has since narrowed, and the reason is worth knowing before the next
rebase.** Re-measured against `main` at `48d85eae`, the iterator's
`ROW_CELLS_DATA_RAW` returns the whole cell as one u64, which takes four calls
per cell down to one: **0.9x-1.3x** of the batched read for the cell alone, and
**1.4x-2.5x** once the resolved colors our ABI hands over for free are fetched
too. Skipping clean rows — which the batched read cannot do at all — makes a
one-row edit **0.05x-0.14x**. So the render API is no longer the thing that
pins us to the tag; the numbers and their caveats are in
`tools/parse-probes/README.md`.

The rebase itself changed nothing on this side: it landed **byte-identical to
the previous ghostty-web build at 79 exports, same names**, so `GhosttyEngine.ts`
and `wasmBindings.ts` needed no changes. The exports under "What we added on
top" came afterwards, deliberately, and take it to 84.

## Building

Requires **Zig 0.15.2** — the same toolchain as before. (Ghostty `main` requires
0.16.0; the 1.3.1 tag does not, which is part of why the tag is the better
target.) Linux or WSL; building natively on Windows hits a Zig
`ftruncate`/`FileTooBig` bug in the unicode table generator.

```sh
git clone --depth 1 --branch v1.3.1 https://github.com/ghostty-org/ghostty.git
cd ghostty
git apply ../patches/ghostty-131-wasm-api.patch
zig build lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
cp zig-out/bin/ghostty-vt.wasm ../src/lib/ghostty/vendor/ghostty-vt.wasm
```

Verify with `npx vitest run` (421 tests; `gridSnapshot.test.ts` is the real gate —
it feeds identical bytes through Ghostty and xterm.js and compares glyphs,
colours, attributes and cursor per cell) and
`node tools/parse-probes/probe.mjs src/lib/ghostty/vendor/ghostty-vt.wasm`.

## What the patch contains

The terminal and render-state C API does not exist in any released
`libghostty-vt`: the v1.3.1 tag ships only `result`, `allocator`, `osc`, `sgr`,
`key`, `paste` and `wasm` headers — **51 exports, no terminal, no render state**.
`src/terminal/c/terminal.zig` (+1150, a new file) is that whole API. Everything
else is small: only ~30 lines touch Ghostty's own internals.

Carried from `ghostty-web`, all three still unmerged into the v1.3.1 tag. Two of
the three are **already fixed on `main`**, which matters for the rebase and is
recorded under each below.

- **#142 zero-initialize WASM page buffers** (`PageList.zig`). **Do not drop
  this.** The WASM allocator reuses freed memory without zeroing, and
  `gridSnapshot.ts` shares one cached WASM instance across snapshots, so a new
  terminal is handed recycled pages. Without it a terminal inherits the previous
  one's cells *and their style ids*, which corrupts the ref-counted style set —
  observed as leftover text from a previous test, `error(screen): style addition
  failed after capacity increase`, and eventually a hard crash of the test
  worker.
  **On `main`: already fixed, drop it.** Both call sites in `PageList.zig` guard
  with `std.debug.runtime_safety or builtin.os.tag == .freestanding`, and the
  comment states the same WASM-allocator reasoning. Their condition is the better
  one — it is the allocator that matters, not the ISA, which is what our
  `builtin.target.cpu.arch.isWasm()` keys off.
- **#176 ignore `ESC k` payloads** (`Parser.zig`, `parse_table.zig`). Adds a
  `screen_title_string` state. v1.3.1 does **not** handle this natively —
  verified: without it, `ESC k SCREENTITLE ST` renders `SCREENTITLE` onto the
  grid.
  **On `main`: still missing, keep carrying it.** `main` has no `screen_title`
  state and no `0x6B` transition in `parse_table.zig`, and the same test renders
  `SCREENTITLE` on a `main` build. Note this is *not* a matter of wiring an
  effect callback — a parser that has no state for the sequence prints the
  payload whatever the embedder configures. ~25 lines, self-contained and
  plausibly acceptable upstream; a PR would take the carried burden to zero.
- **#177 stabilize viewport row reads** (`c/terminal.zig`). Reads rows from
  `RenderState.row_data` rather than walking pins, which keeps rows coherent
  across page boundaries.
  **On `main`: moot.** It patches a file this patch itself creates; `main` ships
  its own render state.

Plus **#180**, merged upstream, in corrected form.

## What we added on top

Three parity gaps were marked "upstream, cannot be closed on this side of the
ABI". That was true of `ghostty-web@0.4.0`, whose export surface we could not
extend. It is not true now, and all three are closed here:

- **`GhosttyCell.attrs2`** — overline and *which* underline (single, double,
  curly, dotted, dashed). The core always carried these; our packing collapsed
  every underline into one bit and never read overline. They ride in what was
  the struct's padding byte, so a cell is still 16 bytes and nothing sized
  against `CELL_BYTES` changed. `flags` keeps its "underlined at all" bit, so a
  reader that ignores `attrs2` behaves exactly as before.
- **`ghostty_terminal_is_scrollback_row_wrapped`** — the scrollback form of
  `is_row_wrapped`, which was viewport-only. Search now joins a wrapped line
  into the single logical line it is before matching, instead of missing any hit
  that straddled the wrap.
- **`ghostty_render_state_get_cursor_style`** and
  **`ghostty_render_state_get_cursor_blinking`** — both halves of DECSCUSR. The
  core tracked the shape and the blink (mode 12) and `render.zig` already put
  both on the render state; only the getters were missing. The blink one is not
  optional garnish: without it `ESC[1 q` and `ESC[2 q` render identically,
  because the pane blinks on its own 530 ms timer regardless. The core now says
  *whether* to blink and the timer only says *when*.
- **`ghostty_terminal_last_reset_seq`** and
  **`ghostty_terminal_last_cursor_style_seq`** — ticks that order a full reset
  against the application setting the cursor. RIS returns the core to a steady
  block, discarding a configured cursor, and the host wants to put it back — but
  only if the application did not then choose its own, which a TUI commonly does
  in the same write. Ordering it in the core avoids the host scanning the byte
  stream for `ESC c`, which is guesswork: the bytes split across writes and
  appear inside payloads that are not sequences.

That takes the surface from 79 exports to 84. A fourth gap, Primary Device
Attributes, turned out never to have been one — `ESC[c` already replied
`ESC[?62;22c`, on the old binary too.

## Fixes made during the rebase — read before upgrading again

The 1.2-era patch applied to v1.3.1 with only two rejects, but several things
needed real changes:

- **`semantic_prompt.Command` gets `pub const C = void`.** Its
  `options_unvalidated` is a slice, so it cannot live in the extern C union
  `lib/union.zig` builds over stream actions. This is exactly how `main` solves
  it. Unpatched 1.3.1 only compiles because Zig never forces that union's
  construction; adding the terminal API forces it. Upstream flags the gap
  themselves: *"Before shipping an ABI-compatible libghostty, verify this."*
- **OSC 133 collapsed to one line.** 1.3.1 restructured it into
  `Command { action, options }` with `readOption()`, and `Terminal.semanticPrompt()`
  now does the row marking the old patch hand-rolled — five cases became one call.
- **Fallibility drifted both ways.** `restoreCursor`, `horizontalTab` and
  `horizontalTabBack` became infallible (drop `try`); `scrollUp` became fallible
  (add `try`).
- **#180's stale-cell fix had to be rewritten.** Upstream's version does
  `row.* = .{ .cells = cells_offset, .dirty = dirty }` after clearing. In 1.3.1
  `Row` is a packed struct that also carries `wrap`, `wrap_continuation`,
  `grapheme`, `styled`, `hyperlink`, `semantic_prompt` and
  `kitty_virtual_placeholder`, so that assignment clears `styled` *behind* the
  style set while it still holds references. `clearCells` already releases each
  cell's `style_id` and fixes those flags itself, so the correct fix is simply to
  drop the `if (bg_color != .none)` guard and reassign nothing.

## Performance against the old 1.2 build

**At parity.** An earlier note here claimed long SGR was ~10% slower; that was a
measurement artifact and is withdrawn. `probe.mjs` was timing a single pass with
all three probes sharing one process, so whichever ran last inherited the heap
the earlier ones grew. It now takes best-of-three and accepts an explicit probe
order.

Measured properly:

| | 1.2 | 1.3.1 |
| --- | --- | --- |
| printable | 96.9 | 95.2 MB/s |
| escape every 80 cells | 92.5 | 90.1 |
| escape every 8 cells (TUI-ish) | 74.1 | **74.0** |
| escape every 1 cell | 58.8 | 58.0 |
| short SGR, isolated | 51.9 | 52.2 |
| long SGR, isolated | ~104 | ~102 |
| render, 200x60 | 85.4us | 86.3us |

One oddity is recorded but not chased: long SGR measures ~7% slower on 1.3.1
**only when the printable probe ran first** (104 -> 95), while 1.2 in the same
sequence speeds up to 106. It is not the zero-init patch — a build with #142
reverted shows the identical number — and printable itself is unaffected either
way. No real workload has that shape. `tools/parse-probes/sgrdiff.mjs` sweeps
parameter count, digit count and separator kind across two binaries if it ever
needs revisiting.

Both projects are MIT, so carrying `ghostty-web`'s work with attribution is fine.
