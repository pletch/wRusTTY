# Parse probes

Headless harnesses for measuring the Ghostty parse path and the JS OSC scan,
outside the app and outside a browser. Plain `.mjs`, no build step — they are
dev tools, not app code, which is why they live here rather than under `src/`.

Two things make this possible and are worth not breaking:

- The vendored `ghostty-vt.wasm` has a **name section and full DWARF**, so V8
  attributes ticks to real Zig symbols. (It is also why the binary is 3007 kB:
  code is only 485 kB, the rest is debug info. The stock npm build has it
  stripped.)
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
