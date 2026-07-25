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
zig build lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall
cp zig-out/bin/ghostty-vt.wasm ../../ghostty-vt.wasm   # -> this directory
```

## Reverting to stock

Delete this directory, change the import in `GhosttyEngine.ts` back to
`import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url'`, and once any of
#142/#176/#177 lands in a release, bump `package.json` and do exactly that.
