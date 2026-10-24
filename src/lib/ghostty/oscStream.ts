/**
 * Finds OSC sequences in the output using the core's own parser.
 *
 * The app acts on several OSCs itself (titles, OSC 7, 9, 52, 133/633, 777,
 * 1337), and some handlers must run at the sequence, before the rest of the
 * write is parsed: the leftover-mode reset at an OSC 133 marker writes
 * `? 1049 l` back into the terminal, which has to land before the shell's next
 * prompt. A core callback can't do that, because it fires inside `vt_write`
 * and must not write back.
 *
 * `ghostty_terminal_vt_write_until` can: it parses up to and including the byte
 * where an OSC starts or ends, then returns. This feeds a chunk through it with
 * OSC_START|OSC_END, collects each OSC's content (across chunks when it spans
 * them), and hands a complete OSC to the sink after the core has parsed it and
 * before it parses anything after it.
 *
 * This replaced `oscScanner.ts`, a byte scanner in JS that found the same
 * points by itself. The core's parser already knows CAN and SUB, 8-bit
 * introducers, and terminators split across chunks, which the scanner had to
 * reimplement and once got wrong.
 *
 * An OSC is handed over only when it ends with BEL or `ESC \`. One that is
 * canceled (CAN, SUB) or cut short by another escape sequence is dropped, as
 * the scanner did.
 */

import * as abi from './main/abi'

/**
 * The longest OSC collected. Sized for OSC 52, whose payload is everything
 * being copied, base64-encoded; longer ones are dropped whole.
 */
export const OSC_PENDING_MAX = 1024 * 1024

const BACKSLASH = 0x5c
const SEMICOLON = 0x3b
const ZERO = 0x30
const NINE = 0x39

export interface OscStreamSink {
  /**
   * Called before an OSC is handed over, and once when the write is done.
   * Events the core reported by callback during the write (bells, resets) are
   * handed on here, so anything that came before an OSC is delivered before
   * that OSC's handler runs.
   */
  stop(): void
  /**
   * A complete OSC's content: everything between `ESC ]` and its terminator.
   * Only valid during the call; it may be a view into the caller's chunk.
   */
  osc(content: Uint8Array): void
}

export class OscStream {
  private readonly ex: abi.GhosttyMainExports
  private readonly term: number
  private readonly stopPtr: number
  private buf = 0
  private bufCap = 0
  /** Reused until linear memory grows and detaches its buffer. */
  private view: DataView
  /** Inside an OSC whose terminator hasn't been seen yet. */
  private inOsc = false
  /**
   * Where the open OSC's content starts in the current chunk. Content that
   * arrived in earlier chunks is in `carry`, copied once when its chunk ended.
   */
  private openStart = 0
  private carry: Uint8Array[] = []
  private carryLen = 0
  private overflow = false
  /** An OSC that ended in ESC, waiting for the `\` that completes ST. */
  private awaitingBackslash: Uint8Array | null = null

  constructor(ex: abi.GhosttyMainExports, term: number) {
    this.ex = ex
    this.term = term
    this.stopPtr = ex.ghostty_wasm_alloc(abi.WRITE_STOP_SIZE)
    this.view = new DataView(ex.memory.buffer)
    // Set once: the call resets every other field itself.
    this.dv().setUint32(this.stopPtr + abi.WRITE_STOP_OFF_SIZE, abi.WRITE_STOP_SIZE, true)
  }

  write(bytes: Uint8Array, sink: OscStreamSink): void {
    if (bytes.length === 0) return
    const ptr = this.stage(bytes)
    let off = 0
    // An OSC carried in from the last chunk continues from this chunk's start.
    this.openStart = 0

    // The `\` of an `ESC \` that straddled the previous chunk.
    if (this.awaitingBackslash) {
      const content = this.awaitingBackslash
      this.awaitingBackslash = null
      if (bytes[0] === BACKSLASH) {
        this.ex.ghostty_terminal_vt_write(this.term, ptr, 1)
        off = 1
        sink.stop()
        sink.osc(content)
      }
    }

    while (off < bytes.length) {
      const result = this.ex.ghostty_terminal_vt_write_until(
        this.term,
        ptr + off,
        bytes.length - off,
        abi.BOUNDARY_OSC_START | abi.BOUNDARY_OSC_END,
        this.stopPtr,
      )
      if (result === abi.GHOSTTY_NO_VALUE) break
      abi.expectOk(result, 'vt_write_until')

      const dv = this.dv()
      off += dv.getUint32(this.stopPtr + abi.WRITE_STOP_OFF_CONSUMED, true)
      const reached = dv.getUint32(this.stopPtr + abi.WRITE_STOP_OFF_REACHED, true)

      if (reached & abi.BOUNDARY_OSC_END) {
        // The last byte consumed is the terminator, not content.
        const content = this.close(bytes, off - 1)
        const end = dv.getUint32(this.stopPtr + abi.WRITE_STOP_OFF_END, true)
        if (content && end === abi.STRING_END_BEL) {
          sink.stop()
          sink.osc(content)
        } else if (content && end === abi.STRING_END_ST_ESC) {
          // ST is `ESC \`, and the call stopped after the ESC. Inserting
          // anything before the `\` would be parsed as part of the escape, so
          // complete the terminator first. Without a `\` it was some other
          // escape sequence, which ends the OSC without terminating it.
          if (off < bytes.length) {
            if (bytes[off] === BACKSLASH) {
              this.ex.ghostty_terminal_vt_write(this.term, ptr + off, 1)
              off += 1
              sink.stop()
              sink.osc(content)
            }
          } else {
            this.awaitingBackslash = content.slice()
          }
        }
      }
      if (reached & abi.BOUNDARY_OSC_START) {
        this.inOsc = true
        this.openStart = off
        this.carry = []
        this.carryLen = 0
        this.overflow = false
      }
    }

    // Still inside an OSC: keep this chunk's part of it, once, since the
    // caller may reuse the chunk.
    if (this.inOsc) this.keep(bytes.subarray(this.openStart))
    sink.stop()
  }

  /** Frees the wasm buffers. The terminal itself belongs to the caller. */
  dispose(): void {
    this.ex.ghostty_wasm_free(this.stopPtr, abi.WRITE_STOP_SIZE)
    if (this.bufCap > 0) this.ex.ghostty_wasm_free(this.buf, this.bufCap)
    this.bufCap = 0
  }

  private dv(): DataView {
    if (this.view.buffer !== this.ex.memory.buffer) this.view = new DataView(this.ex.memory.buffer)
    return this.view
  }

  /** Copies the chunk into wasm memory, reusing the buffer when it fits. */
  private stage(bytes: Uint8Array): number {
    if (bytes.length > this.bufCap) {
      if (this.bufCap > 0) this.ex.ghostty_wasm_free(this.buf, this.bufCap)
      this.bufCap = Math.max(bytes.length, 64 * 1024)
      this.buf = this.ex.ghostty_wasm_alloc(this.bufCap)
      if (this.buf === 0) {
        this.bufCap = 0
        throw new Error(`could not allocate ${bytes.length} bytes for a terminal write`)
      }
    }
    new Uint8Array(this.ex.memory.buffer, this.buf, bytes.length).set(bytes)
    return this.buf
  }

  /** Copies the part of an open OSC that a chunk ended in, unless over the cap. */
  private keep(part: Uint8Array): void {
    if (this.overflow || part.length === 0) return
    if (this.carryLen + part.length > OSC_PENDING_MAX) {
      this.overflow = true
      this.carry = []
      this.carryLen = 0
      return
    }
    this.carry.push(part.slice())
    this.carryLen += part.length
  }

  /**
   * Closes the open OSC, whose content ends at `end` in this chunk. Null if
   * there wasn't one or it went over the cap.
   */
  private close(bytes: Uint8Array, end: number): Uint8Array | null {
    if (!this.inOsc) return null
    this.inOsc = false
    const tail = bytes.subarray(this.openStart, Math.max(this.openStart, end))
    const carry = this.carry
    const total = this.carryLen + tail.length
    const overflow = this.overflow || total > OSC_PENDING_MAX
    this.carry = []
    this.carryLen = 0
    this.overflow = false
    if (overflow) return null
    if (carry.length === 0) return tail
    const out = new Uint8Array(total)
    let at = 0
    for (const p of carry) {
      out.set(p, at)
      at += p.length
    }
    out.set(tail, at)
    return out
  }
}

/**
 * Splits an OSC's content into its number and payload: `<digits> ; <payload>`.
 * Null when there is no number or no semicolon after it.
 */
export function parseOsc(content: Uint8Array, decoder: TextDecoder): { ident: number; payload: string } | null {
  let p = 0
  let ident = 0
  while (p < content.length && content[p] >= ZERO && content[p] <= NINE) {
    ident = ident * 10 + (content[p] - ZERO)
    p++
  }
  if (p === 0 || p >= content.length || content[p] !== SEMICOLON) return null
  return { ident, payload: decoder.decode(content.subarray(p + 1)) }
}
