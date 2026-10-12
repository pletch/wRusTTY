/**
 * Mouse reporting, encoded by the engine. Ghostty implements all five formats
 * and tracking modes, and `setopt_from_terminal` reads what the far end set,
 * so this is a wrapper (as `KeyEncoder.ts` is).
 *
 * ## Positions are pixels
 *
 * The encoder takes surface pixels and does the cell arithmetic from the
 * geometry given to `setSurface`, which is what makes SGR-pixels (1016)
 * possible. Don't round to a cell first.
 *
 * ## What's still ours
 *
 * - **Which button is held**, which the DOM only reports on some events.
 * - **Motion rate.** `TRACK_LAST_CELL` does nothing observable in this build,
 *   so the caller keeps its own last-cell check (see `MouseReporter`).
 * - **Clamping.** A position outside the surface encodes to nothing, but a
 *   drag that left the pane should report the edge cell, so the caller clamps.
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
  /** Non-zero: the encoder divides by these. */
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
  /** `GhosttyMods`, the same bits `KeyEncoder` sends. */
  mods: number
  /** Whether any button is down, which tells a drag from a hover. */
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

    this.buf = ex.ghostty_wasm_alloc(BUF_BYTES)
    this.sizeBuf = ex.ghostty_wasm_alloc(MOUSE_SIZE_BYTES)
    this.posBuf = ex.ghostty_wasm_alloc(MOUSE_POSITION_BYTES)
    this.flagBuf = ex.ghostty_wasm_alloc(1)
    this.lenSlot = ex.ghostty_wasm_alloc(abi.USIZE_BYTES)
  }

  /**
   * An encoder over a live terminal, or null for the v1.3.1 oracle build (see
   * `KeyEncoder.create`).
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
   * The rendered geometry. Set at startup and on every resize; a stale cell
   * size misreports every event. Separate from `encode`, since this isn't
   * terminal state.
   */
  setSurface(s: MouseSurface): void {
    const { ex } = this
    const d = this.dv()
    const b = this.sizeBuf
    d.setUint32(b + MOUSE_SIZE_OFF_SIZE, MOUSE_SIZE_BYTES, true)
    d.setUint32(b + MOUSE_SIZE_OFF_SCREEN_WIDTH, Math.max(0, Math.round(s.screenWidth)), true)
    d.setUint32(b + MOUSE_SIZE_OFF_SCREEN_HEIGHT, Math.max(0, Math.round(s.screenHeight)), true)
    // A pane measured before its font loads can report a zero cell.
    d.setUint32(b + MOUSE_SIZE_OFF_CELL_WIDTH, Math.max(1, Math.round(s.cellWidth)), true)
    d.setUint32(b + MOUSE_SIZE_OFF_CELL_HEIGHT, Math.max(1, Math.round(s.cellHeight)), true)
    d.setUint32(b + MOUSE_SIZE_OFF_PADDING_TOP, Math.max(0, Math.round(s.paddingTop ?? 0)), true)
    d.setUint32(b + MOUSE_SIZE_OFF_PADDING_BOTTOM, Math.max(0, Math.round(s.paddingBottom ?? 0)), true)
    d.setUint32(b + MOUSE_SIZE_OFF_PADDING_RIGHT, Math.max(0, Math.round(s.paddingRight ?? 0)), true)
    d.setUint32(b + MOUSE_SIZE_OFF_PADDING_LEFT, Math.max(0, Math.round(s.paddingLeft ?? 0)), true)
    ex.ghostty_mouse_encoder_setopt(this.encoder, MOUSE_ENCODER_OPT_SIZE, b)
  }

  /**
   * The bytes a mouse event should send, or null. Null is usual: nothing is
   * reported unless the far end asked, X10 reports presses only, and motion
   * only under 1002 and 1003. The encoder owns that decision.
   */
  encode(e: MouseEvent2Encode): Uint8Array | null {
    const { ex } = this

    // The application's modes as of this event; they can change between any two.
    ex.ghostty_mouse_encoder_setopt_from_terminal(this.encoder, this.term)

    // After `setopt_from_terminal`, which doesn't touch it.
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
      // `len` is the size required. Not kept (see `KeyEncoder`).
      const big = ex.ghostty_wasm_alloc(len)
      try {
        result = ex.ghostty_mouse_encoder_encode(this.encoder, this.event, big, len, this.lenSlot)
        len = this.dv().getUint32(this.lenSlot, true)
        if (result !== abi.GHOSTTY_SUCCESS || len === 0) return null
        return new Uint8Array(ex.memory.buffer, big, len).slice()
      } finally {
        ex.ghostty_wasm_free(big, len)
      }
    }

    if (result !== abi.GHOSTTY_SUCCESS || len === 0) return null
    // Copied out: the next event reuses the buffer, and memory can move.
    return new Uint8Array(ex.memory.buffer, this.buf, len).slice()
  }

  // No `reset()`: `ghostty_mouse_encoder_reset` clears the `TRACK_LAST_CELL`
  // state, which does nothing in this build. `MouseReporter` has its own
  // `forgetLastCell`.

  dispose(): void {
    const { ex } = this
    ex.ghostty_mouse_encoder_free(this.encoder)
    ex.ghostty_mouse_event_free(this.event)
    ex.ghostty_wasm_free(this.buf, BUF_BYTES)
    ex.ghostty_wasm_free(this.sizeBuf, MOUSE_SIZE_BYTES)
    ex.ghostty_wasm_free(this.posBuf, MOUSE_POSITION_BYTES)
    ex.ghostty_wasm_free(this.flagBuf, 1)
    ex.ghostty_wasm_free(this.lenSlot, abi.USIZE_BYTES)
  }
}
