/**
 * OSC 52 — the escape sequence an application uses to put text on the
 * terminal's clipboard.
 *
 *   ESC ] 52 ; <targets> ; <base64> BEL
 *
 * This is the only clipboard path that works for a program running on the far
 * end of an SSH/telnet session: it has no access to the local clipboard, and
 * the mouse belongs to whatever full-screen UI it is drawing. Without it, an
 * app's own "copy" can do nothing but print an apology and tell the user to
 * shift-drag instead.
 *
 * The scanner (see ghostty/oscScanner) hands us everything after `52;`, so a
 * payload here looks like `c;SGVsbG8=`.
 */

/** Targets we honour. `c` is the clipboard proper; `s` is the (X11) select
 *  buffer, which apps also use to mean "the clipboard" on platforms that have
 *  only one; an empty target list means the terminal's configured default.
 *  `p` (X11 primary) is deliberately not honoured — on Windows there is no
 *  second buffer to put it in, and mapping it onto the clipboard would let a
 *  primary-selection sync overwrite what the user actually copied. */
const HONOURED = ['c', 's']

/**
 * A copy longer than this is refused rather than written. OSC 52 has no length
 * limit of its own, and the payload arrives over a socket we do not control, so
 * something has to bound what a single sequence can push at the clipboard.
 * 768 KB of base64 is ~576 KB of text — far past any plausible copy out of a
 * terminal, and comfortably under `oscScanner.OSC_PENDING_MAX`, so a payload
 * this size is accepted whether it arrives whole or split across deliveries.
 */
export const OSC52_MAX_BASE64 = 768 * 1024

/** What an OSC 52 payload asks the terminal to do. */
export type Osc52Request =
  /** Put `text` on the clipboard. */
  | { kind: 'write'; text: string }
  /** A read (`Pd` is `?`). Answering hands the remote end the contents of the
   *  user's clipboard, so this is always reported and never answered. */
  | { kind: 'read' }
  /** Malformed, or a target we don't honour. Ignore it. */
  | { kind: 'ignore' }

/**
 * Parses an OSC 52 payload. Pure, so the grammar can be tested without a
 * clipboard or a terminal; the caller decides what to do with the result.
 */
export function parseOsc52(payload: string): Osc52Request {
  const sep = payload.indexOf(';')
  if (sep === -1) return { kind: 'ignore' }
  const targets = payload.slice(0, sep)
  const data = payload.slice(sep + 1)

  // An empty target list is the default, which we treat as the clipboard.
  if (targets !== '' && !targets.split('').some((t) => HONOURED.includes(t))) {
    return { kind: 'ignore' }
  }

  if (data === '?') return { kind: 'read' }

  // Senders that chunk a long payload wrap it, and the base64 alphabet has no
  // whitespace in it, so stripping is unambiguous.
  const b64 = data.replace(/\s+/g, '')
  if (b64.length === 0) {
    // Explicitly clearing the clipboard is a legitimate use of an empty
    // payload, and writing '' is exactly that.
    return { kind: 'write', text: '' }
  }
  if (b64.length > OSC52_MAX_BASE64) return { kind: 'ignore' }

  let bytes: Uint8Array
  try {
    const bin = atob(b64)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } catch {
    // Not valid base64 — nothing to put anywhere.
    return { kind: 'ignore' }
  }

  // The wire is UTF-8, and a copy that happens to hold an invalid byte should
  // still land (with a replacement character) rather than being dropped whole.
  return { kind: 'write', text: new TextDecoder().decode(bytes) }
}
