/**
 * One allocation API for both binaries the probes compare. Upstream
 * `a8e9b413f` replaced the type-specific wasm allocators with
 * `ghostty_wasm_alloc` / `ghostty_wasm_free`, while the v1.3.1 comparison
 * build keeps the old names. So the probes keep the legacy names, and this
 * supplies them over whichever API the binary has.
 *
 * `Instance.exports` is frozen, so the shims go on an `Object.create(exports)`
 * child that delegates everything else. Never copy with `Object.assign`: a
 * plain object's properties call measurably slower (1.85x on call-heavy
 * loops), and since only the `main` arm is wrapped, that reads as an upstream
 * regression.
 */

/** `size_t` on wasm32, what the retired `ghostty_wasm_alloc_usize` reserved. */
const USIZE_BYTES = 4

export function withAllocCompat(exports) {
  // Old binary: already speaks the legacy names.
  if (typeof exports.ghostty_wasm_alloc !== 'function') return exports

  // Delegation, not a copy (see above).
  const ex = Object.create(exports)
  ex.ghostty_wasm_alloc_u8_array = (len) => exports.ghostty_wasm_alloc(len)
  ex.ghostty_wasm_free_u8_array = (ptr, len) => exports.ghostty_wasm_free(ptr, len)
  ex.ghostty_wasm_alloc_usize = () => exports.ghostty_wasm_alloc(USIZE_BYTES)
  ex.ghostty_wasm_free_usize = (ptr) => exports.ghostty_wasm_free(ptr, USIZE_BYTES)
  return ex
}
