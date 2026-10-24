/**
 * OSC 52: an application putting text on the terminal's clipboard.
 *
 *   ESC ] 52 ; <targets> ; <base64> BEL
 *
 * The only clipboard path for a program on the far end of SSH or telnet. The
 * engine's OSC handler (ghostty/oscStream) passes everything after `52;`, e.g.
 * `c;SGVsbG8=`.
 */

/** Targets we honor: `c` (clipboard) and `s` (X11 select buffer, often meant
 *  as the clipboard); an empty list means the default. `p` (X11 primary) isn't
 *  honored: Windows has no second buffer, and a primary-selection sync would
 *  overwrite what the user copied. */
const HONOURED = ['c', 's']

/**
 * A larger copy is refused. OSC 52 has no length limit and the payload comes
 * from an untrusted socket. 768 KB of base64 is ~576 KB of text, and under
 * `oscStream.OSC_PENDING_MAX`, so it's accepted whole or split.
 */
export const OSC52_MAX_BASE64 = 768 * 1024

/** What an OSC 52 payload asks the terminal to do. */
export type Osc52Request =
  /** Put `text` on the clipboard. */
  | { kind: 'write'; text: string }
  /** A read (`Pd` is `?`). Answering would hand the remote end the user's
   *  clipboard, so it's never answered. */
  | { kind: 'read' }
  /** Malformed, or a target we don't honor. Ignore it. */
  | { kind: 'ignore' }

/**
 * Parses an OSC 52 payload. Pure; the caller decides what to do.
 */
export function parseOsc52(payload: string): Osc52Request {
  const sep = payload.indexOf(';')
  if (sep === -1) return { kind: 'ignore' }
  const targets = payload.slice(0, sep)
  const data = payload.slice(sep + 1)

  // An empty target list is the default: the clipboard.
  if (targets !== '' && !targets.split('').some((t) => HONOURED.includes(t))) {
    return { kind: 'ignore' }
  }

  if (data === '?') return { kind: 'read' }

  // Chunking senders wrap long payloads; base64 has no whitespace.
  const b64 = data.replace(/\s+/g, '')
  if (b64.length === 0) {
    // An empty payload clears the clipboard.
    return { kind: 'write', text: '' }
  }
  if (b64.length > OSC52_MAX_BASE64) return { kind: 'ignore' }

  let bytes: Uint8Array
  try {
    const bin = atob(b64)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } catch {
    // Not valid base64.
    return { kind: 'ignore' }
  }

  // UTF-8; an invalid byte becomes a replacement character rather than
  // dropping the copy.
  return { kind: 'write', text: new TextDecoder().decode(bytes) }
}

/** What [`applyOsc52`] needs, so it's testable without a real clipboard. */
export interface Osc52Sink {
  /** Whether the user allows the far end to set the clipboard at all. */
  allowWrite: boolean
  /** Performs the write. Rejection is reported through `onError`. */
  writeText: (text: string) => Promise<void>
  /** A write landed; the caller tells the user. */
  onWrote: () => void
  onError: (message: string) => void
}

/**
 * Decides and performs what a parsed payload asks, here rather than in
 * `Terminal.tsx` so tests exercise the shipped decision. Always returns
 * `true`: the sequence is consumed either way, or a refused write would print
 * its base64 as garbage.
 */
export function applyOsc52(payload: string, sink: Osc52Sink): boolean {
  const req = parseOsc52(payload)
  // No `read` branch, deliberately: answering would leak the clipboard.
  // `allowWrite` gates writes only.
  if (req.kind === 'write' && sink.allowWrite) {
    sink
      .writeText(req.text)
      .then(sink.onWrote)
      .catch((e) => sink.onError(`OSC 52 clipboard write failed: ${e}`))
  }
  return true
}
