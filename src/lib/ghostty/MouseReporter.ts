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
 * Telling the far-end program about the mouse. The wire format is the
 * engine's (`MouseEncoder.ts`); this keeps the policy no encoder can know:
 * which button is down, and how often to report.
 *
 * The DOM listeners stay on the engine, where each chooses between reporting
 * (here) and selecting (`SelectionController`).
 */

/** Where the pointer is, in both units the reporter needs at once. */
export interface MousePoint {
  /** Surface pixels, clamped into the surface (see `MouseEncoder`). */
  x: number
  y: number
  /** The cell those pixels fall in, for the motion rate check. */
  col: number
  row: number
}

/** What the reporter needs from the engine. */
export interface MouseHost {
  /** Whether the far end wants mouse reports at all. */
  tracking(): boolean
  /** Pointer position, or null when there is nothing rendered to measure. */
  at(e: MouseEvent): MousePoint | null
  /** The encoder, or null before the core is up. */
  encoder(): MouseEncoder | null
  /**
   * Whether the far end asked for pixel coordinates (DEC 1016), which makes
   * motion within one cell worth sending.
   */
  pixelReporting(): boolean
  /** Sends an encoded report as if typed. */
  send(bytes: Uint8Array): void
}

/** `GhosttyMods` for a mouse event, the same bits the key encoder sends. */
function modsOf(e: MouseEvent): number {
  let mods = 0
  if (e.shiftKey) mods |= 1
  if (e.ctrlKey) mods |= 2
  if (e.altKey) mods |= 4
  if (e.metaKey) mods |= 8
  return mods
}

export class MouseReporter {
  /** The DOM button held, for drag reports. Cleared on blur, since a release
   *  outside the window never arrives. */
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

  /**
   * A release that never arrived. Called on blur, or the next hover would
   * report drags.
   */
  forgetButton(): void {
    this.buttonDown = null
  }

  /**
   * Drops the remembered cell when the geometry changes (resize, font), so the
   * first move into a new cell isn't suppressed as a duplicate.
   */
  forgetLastCell(): void {
    this.lastCol = -1
    this.lastRow = -1
  }

  /**
   * The wheel, reported as button presses. Horizontal too: trackpads send it
   * constantly.
   */
  reportWheel(e: WheelEvent, up: boolean): void {
    this.emit(e, MOUSE_ACTION_PRESS, up ? MOUSE_BUTTON_WHEEL_UP : MOUSE_BUTTON_WHEEL_DOWN)
  }

  reportWheelHorizontal(e: WheelEvent, left: boolean): void {
    this.emit(e, MOUSE_ACTION_PRESS, left ? MOUSE_BUTTON_WHEEL_LEFT : MOUSE_BUTTON_WHEEL_RIGHT)
  }

  reportPress(e: MouseEvent): void {
    // Recorded whatever the encoder does, so a release can name it.
    this.buttonDown = e.button
    this.emit(e, MOUSE_ACTION_PRESS, mouseButtonFor(e.button))
  }

  /**
   * Motion, at most once per cell. Whether motion is reported at all (1002
   * while held, 1003 always) is the encoder's call; this sets the rate, since
   * the encoder's `TRACK_LAST_CELL` doesn't deduplicate in this build. Under DEC
   * 1016 every pixel move is a distinct report, so the cell check is skipped.
   */
  reportMotion(e: MouseEvent): void {
    const p = this.host.at(e)
    if (!p) return
    // Cell first: `pixelReporting` calls into the core, and only a move within
    // the same cell needs the answer.
    if (p.col === this.lastCol && p.row === this.lastRow && !this.host.pixelReporting()) return
    this.lastCol = p.col
    this.lastRow = p.row
    const button = this.buttonDown === null ? null : mouseButtonFor(this.buttonDown)
    this.emitAt(p, e, MOUSE_ACTION_MOTION, button)
  }

  /** Reports the release of the held button, if any (X10 reports none). */
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
      // A release counts as a pressed button, which tells a 1002 drag from a
      // hover.
      anyButtonPressed: this.buttonDown !== null || action === MOUSE_ACTION_RELEASE,
    })
    if (bytes) this.host.send(bytes)
  }
}
