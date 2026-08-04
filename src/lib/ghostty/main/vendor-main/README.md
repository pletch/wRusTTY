# Comparison build: ghostty `main` at the pin

**Not tracked.** This is the reference binary the port was developed against —
`abi.parity.test.ts` and the other parity suites pick it up from here
automatically, so they run without setting `GHOSTTY_MAIN_WASM`.

It is now the *same build* that ships: `../../vendor/ghostty-vt.wasm` is this
file with its DWARF stripped (`tools/strip-wasm-debug.mjs`), which changes no
behaviour. It is kept unstripped and separate because the parity suites are
allowed to skip when it is absent — that is how they stay green on CI, which
holds no comparison build — while the shipped binary never may.

```
ghostty-org/ghostty @ 48d85eaeb06ac9fc49073815bda5bac97de655ca
       + patches/ghostty-main-esc-k.patch   (#176; 24 lines, 2 files)
SHA-256  dc089738809e60da7dc804cf7437344da9afabab0218582db9eeeb9ee1edf4e9
Size     5,259,398 bytes
Built    Zig 0.16.0, -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
Exports  202 (200 functions) — the patch adds none
```

**This build is patched.** The unpatched one hashed
`7b45ec3079dafd702bfc8d122de94769d5622e70ec3004b84640dd509f271ea0` at 5,258,953
bytes; the 445-byte difference is the added parser state. `abi.parity.test.ts`
asserts `ESC k` payloads are *swallowed*, which only holds with the patch — so
the suite fails loudly if a rebuild skips it.

The `.wasm` and the three headers are **git-ignored**: 5 MB of comparison
artifact does not belong in the tree, and unlike `../../vendor/ghostty-vt.wasm`
this one is never loaded by the app, so no integrity test guards it. The hash
above is recorded so a stale copy can be recognised, not enforced.

`render.h`, `terminal.h` and `screen.h` are kept beside it because the enum
values in `../abi.ts` are transcribed from them and there is no other way to
re-check a key short of rebuilding. Note they are **not** sufficient on their
own — the struct layouts that actually matter (`GhosttyPoint` especially) are
not what these headers read as. See `docs/PORT_GHOSTTY_MAIN.md`.

## Replacing it

Rebuilding needs **Zig 0.16.0 on Linux or WSL** (native Windows hits a Zig
`ftruncate`/`FileTooBig` bug in the unicode table generator):

```sh
# A shallow fetch of just the pin is enough — 136 MB rather than the full history.
mkdir ghostty-pin && cd ghostty-pin && git init -q .
git config core.autocrlf false          # or the patch will not apply
git remote add origin https://github.com/ghostty-org/ghostty.git
git fetch -q --depth 1 origin 48d85eaeb06ac9fc49073815bda5bac97de655ca
git checkout -q FETCH_HEAD

git apply ../patches/ghostty-main-esc-k.patch
zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
cp zig-out/bin/ghostty-vt.wasm <here>/ghostty-vt.wasm
cp include/ghostty/vt/{render,terminal,screen}.h <here>/
```

Build **inside WSL, under `~`** — not `/mnt/c`. The 9p filesystem is slow and is
where Zig's `ftruncate`/`FileTooBig` problem in the unicode table generator
tends to appear. The first build fetches ghostty's dependencies into the global
Zig cache; after that it is quick.

If you rebuild at a **different commit**, re-run the probes before trusting any
number in `docs/PORT_GHOSTTY_MAIN.md` or `tools/parse-probes/README.md`: the
export surface moved from 187 to 202 in the weeks before this pin.

```sh
npx vitest run abi.parity
node tools/parse-probes/search.mjs <here>/ghostty-vt.wasm  # includes `check`
node tools/parse-probes/iter.mjs   <here>/ghostty-vt.wasm
```
