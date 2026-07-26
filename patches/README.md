# ghostty-131-wasm-api.patch — **does not work, kept as a record**

An attempt to move off `ghostty-web`'s fork by rebasing its WASM terminal API
patch from Ghostty 1.2 onto the **v1.3.1 release tag**, so we could own the shim
ourselves rather than depend on a project whose PR backlog has been unreviewed
since roughly March.

**It compiles and it is ABI-identical, but it is not correct. Do not ship it.**
The vendored binary in `src/lib/ghostty/vendor/` is still the 1.2-based build.

## What worked

- v1.3.1 builds `lib-vt` for `wasm32-freestanding` with **Zig 0.15.2** — the
  toolchain we already use. (Ghostty `main` needs 0.16.0; the 1.3.1 tag does
  not.) The build step is `zig build lib-vt`, same as today.
- The 1.2-era patch applies to v1.3.1 with only **two rejects**: `.gitignore`
  and one `Screen.zig` hunk, the latter purely on context drift.
- After the fixes below it compiles clean and exports **79 functions, byte
  for byte the same set as the current vendored build** — so `GhosttyEngine.ts`
  and `wasmBindings.ts` would need no changes at all.
- Performance is close: render path at parity (88.4 vs 85.4 us per frame at
  200x60), printable parse at parity, but **short SGR -4.4% and long SGR -8.9%**.

Crucially, owning the shim keeps the *batched* `get_viewport` — one call for the
whole viewport — instead of `main`'s per-cell row/cell iterator, which measured
2.9x-4.1x more expensive. That was the whole point of targeting 1.3.1.

## The compile fixes, which are correct and worth keeping

- `semantic_prompt.Command` gets `pub const C = void`. Its `options_unvalidated`
  is a slice, so it cannot live in the extern C union `lib/union.zig` builds
  over stream actions. This is exactly how ghostty `main` solves it. Upstream
  flags the gap itself: *"Before shipping an ABI-compatible libghostty, verify
  this."* Unpatched 1.3.1 only builds because Zig never forces that union's
  construction.
- OSC 133 collapses. 1.3.1 restructured it into `Command { action, options }`
  with `readOption()`, and `Terminal.semanticPrompt()` now does the row marking
  the patch hand-rolled — so five cases become one line.
- Fallibility drifted **both ways**: `restoreCursor`, `horizontalTab` and
  `horizontalTabBack` became infallible (drop `try`), while `scrollUp` became
  fallible (add `try`).

## Why it is broken

`gridSnapshot.test.ts` — which feeds identical bytes through both engines — is
what caught it. Two variants, both wrong:

**With ghostty-web's `Screen.zig` stale-cell fix reapplied:** the core logs
`error(screen): style addition failed after capacity increase` and 6 colour and
attribute parity tests fail. Glyph, row and cursor parity still pass, so it is
specifically style bookkeeping. The fix does:

```zig
row.* = .{ .cells = cells_offset, .dirty = dirty };
```

In 1.3.1 `Row` is a packed struct with `wrap`, `wrap_continuation`, `grapheme`,
`styled`, `hyperlink`, `semantic_prompt` and `kitty_virtual_placeholder`
alongside `cells` and `dirty`. That assignment resets every one of them —
including `styled` — while the style set still holds references for the row,
corrupting the ref-counted set.

**Without it, on upstream `Screen.zig`:** worse. The vitest worker exits
unexpectedly mid-suite; the module aborts rather than merely disagreeing.

## What this means

The **compile-level** drift from 1.2 to 1.3.1 is genuinely small — one hunk, one
restructured subsystem, a handful of fallibility changes. The **semantic** drift
is not. The shim carries assumptions about `Screen`, `Row` and the style set
that no longer hold, and those assumptions do not announce themselves at the
type level. An earlier estimate of "half a day" was wrong: this is a debugging
job against 1,123 lines of someone else's code and an unfamiliar core, not a
mechanical rebase.

Owning the shim is still the right *direction* — the ABI-identical export
surface and the preserved batched API prove the shape works. But it needs real
Zig debugging of style and row lifetime, not a patch rebase.

## Reproducing

```sh
git clone --depth 1 --branch v1.3.1 https://github.com/ghostty-org/ghostty.git
cd ghostty
git apply --exclude=.gitignore ../patches/ghostty-131-wasm-api.patch
zig build lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
```

The patch here **omits** the `Screen.zig` hunk (it is the variant that crashes;
the other variant corrupts styles). Both licences are MIT, so carrying
ghostty-web's work with attribution is fine.
