# Comparison build: ghostty `main` at the pin

**Not shipped, not tracked.** This is the reference binary the port is developed
and verified against — `abi.parity.test.ts` picks it up from here automatically,
so the suite runs without setting `GHOSTTY_MAIN_WASM`.

```
ghostty-org/ghostty @ 48d85eaeb06ac9fc49073815bda5bac97de655ca
SHA-256  7b45ec3079dafd702bfc8d122de94769d5622e70ec3004b84640dd509f271ea0
Size     5,258,953 bytes
Built    Zig 0.16.0, -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
Exports  202 (200 functions)
```

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
git clone https://github.com/ghostty-org/ghostty.git
cd ghostty && git checkout 48d85eaeb06ac9fc49073815bda5bac97de655ca
zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
cp zig-out/bin/ghostty-vt.wasm <here>/ghostty-vt.wasm
cp include/ghostty/vt/{render,terminal,screen}.h <here>/
```

If you rebuild at a **different commit**, re-run the probes before trusting any
number in `docs/PORT_GHOSTTY_MAIN.md` or `tools/parse-probes/README.md`: the
export surface moved from 187 to 202 in the weeks before this pin.

```sh
npx vitest run abi.parity
node tools/parse-probes/search.mjs <here>/ghostty-vt.wasm  # includes `check`
node tools/parse-probes/iter.mjs   <here>/ghostty-vt.wasm
```
