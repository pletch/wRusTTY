/**
 * Byte-level OSC/BEL scanner for the Ghostty engine.
 *
 * The core doesn't surface OSC dispatch or the bell yet, so they're recovered by
 * scanning the stream. Kept as a pure function — bytes in, events out — so the
 * grammar and the cross-chunk bookkeeping can be tested without a WASM core or a
 * DOM. `GhosttyEngine.parseAndDispatch` is the only caller; it uses `segEnd` to
 * feed the parser in segments so each handler runs with everything before it
 * already parsed. Delete this once libghostty-vt exposes the callbacks.
 *
 * Grammar recognised (7-bit forms only, which is what shells emit in practice):
 *
 *   OSC   ESC ] <digits> ; <payload> (BEL | ESC \)
 *   bell  BEL
 *
 * The payload deliberately cannot span BEL or ESC: that is what bounds it, and
 * what an unterminated sequence would otherwise run past.
 */

const ESC = 0x1b
const BEL = 0x07
const OSC_INTRO = 0x5d // ']', as in ESC ]
const ST_TAIL = 0x5c // '\', as in ESC \
const SEMICOLON = 0x3b
const ZERO = 0x30
const NINE = 0x39

/** An unterminated sequence this long is not going to terminate. Dropped rather
 *  than allowed to grow without bound. */
export const OSC_PENDING_MAX = 4096

export interface OscScanEvent {
  kind: 'osc' | 'bell'
  /** OSC ident; 0 for a bell. */
  ident: number
  /** Decoded OSC payload; empty for a bell. */
  payload: string
  /**
   * Offset into the *current* chunk that the parser must reach before this event
   * is dispatched — the end of the sequence itself. Always > 0: a sequence can
   * only complete in the current chunk, never inside carried-over pending bytes.
   */
  segEnd: number
}

export interface OscScanResult {
  events: OscScanEvent[]
  /** Unterminated trailing sequence to carry into the next chunk, or null. */
  pending: Uint8Array | null
}

const NO_EVENTS: OscScanEvent[] = []

/**
 * @param bytes   the chunk about to be parsed
 * @param pending unterminated bytes carried from the previous chunk. They have
 *                already been parsed — they are retained only so a sequence
 *                split across the boundary still matches — so offsets returned
 *                are relative to `bytes` alone.
 */
export function scanOsc(
  bytes: Uint8Array,
  pending: Uint8Array | null,
  decoder: TextDecoder,
): OscScanResult {
  let scan: Uint8Array
  if (pending && pending.length > 0) {
    scan = new Uint8Array(pending.length + bytes.length)
    scan.set(pending, 0)
    scan.set(bytes, pending.length)
  } else {
    scan = bytes
  }
  const base = pending ? pending.length : 0

  let events: OscScanEvent[] | null = null
  let i = 0
  let unterminatedAt = -1

  while (i < scan.length) {
    const b = scan[i]
    if (b !== ESC && b !== BEL) {
      i++
      continue
    }

    if (b === BEL) {
      ;(events ??= []).push({ kind: 'bell', ident: 0, payload: '', segEnd: i + 1 - base })
      i++
      continue
    }

    // ESC: only ESC ] opens an OSC. Everything else (CSI and friends) is the
    // parser's business, not this scanner's.
    if (i + 1 >= scan.length) {
      unterminatedAt = i
      break
    }
    if (scan[i + 1] !== OSC_INTRO) {
      i++
      continue
    }

    // Inside an OSC string, run to its terminator before interpreting anything.
    // A BEL in here is the terminator, never a bell — resuming the outer scan
    // inside an OSC we failed to recognise is what used to ring the bell for
    // every unrecognised OSC form.
    const contentStart = i + 2
    let k = contentStart
    let contentEnd = -1
    let termEnd = -1
    let abortedAt = -1
    while (k < scan.length) {
      const c = scan[k]
      if (c === BEL) {
        contentEnd = k
        termEnd = k + 1
        break
      }
      if (c === ESC) {
        // Need the next byte to tell ST from an abort.
        if (k + 1 >= scan.length) break
        if (scan[k + 1] === ST_TAIL) {
          contentEnd = k
          termEnd = k + 2
          break
        }
        abortedAt = k
        break
      }
      k++
    }

    if (abortedAt >= 0) {
      // An ESC that isn't ST ends this sequence without terminating it. Resume
      // at that ESC: it may open the next one.
      i = abortedAt
      continue
    }
    if (termEnd < 0) {
      unterminatedAt = i
      break
    }

    // Grammar inside the string: <digits> ; <payload>
    let p = contentStart
    let ident = 0
    let digits = 0
    while (p < contentEnd && scan[p] >= ZERO && scan[p] <= NINE) {
      ident = ident * 10 + (scan[p] - ZERO)
      p++
      digits++
    }
    if (digits > 0 && p < contentEnd && scan[p] === SEMICOLON) {
      ;(events ??= []).push({
        kind: 'osc',
        ident,
        payload: decoder.decode(scan.subarray(p + 1, contentEnd)),
        segEnd: termEnd - base,
      })
    }
    // Recognised or not, the whole sequence is consumed.
    i = termEnd
  }

  let nextPending: Uint8Array | null = null
  if (unterminatedAt >= 0) {
    const tail = scan.subarray(unterminatedAt)
    nextPending = tail.length > OSC_PENDING_MAX ? null : tail.slice()
  }

  return { events: events ?? NO_EVENTS, pending: nextPending }
}
