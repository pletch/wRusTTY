/**
 * DEL to BS, for hosts expecting `^H`. Over bytes, since engine output isn't
 * always text (a legacy mouse report past column 95 isn't valid UTF-8). 0x7f
 * can't occur inside a UTF-8 sequence, so a bytewise scan is safe.
 */
export function translateBackspace(data: Uint8Array, enabled: boolean): Uint8Array {
  if (!enabled) return data
  let out: Uint8Array | null = null
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0x7f) continue
    // Copied only when something changes; most payloads have no DEL.
    if (!out) out = data.slice()
    out[i] = 0x08
  }
  return out ?? data
}
