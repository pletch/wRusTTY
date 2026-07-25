# Vendored ghostty-vt.wasm

This binary is **not** the one `ghostty-web` publishes. It's a local build of
`ghostty-web`'s `main` branch (commit `1858a59`, matching the
`ghostty-web@0.4.0-next.20.g1858a59` version pinned in `package.json`) with
three upstream PRs merged on top, none of which had shipped in any release at
build time:

- [#142](https://github.com/coder/ghostty-web/pull/142) — zero-initialize WASM
  page buffers (stale cell data / memory corruption after freeing a terminal)
- [#176](https://github.com/coder/ghostty-web/pull/176) — ignore ESC k
  (screen/tmux) title payloads instead of rendering them
- [#177](https://github.com/coder/ghostty-web/pull/177) — stabilize WASM
  viewport row reads across Ghostty page boundaries

All three patch `patches/ghostty-wasm-api.patch`, which is applied to the
`ghostty` core (Zig) before compiling to WASM — there's no way to pull them in
via a package version bump. The WASM export surface is unchanged from stock
`0.4.0-next.20.g1858a59` (79 exports, same names on both sides).

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

An older revision of the WASM API did take a byte budget, so comments and
snippets predating this build may say otherwise. The binary here is not at
fault and needs no patch for it.

## Rebuilding

Requires Zig 0.15.2 and a Linux (or WSL) build environment — building this
natively on Windows hits a Zig `ftruncate`/`FileTooBig` bug in the unicode
table generator step.

```sh
git clone https://github.com/coder/ghostty-web.git
cd ghostty-web
git fetch origin pull/176/head:pr-176
git fetch origin pull/177/head:pr-177
git fetch origin pull/142/head:pr-142
git checkout -b custom-build main
git merge pr-176   # clean fast-forward
git merge pr-177   # conflicts in lib/terminal.test.ts (test-only, both sides' helpers coexist)
git merge pr-142   # clean
git submodule update --init --recursive
cd ghostty
git apply ../patches/ghostty-wasm-api.patch
zig build lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
cp zig-out/bin/ghostty-vt.wasm ../../ghostty-vt.wasm   # -> this directory
```

### Why `ReleaseFast` and not `ReleaseSmall`

`ReleaseSmall` was the original build mode and it costs ~12% of parse
throughput: measured on the benchmark's own flood payload, 74.1 MB/s against
83.4 MB/s for `ReleaseFast` (90.4 vs 97.0 MB/s on long printable runs). Size
is the wrong thing to optimise for here — this is a Tauri desktop app, so the
binary is bundled on disk rather than fetched over a network.

It is not free, though. The module is 3007 kB rather than 415 kB, and every
pane is its own WASM instance, so per-pane `compile+instantiate` goes from
~0.7 ms to ~1.5-3 ms. That cost disappears almost entirely if the compiled
`WebAssembly.Module` is cached and shared across panes, leaving only a
per-pane `WebAssembly.Instance` — measured at 0.087 ms to instantiate, and
identical for both builds. `GhosttyEngine.initWasm` currently compiles per
pane, so the win is still on the table.

Do not reach for `-Dcpu=generic+simd128`: it was measured at +0.5-2%, which is
noise. Ghostty's real SIMD paths are C++ (Google Highway, simdutf, utfcpp) and
its own build config disables them for wasm outright —
`if (target.result.cpu.arch.isWasm()) break :simd false;` in
`src/build/Config.zig`. Forcing `-Dsimd=true` fails to compile those
dependencies for `wasm32-freestanding`. Native SIMD throughput is not
reachable from a `.wasm` at all; it needs native `libghostty` in the backend.

## Reverting to stock

Delete this directory, change the import in `GhosttyEngine.ts` back to
`import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url'`, and once any of
#142/#176/#177 lands in a release, bump `package.json` and do exactly that.
