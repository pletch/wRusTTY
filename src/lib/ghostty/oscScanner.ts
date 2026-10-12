/**
 * Byte-level OSC/BEL scanner for the Ghostty engine.
 *
 * The core doesn't surface OSC dispatch or the bell, so they're recovered by
 * scanning the stream. A pure function (bytes in, events out) so it tests
 * without WASM or a DOM. `GhosttyEngine.parseAndDispatch` is the only caller;
 * it uses `segEnd` to feed the parser in segments, so each handler runs with
 * everything before it already parsed.
 *
 * Still needed because Ghostty v1.3.1's OSC parser has no ident for 633, which
 * this app registers alongside 133 (see upstream discussion #14645).
 *
 * Grammar (7-bit forms only):
 *
 *   OSC   ESC ] <digits> ; <payload> (BEL | ESC \)
 *   bell  BEL
 *   RIS   ESC c        (only with `wantRis`)
 *
 * The payload can't span BEL or ESC. CAN (0x18) and SUB (0x1A) cancel it:
 * nothing is dispatched and scanning resumes after the canceling byte, as in
 * the DEC parser, xterm and the core.
 */

const ESC = 0x1b
const BEL = 0x07
const CAN = 0x18
const SUB = 0x1a
const OSC_INTRO = 0x5d // ']', as in ESC ]
const ST_TAIL = 0x5c // '\', as in ESC \
const SEMICOLON = 0x3b
const RIS_TAIL = 0x63 // 'c', as in ESC c
const ZERO = 0x30
const NINE = 0x39

/**
 * An unterminated sequence this long won't terminate, so it's dropped. Sized
 * for OSC 52, whose base64 payload is user data split across many deliveries,
 * with headroom over `osc52.OSC52_MAX_BASE64` for framing. Not larger, since
 * pending bytes are prepended to every chunk until the sequence ends.
 */
export const OSC_PENDING_MAX = 1024 * 1024

export interface OscScanEvent {
  kind: 'osc' | 'bell' | 'ris'
  /** OSC ident; 0 for a bell or a RIS. */
  ident: number
  /** Decoded OSC payload; empty for a bell or a RIS. */
  payload: string
  /**
   * Offset into the current chunk the parser must reach before this event is
   * dispatched (the end of the sequence). Always > 0: a sequence can only
   * complete in the current chunk.
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
 * @param pending unterminated bytes from the previous chunk, already parsed and
 *                kept only so a split sequence still matches; offsets are
 *                relative to `bytes` alone.
 * @param wantRis also report `ESC c` (RIS). Off by default: 'c' is an ordinary
 *                letter, so hunting it costs about 4x on typical traffic. Asked
 *                for only while a reset handler is registered.
 */
export function scanOsc(
  bytes: Uint8Array,
  pending: Uint8Array | null,
  decoder: TextDecoder,
  wantRis = false,
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

  // Jump between bytes that can start something rather than stepping in JS.
  // The hunted byte is ']', not ESC: escape-dense output rarely contains ']', so
  // one memchr returns -1 for the buffer. `anyEsc` bounds the ']'-dense case
  // (JSON, source): with no ESC, no OSC can open. Positions are cached and only
  // recomputed once passed, keeping each byte value to one forward pass instead
  // of going quadratic.
  const anyEsc = scan.indexOf(ESC) >= 0
  let oscAt = anyEsc ? scan.indexOf(OSC_INTRO) : -1
  let belAt = scan.indexOf(BEL)
  let risAt = wantRis && anyEsc ? scan.indexOf(RIS_TAIL) : -1

  while (i < scan.length) {
    if (oscAt >= 0 && oscAt < i) oscAt = scan.indexOf(OSC_INTRO, i)
    if (belAt >= 0 && belAt < i) belAt = scan.indexOf(BEL, i)
    if (risAt >= 0 && risAt < i) risAt = scan.indexOf(RIS_TAIL, i)
    if (oscAt < 0 && belAt < 0 && risAt < 0) break

    // A bell counts only if it comes first. Comparing against the ']' is safe:
    // the byte before it is an ESC, so it can't tie with a BEL.
    if (belAt >= 0 && (oscAt < 0 || belAt < oscAt) && (risAt < 0 || belAt < risAt)) {
      ;(events ??= []).push({ kind: 'bell', ident: 0, payload: '', segEnd: belAt + 1 - base })
      i = belAt + 1
      continue
    }

    // As with ']', the hunted 'c' is a reset only after an ESC. Never checked
    // inside an OSC string: that branch consumes the whole sequence.
    if (risAt >= 0 && (oscAt < 0 || risAt < oscAt)) {
      if (risAt > 0 && scan[risAt - 1] === ESC) {
        ;(events ??= []).push({ kind: 'ris', ident: 0, payload: '', segEnd: risAt + 1 - base })
      }
      i = risAt + 1
      continue
    }

    // A ']' without a preceding ESC is just a bracket.
    if (oscAt === 0 || scan[oscAt - 1] !== ESC) {
      i = oscAt + 1
      continue
    }
    const seqStart = oscAt - 1

    // Inside an OSC string, run to its terminator first. A BEL here is the
    // terminator, never a bell.
    const contentStart = seqStart + 2
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
      // Canceled: resume after the CAN/SUB, which can't open anything itself.
      if (c === CAN || c === SUB) {
        abortedAt = k + 1
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
      // An ESC that isn't ST, or a CAN/SUB, ends the sequence unterminated. Resume
      // at that ESC (it may open the next one) or just past the CAN/SUB.
      i = abortedAt
      continue
    }
    if (termEnd < 0) {
      unterminatedAt = seqStart
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
    // Recognized or not, the whole sequence is consumed.
    i = termEnd
  }

  // A chunk ending on a bare ESC may be half of an `ESC ]` split across
  // deliveries; the loop hunts ']' and never sees it, so carry it. It can't have
  // been consumed: consumed sequences end on BEL or '\'.
  if (unterminatedAt < 0 && scan.length > 0 && scan[scan.length - 1] === ESC) {
    unterminatedAt = scan.length - 1
  }

  let nextPending: Uint8Array | null = null
  if (unterminatedAt >= 0) {
    const tail = scan.subarray(unterminatedAt)
    nextPending = tail.length > OSC_PENDING_MAX ? null : tail.slice()
  }

  return { events: events ?? NO_EVENTS, pending: nextPending }
}
