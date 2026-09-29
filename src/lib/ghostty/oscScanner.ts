/**
 * Byte-level OSC/BEL scanner for the Ghostty engine.
 *
 * The core doesn't surface OSC dispatch or the bell yet, so they're recovered by
 * scanning the stream. Kept as a pure function — bytes in, events out — so the
 * grammar and the cross-chunk bookkeeping can be tested without a WASM core or a
 * DOM. `GhosttyEngine.parseAndDispatch` is the only caller; it uses `segEnd` to
 * feed the parser in segments so each handler runs with everything before it
 * already parsed.
 *
 * This is not deletable by adding an export, which is the obvious assumption and
 * the wrong one: Ghostty v1.3.1's OSC parser has no ident for **633**, which this
 * app registers alongside 133, and dropping it would half-break shell integration
 * for VS-Code-configured shells only. Scanning for 633 alone costs the same as
 * scanning for everything, so this earns its keep until Ghostty's own parser
 * learns the ident. See the OSC-scan findings in `bench/runner.ts`.
 *
 * Grammar recognised (7-bit forms only, which is what shells emit in practice):
 *
 *   OSC   ESC ] <digits> ; <payload> (BEL | ESC \)
 *   bell  BEL
 *   RIS   ESC c        (only when the caller asks for it — see `wantRis`)
 *
 * The payload deliberately cannot span BEL or ESC: that is what bounds it, and
 * what an unterminated sequence would otherwise run past.
 *
 * CAN (0x18) and SUB (0x1A) cancel it: the sequence ends, nothing is
 * dispatched, and scanning resumes after the cancelling byte — as the DEC
 * parser, xterm and the core all do. Without that, a cancelled OSC stayed open
 * until the next BEL and was dispatched with the output after it as payload.
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
 * An unterminated sequence this long is not going to terminate. Dropped rather
 * than allowed to grow without bound.
 *
 * Sized for OSC 52, which is the one sequence here whose payload is user data
 * rather than a label: a clipboard write carries base64 of everything being
 * copied, and arrives split across as many deliveries as the socket and the
 * coalescer choose. At the old 4 KB this silently dropped any copy past ~3 KB of
 * text that happened to straddle a chunk boundary — which is most of them, since
 * a payload that large always does. It leaves headroom over
 * `osc52.OSC52_MAX_BASE64` for the sequence's own framing and any wrapping a
 * chunked sender adds, so a payload that size bound accepts survives being split
 * as well as it does arriving whole.
 *
 * Not larger, because a carried-over buffer is prepended to every subsequent
 * chunk until the sequence terminates: cost is (pending size × chunks it spans),
 * so the cap is what stops a never-terminated sequence from turning each
 * delivery into a multi-megabyte copy. A megabyte keeps that in the tens of
 * milliseconds across a whole copy, even against 4 KB deliveries.
 */
export const OSC_PENDING_MAX = 1024 * 1024

export interface OscScanEvent {
  kind: 'osc' | 'bell' | 'ris'
  /** OSC ident; 0 for a bell or a RIS. */
  ident: number
  /** Decoded OSC payload; empty for a bell or a RIS. */
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
 * @param wantRis also report `ESC c` (RIS). Off by default because it is not
 *                free: 'c' is an ordinary letter, so hunting it costs an
 *                `indexOf` call per occurrence, where ']' costs one scan that
 *                finds nothing. Measured on colour-wrapped prose — the shape
 *                real SSH traffic has — this scan goes from 0.43 to 1.92 ms/MB,
 *                4.4x, which is why it is asked for only while something is
 *                listening. See `GhosttyEngine.registerResetHandler`.
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

  // Jump between the bytes that can start something, rather than stepping
  // through every byte in JS.
  //
  // The byte hunted for is ']', not ESC. An OSC can only open at `ESC ]`, so
  // both find the same sequences — but they cost wildly different amounts on
  // the traffic this app actually carries. Escape-dense output recurs an ESC
  // every few bytes while never containing a ']' at all, so hunting the ESC
  // meant an indexOf call per escape to reject it, and hunting the ']' means a
  // single memchr that returns -1 for the whole buffer. That case is not a
  // corner: a live pane measured 1.675 ms/MB against plain text's 0.431,
  // because real SSH traffic is escape-dense.
  //
  // The trade is that ']'-dense content now costs a call per ']'. `anyEsc`
  // bounds it — no ESC in the buffer means no OSC can open no matter how many
  // brackets there are, so bracket-heavy plain text (JSON, source) skips the
  // hunt outright and pays the same two passes it always did.
  //
  // The positions are cached rather than recomputed each step, which matters
  // more than the jump itself: calling indexOf for both bytes at every hit
  // would rescan to the end of the buffer for whichever one is absent, once per
  // hit, turning dense output quadratic. Recomputing only when the cursor
  // passes a cached hit keeps each byte value to a single forward pass, and a
  // value that never appears costs exactly one scan that returns -1.
  const anyEsc = scan.indexOf(ESC) >= 0
  let oscAt = anyEsc ? scan.indexOf(OSC_INTRO) : -1
  let belAt = scan.indexOf(BEL)
  let risAt = wantRis && anyEsc ? scan.indexOf(RIS_TAIL) : -1

  while (i < scan.length) {
    if (oscAt >= 0 && oscAt < i) oscAt = scan.indexOf(OSC_INTRO, i)
    if (belAt >= 0 && belAt < i) belAt = scan.indexOf(BEL, i)
    if (risAt >= 0 && risAt < i) risAt = scan.indexOf(RIS_TAIL, i)
    if (oscAt < 0 && belAt < 0 && risAt < 0) break

    // A bell only counts if it comes first. Ordering is checked against the
    // ']' rather than the ESC before it, which is safe because that byte is an
    // ESC by definition and so cannot itself be the BEL: the two can never tie.
    if (belAt >= 0 && (oscAt < 0 || belAt < oscAt) && (risAt < 0 || belAt < risAt)) {
      ;(events ??= []).push({ kind: 'bell', ident: 0, payload: '', segEnd: belAt + 1 - base })
      i = belAt + 1
      continue
    }

    // Same shape as the ']' branch below: the hunted byte is the *second* of
    // the pair, so a bare 'c' is only a reset if an ESC precedes it. Checked
    // before the OSC branch when it comes first, so `ESC c` inside a chunk that
    // also carries an OSC is still seen — and never checked *inside* an OSC
    // string, because that branch consumes the whole sequence and the cached
    // positions are recomputed from `i` on the next turn of the loop.
    if (risAt >= 0 && (oscAt < 0 || risAt < oscAt)) {
      if (risAt > 0 && scan[risAt - 1] === ESC) {
        ;(events ??= []).push({ kind: 'ris', ident: 0, payload: '', segEnd: risAt + 1 - base })
      }
      i = risAt + 1
      continue
    }

    // A ']' with no ESC in front of it is just a bracket. Step past it and
    // resume; a ']' at offset 0 has nothing in front of it to check.
    if (oscAt === 0 || scan[oscAt - 1] !== ESC) {
      i = oscAt + 1
      continue
    }
    const seqStart = oscAt - 1

    // Inside an OSC string, run to its terminator before interpreting anything.
    // A BEL in here is the terminator, never a bell — resuming the outer scan
    // inside an OSC we failed to recognise is what used to ring the bell for
    // every unrecognised OSC form.
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
      // Cancelled: resume *after* the CAN/SUB, which unlike an aborting ESC
      // cannot open anything itself. A BEL further on is then a real bell.
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
      // An ESC that isn't ST ends this sequence without terminating it, and so
      // does a CAN or SUB. Resume at that ESC, which may open the next one, or
      // just past the CAN/SUB.
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
    // Recognised or not, the whole sequence is consumed.
    i = termEnd
  }

  // A chunk ending on a bare ESC may be the first half of an `ESC ]` split
  // across deliveries. The loop hunts ']' and so never sees that ESC; carrying
  // it is what keeps a title sequence recognisable when the coalescer happens
  // to cut between its two opening bytes. It cannot already have been consumed:
  // every sequence the loop consumes ends on BEL or '\', never on ESC.
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
