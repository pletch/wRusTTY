/**
 * Mouse reporting, encoded by the engine rather than by us.
 *
 * ## Why this exists
 *
 * `MouseReporter` used to carry the wire format itself: a button number with
 * modifier bits added on, a branch for SGR, and the one-byte X10 form built
 * from `String.fromCharCode(32 + n)`. It handled two of the five formats and
 * three of the five tracking modes, and the gaps were the usual ones — X10
 * (mode 9) is press-only and we reported drags and releases into it, urxvt
 * (1015) and UTF-8 (1005) were not implemented at all, and SGR-pixels (1016)
 * could not be, because the reporter only ever knew which *cell* the pointer
 * was in.
 *
 * Ghostty implements all five of each, and `setopt_from_terminal` reads the
 * modes the far end actually set, so this is a wrapper rather than a port —
 * the same trade `KeyEncoder.ts` makes, for the same reasons.
 *
 * ## Positions are pixels
 *
 * The single biggest difference from what this replaced. The encoder takes a
 * position in surface pixels and does the cell arithmetic itself from the
 * geometry handed to `setSurface`, which is what makes SGR-pixels possible at
 * all and what makes padding a number rather than an assumption. A caller
 * that already rounded to a cell has thrown away the information the pixel
 * formats need.
 *
 * ## What is still ours
 *
 * - **Which button is held.** The encoder needs it to describe a drag, and
 *   the DOM only says on the events that carry it.
 * - **Motion rate.** `TRACK_LAST_CELL` looks like it would do this, and in
 *   this build it does nothing observable — the same cell encodes to the same
 *   report with the option on or off. So the caller still keeps its own
 *   last-cell check; see the note in `MouseReporter`.
 * - **Clamping.** A position outside the surface encodes to nothing. That is
 *   reasonable for a stray event and wrong for a drag that has left the pane,
 *   which every terminal reports against the edge cell, so the caller clamps.
 */

import * as abi from './main/abi'
import {
  MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED,
  MOUSE_ENCODER_OPT_SIZE,
  MOUSE_POSITION_BYTES,
  MOUSE_SIZE_BYTES,
  MOUSE_SIZE_OFF_CELL_HEIGHT,
  MOUSE_SIZE_OFF_CELL_WIDTH,
  MOUSE_SIZE_OFF_PADDING_BOTTOM,
  MOUSE_SIZE_OFF_PADDING_LEFT,
  MOUSE_SIZE_OFF_PADDING_RIGHT,
  MOUSE_SIZE_OFF_PADDING_TOP,
  MOUSE_SIZE_OFF_SCREEN_HEIGHT,
  MOUSE_SIZE_OFF_SCREEN_WIDTH,
  MOUSE_SIZE_OFF_SIZE,
} from './main/mouseAbi'
import type { GhosttyWasm } from './wasmBindings'

/** Room for one report. The longest form is SGR with three-digit coordinates. */
const BUF_BYTES = 64

/** The rendered geometry the encoder converts pixels against. */
export interface MouseSurface {
  /** Full surface in pixels, padding included. */
  screenWidth: number
  screenHeight: number
  /** Must be non-zero — the encoder divides by these. */
  cellWidth: number
  cellHeight: number
  paddingTop?: number
  paddingBottom?: number
  paddingLeft?: number
  paddingRight?: number
}

/** One mouse event, as the encoder wants it described. */
export interface MouseEvent2Encode {
  action: number
  /** `GhosttyMouseButton`, or null for motion with nothing held. */
  button: number | null
  /** Surface pixels, already clamped into the surface by the caller. */
  x: number
  y: number
  /** `GhosttyMods` — the same bits `KeyEncoder` sends. */
  mods: number
  /** Whether any button is down, which is how a drag is told from a hover. */
  anyButtonPressed: boolean
}

export class MouseEncoder {
  private readonly ex: abi.GhosttyMainExports
  private readonly term: number
  private readonly encoder: number
  private readonly event: number
  private readonly buf: number
  private readonly lenSlot: number
  private readonly sizeBuf: number
  private readonly posBuf: number
  private readonly flagBuf: number
  private view: DataView

  private constructor(ex: abi.GhosttyMainExports, term: number) {
    this.ex = ex
    this.term = term

    const slot = ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(ex.ghostty_mouse_encoder_new(0, slot), 'mouse_encoder_new')
    this.view = new DataView(ex.memory.buffer)
    this.encoder = this.view.getUint32(slot, true)

    abi.expectOk(ex.ghostty_mouse_event_new(0, slot), 'mouse_event_new')
    this.view = new DataView(ex.memory.buffer)
    this.event = this.view.getUint32(slot, true)
    ex.ghostty_wasm_free_opaque(slot)

    this.buf = ex.ghostty_wasm_alloc_u8_array(BUF_BYTES)
    this.sizeBuf = ex.ghostty_wasm_alloc_u8_array(MOUSE_SIZE_BYTES)
    this.posBuf = ex.ghostty_wasm_alloc_u8_array(MOUSE_POSITION_BYTES)
    this.flagBuf = ex.ghostty_wasm_alloc_u8_array(1)
    this.lenSlot = ex.ghostty_wasm_alloc_usize()
  }

  /**
   * An encoder over a live terminal, or null when the binary has no mouse
   * encoder in it — only the v1.3.1 oracle build, which the app never loads.
   * Same contract as `KeyEncoder.create`, for the same reason.
   */
  static create(wasm: GhosttyWasm, term: number): MouseEncoder | null {
    const ex = wasm.instance.exports as unknown as abi.GhosttyMainExports
    if (typeof ex.ghostty_mouse_encoder_new !== 'function') return null
    return new MouseEncoder(ex, term)
  }

  /** Re-made only when linear memory growth has detached the previous one. */
  private dv(): DataView {
    if (this.view.buffer !== this.ex.memory.buffer) {
      this.view = new DataView(this.ex.memory.buffer)
    }
    return this.view
  }

  /**
   * The rendered geometry. Set at startup and on every resize — a stale cell
   * size reports the wrong cell for every event, silently and everywhere.
   *
   * Kept out of `encode` deliberately: unlike the tracking mode and the
   * format, none of this is terminal state, so `setopt_from_terminal` neither
   * knows it nor disturbs it.
   */
  setSurface(s: MouseSurface): void {
    const { ex } = this
    const d = this.dv()
    const b = this.sizeBuf
    d.setUint32(b + MOUSE_SIZE_OFF_SIZE, MOUSE_SIZE_BYTES, true)
    d.setUint32(b + MOUSE_SIZE_OFF_SCREEN_WIDTH, Math.max(0, Math.round(s.screenWidth)), true)
    d.setUint32(b + MOUSE_SIZE_OFF_SCREEN_HEIGHT, Math.max(0, Math.round(s.screenHeight)), true)
    // Guarded rather than trusted: the encoder divides by these, and a pane
    // measured before its font has loaded can report a zero cell.
    d.setUint32(b + MOUSE_SIZE_OFF_CELL_WIDTH, Math.max(1, Math.round(s.cellWidth)), true)
    d.setUint32(b + MOUSE_SIZE_OFF_CELL_HEIGHT, Math.max(1, Math.round(s.cellHeight)), true)
    d.setUint32(b + MOUSE_SIZE_OFF_PADDING_TOP, Math.max(0, Math.round(s.paddingTop ?? 0)), true)
    d.setUint32(b + MOUSE_SIZE_OFF_PADDING_BOTTOM, Math.max(0, Math.round(s.paddingBottom ?? 0)), true)
    d.setUint32(b + MOUSE_SIZE_OFF_PADDING_RIGHT, Math.max(0, Math.round(s.paddingRight ?? 0)), true)
    d.setUint32(b + MOUSE_SIZE_OFF_PADDING_LEFT, Math.max(0, Math.round(s.paddingLeft ?? 0)), true)
    ex.ghostty_mouse_encoder_setopt(this.encoder, MOUSE_ENCODER_OPT_SIZE, b)
  }

  /**
   * The bytes a mouse event should put on the wire, or null for one that
   * produces none.
   *
   * Null is the ordinary answer for most events: nothing is reported at all
   * unless the far end asked, X10 reports presses only, and motion is
   * reported only under 1002 and 1003. That decision lives in the encoder
   * precisely so no caller has to hold a copy of it.
   */
  encode(e: MouseEvent2Encode): Uint8Array | null {
    const { ex } = this

    // The application's modes as of *this* event. Re-read every time because
    // a program can turn reporting on or change format between any two.
    ex.ghostty_mouse_encoder_setopt_from_terminal(this.encoder, this.term)

    // After `setopt_from_terminal`, which does not touch this one.
    this.dv().setUint8(this.flagBuf, e.anyButtonPressed ? 1 : 0)
    ex.ghostty_mouse_encoder_setopt(
      this.encoder,
      MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED,
      this.flagBuf,
    )

    ex.ghostty_mouse_event_set_action(this.event, e.action)
    if (e.button === null) ex.ghostty_mouse_event_clear_button(this.event)
    else ex.ghostty_mouse_event_set_button(this.event, e.button)
    ex.ghostty_mouse_event_set_mods(this.event, e.mods)

    const d = this.dv()
    d.setFloat32(this.posBuf, e.x, true)
    d.setFloat32(this.posBuf + 4, e.y, true)
    ex.ghostty_mouse_event_set_position(this.event, this.posBuf)

    return this.run()
  }

  /** `encode`, then the buffer dance the C API asks for. */
  private run(): Uint8Array | null {
    const { ex } = this
    let result = ex.ghostty_mouse_encoder_encode(
      this.encoder,
      this.event,
      this.buf,
      BUF_BYTES,
      this.lenSlot,
    )
    let len = this.dv().getUint32(this.lenSlot, true)

    if (result === abi.GHOSTTY_OUT_OF_SPACE) {
      // `len` is the size required. Not kept, for the reason `KeyEncoder`
      // gives: no observed report needs it, so paying an allocation on the
      // event that does beats holding the memory for the pane's life.
      const big = ex.ghostty_wasm_alloc_u8_array(len)
      try {
        result = ex.ghostty_mouse_encoder_encode(this.encoder, this.event, big, len, this.lenSlot)
        len = this.dv().getUint32(this.lenSlot, true)
        if (result !== abi.GHOSTTY_SUCCESS || len === 0) return null
        return new Uint8Array(ex.memory.buffer, big, len).slice()
      } finally {
        ex.ghostty_wasm_free_u8_array(big, len)
      }
    }

    if (result !== abi.GHOSTTY_SUCCESS || len === 0) return null
    // Copied out: the next event writes over this buffer, and linear memory
    // can move under a view that outlives the call.
    return new Uint8Array(ex.memory.buffer, this.buf, len).slice()
  }

  /** Drops the encoder's own motion state. */
  reset(): void {
    this.ex.ghostty_mouse_encoder_reset(this.encoder)
  }

  dispose(): void {
    const { ex } = this
    ex.ghostty_mouse_encoder_free(this.encoder)
    ex.ghostty_mouse_event_free(this.event)
    ex.ghostty_wasm_free_u8_array(this.buf, BUF_BYTES)
    ex.ghostty_wasm_free_u8_array(this.sizeBuf, MOUSE_SIZE_BYTES)
    ex.ghostty_wasm_free_u8_array(this.posBuf, MOUSE_POSITION_BYTES)
    ex.ghostty_wasm_free_u8_array(this.flagBuf, 1)
    ex.ghostty_wasm_free_usize(this.lenSlot)
  }
}
