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
ghostty-org/ghostty @ 492300cad104195411d12217dd22f1cd05f31376
       + patches/ghostty-main-esc-k.patch   (#176; 24 lines, 2 files)
SHA-256  ee0a8bbb325d3c8acc8614285b80a2f81a55e0ea04c6a4deb640c4d3fcd66073
Size     4,654,427 bytes
Built    Zig 0.16.0, -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
Exports  189 (187 functions) — the patch adds none
```

**This build is patched.** The unpatched build was not re-measured at this pin;
at the previous one (`4540d499`) it hashed
`b1d2b8361e796df34333fddb0d5cebe946649fe1ed05a02e2b10e4a7761e3dd3` at 4,541,679
bytes, 571 bytes less than the patched build — that difference is the added
parser state. `abi.parity.test.ts`
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
git fetch -q --depth 1 origin 492300cad104195411d12217dd22f1cd05f31376
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
export surface moved from 187 to 202 in the weeks before the previous pin, and
the two pins since have both taken it *down*: 201 by removing
`ghostty_terminal_mode_get`/`_mode_set` (upstream `cfc19e805`), then **180** by
retiring the type-specific wasm allocators for one generic `ghostty_wasm_alloc`
(`a8e9b413f`) and `render_state_colors_get` for a key (`16c833c5f`). Both were
flagged ABI BREAKING upstream. Export count going *down* is consolidation, not
evidence of a bad build.

```sh
npx vitest run abi.parity
npx vitest run                                    # the actual gate
node tools/parse-probes/search.mjs <here>/ghostty-vt.wasm  # includes `check`
node tools/parse-probes/iter.mjs   <here>/ghostty-vt.wasm
```

Both probes need the **v1.3.1** binary as their comparison arm. That is now the
default (`vendor-131/`), but if you pass a second argument make sure it is not
`vendor/ghostty-vt.wasm` — that path holds a *main* build since the port, and
feeding it back in fails with `ghostty_terminal_new_with_config is not a
function`, which looks like a bad binary and is not one.
