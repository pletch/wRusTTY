import { MODE_MOUSE_ANY_EVENT, MODE_MOUSE_BUTTON_EVENT, MODE_MOUSE_SGR } from './wasmBindings'

/**
 * Telling the program on the far end about the mouse, extracted from
 * `GhosttyEngine`.
 *
 * Three fields (`mouseButtonDown`, `lastMouseCol`, `lastMouseRow`) and the
 * report encoding, which had no business sitting next to WASM lifecycle and
 * WebGL context loss in the same object.
 *
 * The DOM listeners stay on the engine — they're part of what `mount` sets up,
 * and each one has to choose between reporting and selecting before it can do
 * either. This owns the reporting half of that choice; `SelectionController`
 * owns the other.
 */

/** What the reporter needs from the engine: two mode reads, the cell under
 *  the pointer, and somewhere to put the bytes. */
export interface MouseHost {
  /** Is the program on the far end asking to be told about the mouse at all? */
  tracking(): boolean
  /** A DEC private mode, by number. */
  mode(mode: number): boolean
  /** Cell under the pointer, 1-based, as mouse reports are numbered. */
  coords(e: MouseEvent): { col: number; row: number }
  /** Send an escape sequence as if it had been typed. */
  send(seq: string): void
}

export class MouseReporter {
  /** Which button is currently held, for the drag reports that have to name
   *  it. `null` means none — and it is cleared on blur, because a release
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

  /** Wheel, as buttons 64/65. */
  reportWheel(e: WheelEvent & MouseEvent, up: boolean): void {
    const p = this.host.coords(e)
    this.send(up ? 64 : 65, p.col, p.row, e, false)
  }

  reportPress(e: MouseEvent): void {
    const p = this.host.coords(e)
    this.buttonDown = e.button
    this.send(e.button, p.col, p.row, e, false)
  }

  /**
   * Motion, if the program asked for this kind of it.
   *
   * 1002 reports motion only while a button is held; 1003 reports all of it.
   * Reporting unconditionally would flood the PTY from idle mousing.
   */
  reportMotion(e: MouseEvent): void {
    const dragging = this.buttonDown !== null
    const wanted = dragging
      ? this.host.mode(MODE_MOUSE_BUTTON_EVENT) || this.host.mode(MODE_MOUSE_ANY_EVENT)
      : this.host.mode(MODE_MOUSE_ANY_EVENT)
    if (!wanted) return
    const p = this.host.coords(e)
    // Only cell-to-cell moves are worth a report; pixel-level motion inside
    // one cell would send a burst of identical sequences.
    if (p.col === this.lastCol && p.row === this.lastRow) return
    this.lastCol = p.col
    this.lastRow = p.row
    // +32 marks the report as motion rather than a fresh press.
    this.send((this.buttonDown ?? 3) + 32, p.col, p.row, e, false)
  }

  /** Reports the release of whichever button was held, if one was and the
   *  program is listening. No-op otherwise. */
  reportRelease(e: MouseEvent): void {
    if (this.buttonDown === null) return
    const button = this.buttonDown
    this.buttonDown = null
    if (!this.host.tracking()) return
    const p = this.host.coords(e)
    this.send(button, p.col, p.row, e, true)
  }

  /**
   * Encodes one mouse report and sends it as input. SGR (1006) is preferred
   * whenever the program enabled it, because the original encoding packs each
   * coordinate into a single byte biased by 32 and so cannot describe a column
   * past 223 — which any full-width pane on a modern display now exceeds.
   */
  private send(button: number, col: number, row: number, e: MouseEvent, release: boolean): void {
    let b = button
    if (e.shiftKey) b += 4
    if (e.altKey) b += 8
    if (e.ctrlKey) b += 16

    let seq: string
    if (this.host.mode(MODE_MOUSE_SGR)) {
      seq = `\x1b[<${b};${col};${row}${release ? 'm' : 'M'}`
    } else {
      if (col > 223 || row > 223) return
      // The legacy form has no way to say *which* button came up, so a release
      // is always reported as button 3.
      const legacy = release ? 3 + (b & ~3) : b
      seq = `\x1b[M${String.fromCharCode(32 + legacy)}${String.fromCharCode(32 + col)}${String.fromCharCode(32 + row)}`
    }
    this.host.send(seq)
  }
}
