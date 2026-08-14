# Parse probes

Headless harnesses for measuring the Ghostty parse path and the JS OSC scan,
outside the app and outside a browser. Plain `.mjs`, no build step — they are
dev tools, not app code, which is why they live here rather than under `src/`.

> **Both probes take two binaries, and the second one must be the v1.3.1
> build.** They compare main's iterator against the batched `get_viewport` that
> only the v1.3.1 ABI has, so the comparison arm needs
> `src/lib/ghostty/vendor-131/ghostty-vt.wasm`.
>
> That second argument used to default to `src/lib/ghostty/vendor/ghostty-vt.wasm`,
> which was the v1.3.1 build until the port put a **main** binary at that path.
> From then on both probes died on
> `ghostty_terminal_new_with_config is not a function` — the v1.3.1 ABI asked of
> a main binary — which reads convincingly like "the probe is broken" or "the
> new binary is bad" and is neither. Fixed on 2026-08-14 by pointing the default
> at `vendor-131/`; the one-argument invocations below work again.

Two things make this possible and are worth not breaking:

- The vendored `ghostty-vt.wasm` keeps its **name section**, so V8 attributes
  ticks to real Zig symbols — all 444 of them. (The stock npm build strips it.
  The DWARF that used to sit alongside it is gone as of
  `tools/strip-wasm-debug.mjs`: it was 2,556 kB of the binary's 3,299 kB and
  nothing here read it, which took the file to 742 kB against 538 kB of code.
  Do not put it back to make these tools work — they never used it.)
- The WASM imports exactly one function, `env.log`, so it instantiates headless
  with a stub.

The driver reproduces the browser to within noise — 54.3 MB/s short SGR against
the browser's 54.3 — which is the check that matters. If that stops holding, the
profile is of something other than what the app does and nothing else here is
worth reading.

## Scripts

| script | what it answers |
| --- | --- |
| `probe.mjs` | the three `workloads.ts` parse probes, headless. Fidelity check. |
| `diff.mjs` | envelope / handler / style cost, one property varied at a time |
| `diff2.mjs` | per-byte floor, and whether escapes damage the printable bulk path |
| `diff3.mjs` | re-runs the suspect rows with an `env.log` counter (see below) |
| `scan.mjs` | `scanOsc` in ms/MB per content shape |
| `viewport.mjs` | cost of getting a frame's cells out, and the JS→WASM call floor |
| `iter.mjs` | the same, driven through ghostty **main**'s row/cell iterator API, including the RAW packed-cell path and a dirty-rows-only frame |
| `search.mjs` | the **scrollback search** path — today's row-at-a-time read against main's `grid_ref`. `check` mode gates it |
| `gridrefdepth.mjs` | whether `grid_ref` resolution is O(scrollback depth) |
| `names.mjs` | function names from the name section, filtered |
| `secs.mjs` | section sizes |

```sh
node tools/parse-probes/probe.mjs src/lib/ghostty/vendor/ghostty-vt.wasm all 40
node tools/parse-probes/diff.mjs  src/lib/ghostty/vendor/ghostty-vt.wasm 30
node tools/parse-probes/scan.mjs 8
node tools/parse-probes/names.mjs src/lib/ghostty/vendor/ghostty-vt.wasm style
```

`scan.mjs` imports the scanner's `.ts` directly — Node 24 strips the types.

## Two traps

**Sampling alone tells you nothing here.** 95% of ticks land on a single symbol,
`terminal.stream.Stream.nextNonUtf8`, because LLVM inlines the entire CSI parser
into it. That is why the `diff*` scripts exist: vary one property per payload and
read the cost off the difference, rather than trying to decompose a profile that
cannot be decomposed.

**Unhandled sequences call back into JS.** `ESC[0;0G` — CHA with two parameters,
where CHA takes one — fires a parser warning through `env.log` 349,525 times per
2 MB, once per unit. That measures a wasm→JS boundary crossing, not parsing, and
it is invisible unless counted. `diff3.mjs` counts `env.log` per probe and flags
any row with a non-zero count as invalid. Any new probe of a sequence that might
not be handled needs the same guard.

Do not run these with DevTools attached to anything: an attached debugger drops
V8 to Liftoff and costs ~2.75x, which is its own long story.

## Building the comparison binary for `iter.mjs`

`iter.mjs` needs a `ghostty-vt.wasm` built from **ghostty main**, not from the
`ghostty-web` recipe in `src/lib/ghostty/vendor/README.md`. They are different
builds with different toolchains:

- our vendored binary: ghostty-web's fork, **Zig 0.15.2**, `zig build lib-vt`
- main: **Zig 0.16.0** (`minimum_zig_version` in `build.zig.zon`), and the flag
  is `-Demit-lib-vt`, not a `lib-vt` step

```sh
git clone --depth 1 --branch main https://github.com/ghostty-org/ghostty.git
cd ghostty
zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
# -> zig-out/bin/ghostty-vt.wasm   (201 exports at 6b22215c, 202 at 48d85eae,
#    187 when first measured, 84 in the vendored build — still moving, and it
#    can move down: 48d85eae -> 6b22215c removed mode_get/mode_set)
```

No patch is needed for this — the 133-line patch `ghostty-web` carries on top of
main only enables kitty graphics on `wasm32-freestanding`.

Note the tag **v1.3.1 will not work**: `libghostty-vt` at that tag ships only
`result`, `allocator`, `osc`, `sgr`, `key`, `paste` and `wasm` headers. There is
no terminal API and no render state in a released version — `render.h`,
`terminal.h` and `grid_ref.h` exist only on main.

### ABI traps

**The constructor has changed shape twice.** It is now
`ghostty_terminal_new(allocator, result, cols, rows)` — four arguments, no
options struct, and scrollback is a `terminal_set` option rather than a
constructor argument. Earlier it was `new(allocator, result, options*)`, where
`GhosttyTerminalOptions` is passed by value in C but arrives as a pointer. Dump
signatures from the binary rather than reading them off a header of unknown
vintage; the failure is a bare `GHOSTTY_INVALID_VALUE` (-2).

`get(state, ROW_ITERATOR, out)` wants the **slot** holding the handle, not the
handle — `render.zig` does `const it = out.* orelse ...` and populates what the
slot points at. Passing the handle returns `GHOSTTY_INVALID_VALUE` (-2).

**`GhosttyPoint` is not laid out the way the header reads.** `point.h` declares
`{ tag; value }` over a `{ uint16_t x; uint32_t y; }` coordinate, which on wasm32
reads as `tag@0, x@4, y@8`. It is actually **`tag@0, x@+8, y@+12`, 16 bytes** —
the union carries an 8-aligned member, so `value` starts at +8, and the struct
arrives by pointer rather than by value. Getting this wrong is silent: the
coordinates land in each other's fields and you read a real cell from the wrong
place. `y=1` returning column 1 of row 0 is the tell. Probe the offsets against
known content rather than deriving them (this is what `search.mjs check` guards).

**Per-row dirty is cleared by the consumer.** `render_state_update` sets it and
nothing resets it, so unless each row you read is cleared with
`row_set(iter, ROW_OPTION_DIRTY, false)`, every row reads dirty from the second
frame on and a dirty-rows-only measurement quietly becomes a full-frame one.
`render_state_set(state, DIRTY, false)` is a different flag and will not do it.

### What it found, at 48d85eae

Per frame, against the vendored build's single batched `get_viewport` — the
whole grid redrawn, colors and all:

| | 80x24 | 200x60 |
| --- | --- | --- |
| today: one batched read | 13.6us | 85.6us |
| 4 separate gets per cell | 3.2x | 4.2x |
| one `get_multi`, same 4 keys | 2.6x | 3.0x |
| **RAW alone**, unpacked in JS | **0.9x** | **1.3x** |
| `get_multi` {RAW, fg, bg} | 1.8x | 2.3x |
| RAW + colors only where styled | 1.9x | 2.5x (1.1x-1.4x on plain text) |

RAW is what makes the difference, and it is worth being precise about why: it
returns `page.Cell.C`, the whole cell bit-cast into one u64, so four calls per
cell become one and the unpacking happens in JS where it is nearly free. What
it cannot do is amortise the boundary crossing — `GhosttyCell` is a u64 *value*,
not a pointer to the row's cell array — so the model stays at one call per cell
and RAW alone does not carry resolved colors. Fetching those too is the 1.4x-2.5x
row, and that is the honest number for a drop-in replacement of today's read.

The other direction is the one that matters more:

| steady state: one row edited, redrawn | 80x24 | 200x60 |
| --- | --- | --- |
| iterator, clean rows skipped | 2.0us | 4.3us |
| today, full re-read | 14.6us | 87.1us |
| | **0.14x** | **0.05x** |

The batched read has no way to ask for less than the viewport, so a one-row edit
costs it a whole frame; the iterator reads 200 cells instead of 12,000. Note the
absolute numbers on both sides before treating any of this as decisive: the
worst full-redraw case is 0.21 ms against an 8.3 ms frame, so the 2.5x is 2.5x
of something that was never the bottleneck.

## The search path (`search.mjs`), at 48d85eae

`iter.mjs` measures the *render* path. Search is a different shape and, on main,
a different API: `SearchController` walks the whole scrollback via
`readRows(0, total - 1)`, which today is one `get_scrollback_line` per **row**.
Main has no such call — scrollback is addressed through `grid_ref`.

One full search pass, both engines reading the identical 1,977 / 9,941 rows:

| | 80x24, 2k rows | 200x60, 10k rows |
| --- | --- | --- |
| today: one packed row per call | 1.09 ms | 13.6 ms |
| **`grid_ref`, one resolve per row** | **0.9x** | **0.8x** |
| the same via `ghostty_cell_get` | 1.7x | 1.7x |
| `grid_ref` re-resolved per **cell** | 6.3x | 9.1x |

So the search path is **not** the regression it looked like it would be — it is
slightly faster, and holds at depth: 0.65x at 40k rows, 0.86x at 100k.

Three things decide that, and all three are easy to get wrong:

- **Resolve once per row, then walk by mutating `ref.x`.** `GhosttyGridRef` is a
  plain `{size, node, x, y}` struct in caller memory, so stepping a row costs no
  further resolves. The direct transliteration of `readRows` — resolve per cell —
  is the 6.3x-9.1x row, and it is what you get by writing the obvious thing.
- **`GhosttyCell` is a `uint64_t`**, the same packed cell as `ROW_CELLS_DATA_RAW`,
  so `ghostty_grid_ref_cell` already hands back everything and JS can unpack it:
  `codepoint = (lo >>> 2) & 0x1FFFFF`. Going through `ghostty_cell_get` per field
  instead costs 1.7x, and it is the accessor upstream documents.
- **`grid_ref` resolution really is O(depth)**, as `terminal.h` warns: 14 ns at
  row 0 rising linearly to 188 ns at row 39,540 (`gridrefdepth.mjs`). One resolve
  per row amortises that over `cols` cells, which is why the pass stays linear
  enough to win. One resolve per *cell* does not.

### The trap that inverted this result

The first version of this probe reported `grid_ref` at **5.2x slower**. The
baseline was measuring an empty loop: `get_scrollback_line` reads through
`RenderState.row_data` (patch #177), so without a `ghostty_render_state_update`
first, every scrollback row reads back **blank** — no error, no zero return, just
spaces. `search.mjs check` compares both engines' text row by row and is the only
reason this was caught. Run it whenever the harness changes.
