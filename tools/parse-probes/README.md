# Parse probes

Headless harnesses for measuring the Ghostty parse path and the JS OSC scan,
outside the app and outside a browser. Plain `.mjs`, no build step — they are
dev tools, not app code, which is why they live here rather than under `src/`.

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
| `iter.mjs` | the same, driven through ghostty **main**'s row/cell iterator API |
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
# -> zig-out/bin/ghostty-vt.wasm   (187 exports, vs 79 in the vendored build)
```

No patch is needed for this — the 133-line patch `ghostty-web` carries on top of
main only enables kitty graphics on `wasm32-freestanding`.

Note the tag **v1.3.1 will not work**: `libghostty-vt` at that tag ships only
`result`, `allocator`, `osc`, `sgr`, `key`, `paste` and `wasm` headers. There is
no terminal API and no render state in a released version — `render.h`,
`terminal.h` and `grid_ref.h` exist only on main.

### Two ABI traps

`GhosttyTerminalOptions` is passed by value in C but arrives as a **pointer**
(`ghostty_terminal_new(i32, i32, i32)`); dump signatures from the binary rather
than reading them off the header.

`get(state, ROW_ITERATOR, out)` wants the **slot** holding the handle, not the
handle — `render.zig` does `const it = out.* orelse ...` and populates what the
slot points at. Passing the handle returns `GHOSTTY_INVALID_VALUE` (-2).
