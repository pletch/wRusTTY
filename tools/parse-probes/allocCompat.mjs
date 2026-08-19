/**
 * One allocation API for both binaries these probes compare.
 *
 * Every probe boots a ghostty `main` build *and* the v1.3.1 build in the same
 * process, and upstream `a8e9b413f` replaced the type-specific wasm allocators
 * with a generic `ghostty_wasm_alloc` / `ghostty_wasm_free`. The v1.3.1 build
 * still exports the old names and always will, so the probes cannot simply be
 * renamed onto the new ones — that would fix the `main` arm and break the
 * comparison arm, which is the half that makes the numbers mean anything.
 *
 * So the legacy names stay as the probes' internal vocabulary and this supplies
 * them over whichever API the binary actually has. Call sites are untouched.
 *
 * `Instance.exports` is frozen, so the legacy names cannot be assigned onto it.
 *
 * **Delegate, never copy.** `Object.create(exports)` puts the shims on a child
 * object and leaves every other call resolving through the prototype to the real
 * export. Copying with `Object.assign` instead — which this did at first —
 * costs about **1.85x on call-heavy loops** (60.2µs vs 32.5µs per 200x60 frame
 * on the `iterate` path), because the copy is a plain object whose properties
 * V8 cannot call as directly as a module namespace's.
 *
 * That is not a footnote: only the `main` arm gets wrapped, so the cost lands on
 * one side of a two-binary comparison and reads as an upstream regression. It
 * did exactly that on the `d9ffbbf17` bump — `iterate` and `raw` appeared ~2x
 * slower until the same loop was run against unwrapped exports and the two pins
 * came out identical. Measured with `Object.create`: 30.1µs, i.e. free.
 */

/** `size_t` on wasm32 — what the retired `ghostty_wasm_alloc_usize` reserved. */
const USIZE_BYTES = 4

export function withAllocCompat(exports) {
  // Old binary: already speaks the legacy names, nothing to add.
  if (typeof exports.ghostty_wasm_alloc !== 'function') return exports

  // Delegation, not a copy — see above. This is load-bearing for the numbers.
  const ex = Object.create(exports)
  ex.ghostty_wasm_alloc_u8_array = (len) => exports.ghostty_wasm_alloc(len)
  ex.ghostty_wasm_free_u8_array = (ptr, len) => exports.ghostty_wasm_free(ptr, len)
  ex.ghostty_wasm_alloc_usize = () => exports.ghostty_wasm_alloc(USIZE_BYTES)
  ex.ghostty_wasm_free_usize = (ptr) => exports.ghostty_wasm_free(ptr, USIZE_BYTES)
  return ex
}
