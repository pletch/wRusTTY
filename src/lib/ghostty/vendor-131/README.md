# The v1.3.1 build, kept as the port's oracle

**Not shipped.** Nothing in the app loads this. It is the binary that *was*
`../vendor/ghostty-vt.wasm` until the port to ghostty `main`, and it is kept
because it is the only other implementation of our ABI in existence.

```text
SHA-256  be419bfc5b6de37eb1768585aa4225039b9dacde56d429db1f53904af7775b0b
Size     742,403 bytes
Source   ghostty-org/ghostty @ v1.3.1 + patches/ghostty-131-wasm-api.patch
Built    Zig 0.15.2, -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast, then stripped
```

## Why keep it

The port's evidence is comparative, and it stops being evidence the moment both
sides of the comparison are the same binary. These suites read this file:

- `main/shim.test.ts` — every call our ABI offers, answered by both builds from
  the same input and compared.
- `main/ViewportReader.test.ts`, `main/ScrollbackReader.test.ts` — the packed
  cell buffer, byte for byte.
- `main/effects.test.ts` — query replies, against what the old queue answered.

Deleting it would leave those tests comparing `main` with `main`, which is worth
nothing and would still pass. Every trap the port hit — `GhosttyPoint`'s
offsets, the palette stride, the wrap flag's direction, the cursor style
renumbering — produced *plausible* output, and only a second implementation
distinguished plausible from correct.

It is 742 kB of repository and no bytes of the app bundle: Vite only bundles
assets that are imported, and nothing imports this.

## When it can go

When the port stops being something anyone might have to check — or when the
last of those suites is retired deliberately rather than by accident. If it is
removed, remove the suites that read it in the same commit, so nothing is left
looking like a check that isn't one.

`patches/ghostty-131-wasm-api.patch` and `patches/README.md` describe how it was
built, and remain accurate for it.
