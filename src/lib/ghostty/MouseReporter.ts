import type { MouseEncoder } from './MouseEncoder'
import {
  MOUSE_ACTION_MOTION,
  MOUSE_ACTION_PRESS,
  MOUSE_ACTION_RELEASE,
  MOUSE_BUTTON_WHEEL_DOWN,
  MOUSE_BUTTON_WHEEL_LEFT,
  MOUSE_BUTTON_WHEEL_RIGHT,
  MOUSE_BUTTON_WHEEL_UP,
  mouseButtonFor,
} from './main/mouseAbi'

/**
 * Telling the program on the far end about the mouse.
 *
 * The wire format used to live here — a button number with modifier bits
 * added on, a branch for SGR, and the one-byte X10 form. It is the engine's
 * now (`MouseEncoder.ts`), which is what brought X10's press-only rule, the
 * urxvt and UTF-8 formats, and SGR-pixels with it. What is left is the policy
 * that no encoder can know: which button is down, and how often to speak.
 *
 * The DOM listeners stay on the engine — they're part of what `mount` sets up,
 * and each one has to choose between reporting and selecting before it can do
 * either. This owns the reporting half of that choice; `SelectionController`
 * owns the other.
 */

/** Where the pointer is, in both units the reporter needs at once. */
export interface MousePoint {
  /** Surface pixels, clamped into the surface — see `MouseEncoder`. */
  x: number
  y: number
  /** The cell those pixels fall in, for the motion rate check below. */
  col: number
  row: number
}

/** What the reporter needs from the engine. */
export interface MouseHost {
  /** Is the program on the far end asking to be told about the mouse at all? */
  tracking(): boolean
  /** Pointer position, or null when there is nothing rendered to measure. */
  at(e: MouseEvent): MousePoint | null
  /** The encoder, or null before the core is up. */
  encoder(): MouseEncoder | null
  /**
   * Whether the far end asked for pixel coordinates (DEC 1016). It is the one
   * mode the reporter still has to know about, because it is what makes
   * motion inside a single cell worth sending.
   */
  pixelReporting(): boolean
  /** Send an encoded report as if it had been typed. */
  send(bytes: Uint8Array): void
}

/** `GhosttyMods` for a mouse event — the same bits the key encoder sends. */
function modsOf(e: MouseEvent): number {
  let mods = 0
  if (e.shiftKey) mods |= 1
  if (e.ctrlKey) mods |= 2
  if (e.altKey) mods |= 4
  if (e.metaKey) mods |= 8
  return mods
}

export class MouseReporter {
  /** Which DOM button is currently held, for the drag reports that have to
   *  name it. `null` means none — and it is cleared on blur, because a release
   *  outside the window never reaches us. */
  private buttonDown: number | null = null
  private lastCol = -1
  private lastRow = -1

  private readonly host: MouseHost

  constructor(host: MouseHost) {
    this.host = host
  }

  tracking(): boolean {
    return this.host.tracking()
  }

  isButtonDown(): boolean {
    return this.buttonDown !== null
  }

  /**
   * A release that never arrived. Called on blur: left set, a stuck "still
   * held" keeps reporting drags on the next hover.
   */
  forgetButton(): void {
    this.buttonDown = null
  }

  /**
   * The wheel, which the protocols report as a button press rather than as an
   * axis. Horizontal is included because a trackpad sends it constantly and a
   * program that asked for mouse reporting is entitled to hear it.
   */
  reportWheel(e: WheelEvent, up: boolean): void {
    this.emit(e, MOUSE_ACTION_PRESS, up ? MOUSE_BUTTON_WHEEL_UP : MOUSE_BUTTON_WHEEL_DOWN)
  }

  reportWheelHorizontal(e: WheelEvent, left: boolean): void {
    this.emit(e, MOUSE_ACTION_PRESS, left ? MOUSE_BUTTON_WHEEL_LEFT : MOUSE_BUTTON_WHEEL_RIGHT)
  }

  reportPress(e: MouseEvent): void {
    // Recorded whatever the encoder decides to do with it: the button is held
    // from now on either way, and a release still has to be able to name it.
    this.buttonDown = e.button
    this.emit(e, MOUSE_ACTION_PRESS, mouseButtonFor(e.button))
  }

  /**
   * Motion, at most once per cell.
   *
   * Whether motion is reported at all is the encoder's call — 1002 wants it
   * only while a button is held, 1003 always, and the rest not at all — so
   * there is deliberately no mode check here. What is here is the rate: pixel
   * motion inside one cell would send a burst of identical reports, and the
   * encoder's own `TRACK_LAST_CELL` option does not suppress them in this
   * build (the same cell encodes to the same bytes with it on or off).
   *
   * Under DEC 1016 the report carries pixels, so every move is a different
   * report and the cell check would throw away exactly what was asked for.
   */
  reportMotion(e: MouseEvent): void {
    const p = this.host.at(e)
    if (!p) return
    if (!this.host.pixelReporting()) {
      if (p.col === this.lastCol && p.row === this.lastRow) return
    }
    this.lastCol = p.col
    this.lastRow = p.row
    const button = this.buttonDown === null ? null : mouseButtonFor(this.buttonDown)
    this.emitAt(p, e, MOUSE_ACTION_MOTION, button)
  }

  /** Reports the release of whichever button was held, if one was. Whether it
   *  reaches the wire is the encoder's decision — X10 reports no releases. */
  reportRelease(e: MouseEvent): void {
    if (this.buttonDown === null) return
    const button = this.buttonDown
    this.buttonDown = null
    if (!this.host.tracking()) return
    this.emit(e, MOUSE_ACTION_RELEASE, mouseButtonFor(button))
  }

  private emit(e: MouseEvent, action: number, button: number | null): void {
    const p = this.host.at(e)
    if (!p) return
    this.emitAt(p, e, action, button)
  }

  private emitAt(p: MousePoint, e: MouseEvent, action: number, button: number | null): void {
    const encoder = this.host.encoder()
    if (!encoder) return
    const bytes = encoder.encode({
      action,
      button,
      x: p.x,
      y: p.y,
      mods: modsOf(e),
      // A release still counts as "a button was pressed for this event",
      // which is what tells a 1002 drag report from a bare hover.
      anyButtonPressed: this.buttonDown !== null || action === MOUSE_ACTION_RELEASE,
    })
    if (bytes) this.host.send(bytes)
  }
}
