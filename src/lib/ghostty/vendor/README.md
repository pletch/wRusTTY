# Vendored ghostty-vt.wasm

Built from the **Ghostty v1.3.1 release tag** plus our own
`patches/ghostty-131-wasm-api.patch`. It is not `ghostty-web`'s binary and no
longer tracks that project — see `patches/README.md` for why, for the build
recipe, and for the rebase notes that matter next time this is upgraded.

`package.json` still depends on `ghostty-web` for **TypeScript types only**; we
import none of its JavaScript, and never did. The engine talks to this binary
directly through the 79 exports listed in `wasmBindings.ts`, which are unchanged
from the previous ghostty-web-based build — the move to 1.3.1 needed no change to
`GhosttyEngine.ts` or `wasmBindings.ts`.

## `scrollbackLimit` is a line count

Worth knowing before touching it, because getting it wrong is silent and the
symptom is a hung pane rather than an error.

`GhosttyTerminalConfig.scrollback_limit` is a **line count**. The core converts
it to bytes with `std.math.mul(usize, lines, bytes_per_line)`, and `usize` is
32-bit on `wasm32` — so an out-of-range value does not error, it lands on
`catch std.math.maxInt(usize)`, which the core reads as *unlimited*. Passing a
byte-shaped value (this side did, for a while) therefore turns the scrollback
cap off: a 100 MB flood retained ~1.15 M rows and grew the heap to ~2 GB before
an allocation failed. Go through `scrollbackLinesFor` in `GhosttyEngine.ts`,
which clamps to a range that cannot overflow; `scrollbackLimit.test.ts` pins it.

Note `ghostty-web`'s own docs assert the opposite — that the field is in bytes
(their PR #151). For the code we build, it is lines, and the measurement above is
what settles it. Do not adopt their framing without re-measuring.

## Why `ReleaseFast` and not `ReleaseSmall`

`ReleaseSmall` was the original build mode and it costs ~12% of parse
throughput: measured on the benchmark's own flood payload, 74.1 MB/s against
83.4 MB/s for `ReleaseFast` (90.4 vs 97.0 MB/s on long printable runs). Size
is the wrong thing to optimise for here — this is a Tauri desktop app, so the
binary is bundled on disk rather than fetched over a network.

It is not free, though. The module is ~3.3 MB rather than 415 kB, and every
pane is its own WASM instance, so per-pane `compile+instantiate` goes from
~0.7 ms to ~1.5-3 ms. That cost disappears almost entirely if the compiled
`WebAssembly.Module` is cached and shared across panes, leaving only a
per-pane `WebAssembly.Instance` — measured at 0.087 ms to instantiate, and
identical for both builds. `GhosttyEngine.initWasm` currently compiles per
pane, so the win is still on the table.

Most of that size is debug info, not code: the binary carries a name section and
full DWARF (~2.3 MB of `.debug_*`), against ~830 kB of actual code. That is what
makes `tools/parse-probes/` able to profile the shipping binary with real Zig
symbol names, so it is deliberate — but stripping it is the first thing to try if
the bundle size ever matters.

Do not reach for `-Dcpu=generic+simd128`: it was measured at +0.5-2%, which is
noise. Ghostty's real SIMD paths are C++ (Google Highway, simdutf, utfcpp) and
its own build config disables them for wasm outright —
`if (target.result.cpu.arch.isWasm()) break :simd false;` in
`src/build/Config.zig`. Forcing `-Dsimd=true` fails to compile those
dependencies for `wasm32-freestanding`. Native SIMD throughput is not
reachable from a `.wasm` at all; it needs native `libghostty` in the backend.
