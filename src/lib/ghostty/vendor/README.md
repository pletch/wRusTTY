# Vendored ghostty-vt.wasm

Built from **ghostty `main` at the port's pin** plus the one fix we still carry,
`patches/ghostty-main-esc-k.patch`. It speaks `main`'s render/terminal C API,
not the API `wasmBindings.ts` declares — `main/shim.ts` presents ours over it,
and `instantiateGhosttyModule` selects that automatically by looking at the
binary's own exports. See `docs/PORT_GHOSTTY_MAIN.md` for the port, and
`../vendor-131/README.md` for the build this replaced, which is kept as the
comparison oracle.

## The expected artifact

```text
SHA-256  595cb0de1a8bc6e3c6e6ac29df61b1ec07c46e76e6d6b281717f26bc9ed291a0
Size     1,146,828 bytes
Source   ghostty-org/ghostty @ f523504ea5c9f41d150d1eb93cc7a748b90f9361
         + patches/ghostty-main-esc-k.patch   (#176; 24 lines, 2 files)
Built    Zig 0.16.0, -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
Then     node tools/strip-wasm-debug.mjs (see below) — this is the POST-strip hash
```

This binary parses untrusted bytes off the wire from every remote host you
connect to, which makes it the highest-value thing in the tree to swap. It also
arrives as an opaque 1.3 MB blob that no review of a diff can meaningfully read.
Recording what the bytes are supposed to be is the only check available.

`vendorIntegrity.test.ts` asserts this hash on every `npm test` and CI run, so a
binary that changes without this file changing fails the suite.

Check it by hand with:

```sh
sha256sum src/lib/ghostty/vendor/ghostty-vt.wasm
```

**When you legitimately rebuild the binary, this hash changes and the test is
supposed to fail.** Rebuild, re-strip, run `sha256sum`, and update both the
block above and the constant in the test — in the same commit as the new
binary, so the two can never drift apart. Note that a Zig rebuild is not
reproducible byte-for-byte across toolchain versions, so a hash that differs
after a rebuild is expected and is not by itself evidence of anything wrong;
what the check catches is the binary moving when nobody rebuilt it.

## Rebuilding

Needs **Zig 0.16.0 on Linux or WSL** — 0.16 is `main`'s `minimum_zig_version`,
and building natively on Windows hits a Zig `ftruncate`/`FileTooBig` bug in the
unicode table generator. Build under `~`, not `/mnt/c`.

```sh
mkdir ghostty-pin && cd ghostty-pin && git init -q .
git config core.autocrlf false          # or the patch will not apply
git remote add origin https://github.com/ghostty-org/ghostty.git
git fetch -q --depth 1 origin f523504ea5c9f41d150d1eb93cc7a748b90f9361
git checkout -q FETCH_HEAD
git apply ../patches/ghostty-main-esc-k.patch
zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
node tools/strip-wasm-debug.mjs zig-out/bin/ghostty-vt.wasm <here>/ghostty-vt.wasm
```

Then re-measure what the core's own costs decide, because they are properties of
*this binary* and they moved with the last rebuild:
`SCROLLBACK_BYTES_PER_CELL` and the tier table in `GhosttyEngine.ts` (see below),
and the probes named in `docs/PORT_GHOSTTY_MAIN.md` if the commit changed.

`package.json` still depends on `ghostty-web` for **TypeScript types only**; we
import none of its JavaScript, and never did. The engine talks to this binary
through the `GhosttyExports` surface in `wasmBindings.ts`, unchanged across the
port — that is what the shim is for.

## `scrollbackLimit` is a byte budget

Worth knowing before touching it, because getting it wrong is silent in both
directions and neither symptom names the setting.

`GhosttyTerminalConfig.scrollback_limit` is a **byte budget**, despite reading
like xterm's row-count `scrollback`. `newWithConfig` passes it to
`Terminal.init` as `max_scrollback`, which reaches upstream `PageList` as
`max_size`. Two facts follow, and both have shipped as bugs:

- **A row-shaped value silently does nothing.** Any plausible row count
  (1,000-30,000) is far below the core's ~530 KB minimum page, so the pane falls
  back to a two-page floor: measured against this binary, 1000 and 100000 alike
  retained ~1100 rows at 80 columns and ~250 at 200, with the heap pinned at its
  initial 6.6 MB. The scrollback setting appeared to be ignored, which is what it
  was. This is why the *setting* is now memory rather than rows — depth is
  derived from the budget and the pane's width, for display only.
- **Zero means unlimited**, not "none" — `newWithConfig` maps it to
  `maxInt(usize)`. Any path that can reach `setUint32` with a fraction, a
  non-finite value or something ≥ 2^32 therefore removes the cap.

Go through `scrollbackBudgetBytesFor` in `GhosttyEngine.ts`, which maps the
user-facing memory tier to a measured budget and guarantees a positive integer
inside u32. `scrollbackLimit.test.ts` pins it, and drives the real core to do
so — a unit test of the arithmetic cannot tell a byte budget from a row count,
which is exactly how this was got wrong.

The tier budgets are measured, not derived, and the reason matters before
touching them: **WASM memory grows in doubling steps, so the heap is a
staircase against the budget rather than a line.** Every budget from 13 MB to
28 MB lands on the same ~30.7 MB heap, and one more megabyte doubles it. Each
tier therefore takes the largest budget that stays inside its step — 4 / 10 /
24 / 48 MB, labelled 8 / 16 / 32 / 64 MB of *total pane footprint*. Rounding a
budget down gives away depth for nothing; nudging one up can double what every
pane costs. The test floods the real core and asserts the heap stays under the
label.

To re-measure: sweep the raw field and count `ghostty_terminal_get_scrollback_length`
after a flood. Retention tracks `value / (cols * 9.2)` wherever the budget
exceeds a few pages. That constant belongs to the binary — the v1.3.1 build
delivered 12.65 bytes per cell, this one delivers ~9.2, so the same budget buys
~37% more depth and every tier was re-picked around the new heap staircase.

An earlier revision of this file asserted the opposite and dismissed
`ghostty-web`'s own "it's bytes" docs (their PR #151) as not applying to the code
we build. They were right; the measurement above is what settles it.

## Why `ReleaseFast` and not `ReleaseSmall`

`ReleaseSmall` was the original build mode and it costs ~12% of parse
throughput: measured on the benchmark's own flood payload, 74.1 MB/s against
83.4 MB/s for `ReleaseFast` (90.4 vs 97.0 MB/s on long printable runs). Size
is the wrong thing to optimise for here — this is a Tauri desktop app, so the
binary is bundled on disk rather than fetched over a network.

It is not free, though. Every pane is its own WASM instance, so per-pane
`compile+instantiate` goes from ~0.7 ms to ~1.5-3 ms. That cost disappears
almost entirely once the compiled `WebAssembly.Module` is cached and shared
across panes, leaving only a per-pane `WebAssembly.Instance` — measured at
0.087 ms to instantiate, and identical for both builds. `compileGhosttyWasm`
does exactly that: it memoises the compile in a module-level promise and evicts
it on failure, so a pane that fails to start doesn't poison every later one.
`moduleCache.test.ts` pins both halves — one shared module, never a shared
instance.

## The binary is stripped of DWARF, but keeps its name section

As built, the module is 4,545 kB, of which **3,444 kB (75.8%) is `.debug_*`**.
`tools/strip-wasm-debug.mjs` removes the DWARF sections and keeps everything
else, taking it to **1,101 kB** — down 22% from the 1,319 kB of the pin before
the port,
which is upstream's own size work (`492c26067`'s wasm memory pool, `51a4311ef`'s
inlining cleanup) rather than anything we changed. Note this does **not** yet use
`-Dvt-features` (upstream `1fdbb8c91`), which compiles out unused feature areas
and could take it materially lower again; adopting it means deciding which
features we actually need, so it is deliberately a separate change. (The v1.3.1 build stripped to 742 kB; `main`'s
VT library is simply larger, and that ~566 kB is the whole size cost of the
port.)

```sh
node tools/strip-wasm-debug.mjs ghostty-vt.wasm ghostty-vt.stripped.wasm
```

The checked-in binary is the stripped one; run this as part of the vendoring
step whenever the binary is rebuilt.

Nothing is lost by it. V8 attributes profiler ticks to real Zig symbols from the
**name section**, which is kept — `tools/parse-probes/names.mjs` reads that
section and no other, and still resolves all 914 functions after the strip.
`ReleaseFast` code is untouched, so parse throughput is unaffected and the
argument above for not using `ReleaseSmall` still stands. What DWARF actually
buys is source-level stepping in DevTools via the C/C++ debugging extension —
a dev-machine concern, and not one worth 2.5 MB in every installer. If it is
ever wanted, vendor both binaries and select on
`import.meta.env.VITE_WRUSTTY_INSTRUMENTS`, the same dual-artifact pattern the
JS instrumentation already uses.

## SIMD: upstream now enables `simd128` by default, and it is no longer noise

This section used to say "do not reach for `-Dcpu=generic+simd128`: it was
measured at +0.5-2%, which is noise." **That is no longer true**, and the
reasoning behind it was overtaken by upstream `87f69a12e` (in this pin):

- **wasm targets now default to the `simd128` CPU feature.** The build command
  above is unchanged, but it now produces a simd128 binary. Opt out with
  `-Dcpu=generic`. The module validates in Node 24 and every browser engine has
  supported simd128 for years, so the WebView2 runtime Tauri uses is fine.
- **The old measurement was of the wrong thing.** It was true that ghostty's C++
  SIMD paths (Google Highway, simdutf, utfcpp) are disabled for wasm — that part
  still holds. But upstream has since added a *Zig* vectorized ASCII bulk path in
  `utf8DecodeUntilControlSeq` that is written against wasm `simd128`, and made
  the batched parse path (bulk UTF-8 decode, `print_slice` runs) unconditional
  rather than gated on `build_options.simd`. Enabling the CPU feature now
  actually reaches vectorized code, where before it reached none.

Upstream measures `ghostty_terminal_vt_write` at 1.4x to 13x faster on wasm
depending on input. Measured here, previous pin against this one, same payloads
through `vt_write` at 200x60 in Node 24 — best of five, each binary in its own
process, both verified to leave the same 417 rows of scrollback so neither is
skipping work:

| payload | `48d85eae` | `6b22215c` | |
|---|---|---|---|
| ASCII text | 75.5 MB/s | 780.7 MB/s | **10.3x** |
| SGR-heavy | 69.3 MB/s | 172.1 MB/s | **2.5x** |
| mixed plain/SGR | 67.6 MB/s | 331.1 MB/s | **4.9x** |
| grapheme-heavy (ZWJ, flags, modifiers) | 30.0 MB/s | 118.3 MB/s | **3.9x** |

So the throughput figures in the `ReleaseFast` section above — 74.1 vs 83.4 MB/s
— are from the v1.3.1 build and are now off by an order of magnitude on ASCII.
They are left as written because the `ReleaseFast`-vs-`ReleaseSmall` *ratio* is
what that section argues, and that comparison has not been redone.

Render-state reads moved far less, because most of that work was already on our
side of the call boundary (200x60, µs/frame): `iterate` 44.3 -> 38.5, per-cell
`raw` 112.9 -> 100.7, `multi4` 272.0 -> 168.2, `rawStyled` 222.2 -> 191.7. The
real gain there is the new bulk row read, which has no equivalent on the old pin
at all: **10.3µs**, against 112.9µs for the per-cell `raw` it replaces.

### In the app

The above is headless. `/#bench` was then run on both pins on one machine in one
session — RTX 3070 via ANGLE, 120 Hz, **no DevTools attached** (see the note in
`.claude/skills/run-wrustty/SKILL.md`: an attached debugger drops V8 to Liftoff
and costs ~2.75x, which is enough to invent or erase every number here).

| workload | `48d85eae` | `6b22215c` | |
|---|---|---|---|
| Parse: printable | 70.5 MB/s | 420.4 MB/s | **6.0x** |
| Large cat (flood) | 76.0 MB/s | 171.8 MB/s | **2.3x** |
| Parse: short SGR | 144.3 MB/s | 178.8 MB/s | 1.2x |
| Parse: long SGR | 126.7 MB/s | 153.2 MB/s | 1.2x |

The harness's own write-phase totals, over the same 63.72 MB in 1264 writes:
**720 ms -> 364 ms** inside `write` (88.5 -> 175.1 MB/s), of which `coreWrite`
is **664 ms -> 304 ms**. The parse is where all of it lands; `copy`, `alloc`,
`free` and `scan` are unchanged and were never the cost.

**The xterm.js arm is the control and it did not move** — flood 48.5 vs 48.6
MB/s, printable 42.9 vs 45.1 MB/s across the two runs. That is what makes the
comparison worth anything: the machine held still and the engine moved.

**Interactive, streaming and TUI redraw did not change** — 16.4 vs 16.5 ms,
≈2 frames on both pins. Those workloads are bound by frame presentation, not by
the parser, so a faster parser has nothing to give them. Ghostty still beats
xterm.js there (≈2 frames against ≈3), but that gap predates this pin and is not
evidence for it. **Do not quote this pin as a latency improvement**; it is a
throughput one, and floods and bulk output are where it shows.

xterm.js still edges `Parse: long SGR` — 153.0 MB/s against 126.7 old and 153.2
new. This pin closes that to a tie rather than taking the lead.

Reproducing it needs the previous pin's **TypeScript** as well as its binary:
the mode migration means the current shim cannot drive the old `.wasm` at all.
`git checkout <pin-commit>^ -- src/lib/ghostty/main/{shim,ViewportReader,abi}.ts
src/lib/ghostty/vendor/ghostty-vt.wasm` is enough, and the harness refuses to
report numbers when the core fails to load rather than publishing a zero — which
is what it does if you swap only the binary.

Native SIMD throughput is still not reachable from a `.wasm`; that needs native
`libghostty` in the backend.
