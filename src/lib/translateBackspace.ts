/**
 * DEL to BS, for sessions whose host expects `^H`.
 *
 * On bytes rather than on a string, because what comes out of the engine is
 * bytes and some of it is not text — a legacy mouse report past column 95
 * carries a byte that is not valid UTF-8, and decoding it to run a string
 * replace destroys the coordinate. 0x7f cannot occur inside a UTF-8
 * multi-byte sequence, so scanning for it bytewise is safe on any payload.
 */
export function translateBackspace(data: Uint8Array, enabled: boolean): Uint8Array {
  if (!enabled) return data
  let out: Uint8Array | null = null
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0x7f) continue
    // Copied only once something actually needs changing: the overwhelming
    // majority of payloads contain no DEL at all.
    if (!out) out = data.slice()
    out[i] = 0x08
  }
  return out ?? data
}
