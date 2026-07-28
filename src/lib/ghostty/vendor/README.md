# Vendored ghostty-vt.wasm

Built from the **Ghostty v1.3.1 release tag** plus our own
`patches/ghostty-131-wasm-api.patch`. It is not `ghostty-web`'s binary and no
longer tracks that project — see `patches/README.md` for why, for the build
recipe, and for the rebase notes that matter next time this is upgraded.

## The expected artifact

```text
SHA-256  be419bfc5b6de37eb1768585aa4225039b9dacde56d429db1f53904af7775b0b
Size     742,403 bytes
Source   ghostty-org/ghostty @ v1.3.1 + patches/ghostty-131-wasm-api.patch
Built    Zig 0.15.2, -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
Then     node tools/strip-wasm-debug.mjs (see below) — this is the POST-strip hash
```

This binary parses untrusted bytes off the wire from every remote host you
connect to, which makes it the highest-value thing in the tree to swap. It also
arrives as an opaque 742 kB blob that no review of a diff can meaningfully read.
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

`package.json` still depends on `ghostty-web` for **TypeScript types only**; we
import none of its JavaScript, and never did. The engine talks to this binary
directly through the 79 exports listed in `wasmBindings.ts`, which are unchanged
from the previous ghostty-web-based build — the move to 1.3.1 needed no change to
`GhosttyEngine.ts` or `wasmBindings.ts`.

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
after a flood. Retention tracks `value / (cols * 12.65)` wherever the budget
exceeds one page.

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

As built, the module is 3,299 kB, of which **2,556 kB (77.5%) is `.debug_*`**
against 538 kB of actual code. `tools/strip-wasm-debug.mjs` removes the DWARF
sections and keeps everything else, taking it to **742 kB**:

```sh
node tools/strip-wasm-debug.mjs ghostty-vt.wasm ghostty-vt.stripped.wasm
```

The checked-in binary is the stripped one; run this as part of the vendoring
step whenever the binary is rebuilt.

Nothing is lost by it. V8 attributes profiler ticks to real Zig symbols from the
**name section**, which is kept — `tools/parse-probes/names.mjs` reads that
section and no other, and still resolves all 444 functions after the strip.
`ReleaseFast` code is untouched, so parse throughput is unaffected and the
argument above for not using `ReleaseSmall` still stands. What DWARF actually
buys is source-level stepping in DevTools via the C/C++ debugging extension —
a dev-machine concern, and not one worth 2.5 MB in every installer. If it is
ever wanted, vendor both binaries and select on
`import.meta.env.VITE_WRUSTTY_INSTRUMENTS`, the same dual-artifact pattern the
JS instrumentation already uses.

Do not reach for `-Dcpu=generic+simd128`: it was measured at +0.5-2%, which is
noise. Ghostty's real SIMD paths are C++ (Google Highway, simdutf, utfcpp) and
its own build config disables them for wasm outright —
`if (target.result.cpu.arch.isWasm()) break :simd false;` in
`src/build/Config.zig`. Forcing `-Dsimd=true` fails to compile those
dependencies for `wasm32-freestanding`. Native SIMD throughput is not
reachable from a `.wasm` at all; it needs native `libghostty` in the backend.
