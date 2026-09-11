/**
 * Showing a history repeat by blinking the text itself.
 *
 * The first attempt at this drew a translucent band over the input and a solid
 * bar under it. Against the running app it was both too faint to notice and,
 * once made stronger, an obvious piece of chrome sitting on top of the
 * terminal — feedback that announces itself as a separate object rather than
 * as something the text did.
 *
 * Blinking the recalled command reads better for a reason worth writing down:
 * the thing the user is looking at *is* the command, and the question in their
 * head is about that command specifically. Making it move answers exactly
 * there, introduces no colour the theme did not already have, and needs no
 * decision about what a highlight should look like against twenty different
 * themes and an arbitrary program's own output.
 *
 * The mechanism is not an overlay. `WebGLRenderer.hiddenSpans` paints the
 * covered cells' glyphs in their own background colour, so the text vanishes
 * and reappears with nothing drawn over it — see the note there for why a DOM
 * band in the background colour is wrong on a translucent pane.
 *
 * ## One flash per press, and never more
 *
 * The cadence is exactly one hide-and-restore per keypress — never a self-
 * running blink — and that is a safety constraint before it is a taste one.
 * Repeated flashing above about three per second is a seizure risk, and this
 * fires at a rate the *user* sets: someone holding Up is already generating
 * events thirty times a second. Tying it to the keypress means the flash rate
 * can equal the keypress rate but can never exceed it, and it stops the
 * instant the key does. Nothing here starts an oscillation of its own.
 *
 * The area involved is one line of text rather than a region of the screen,
 * which is the other half of why this is a reasonable thing to do at all.
 *
 * One flash is also enough. A single interruption of text you are staring at
 * is very visible; the earlier versions failed by being subtle, not brief.
 */

import type { Cell } from './promptInput'

/**
 * How long the text stays hidden.
 *
 * The floor is not a matter of taste: the renderer paints on
 * `requestAnimationFrame`, so a hide shorter than one display frame can be set
 * and cleared without a frame ever being painted in between, and nothing
 * appears at all. One frame is 16.7ms at 60Hz and 6.9ms at 144Hz, so two
 * frames at the slowest common refresh — about 33ms — is the shortest value
 * that is reliably *seen* rather than merely scheduled.
 *
 * This sits a little above that. Faster stops reading as a deliberate blink
 * and starts reading as a dropped frame, which is the wrong thing to make
 * someone wonder about.
 */
export const HIDE_MS = 55

/**
 * How long the text comes back for between two flashes in a row.
 *
 * Exists because of what a held-down Up key does. Presses arrive every ~30ms
 * once Windows' auto-repeat takes over, and the first version simply restarted
 * the hide timer — so the text went dark on the first press and stayed dark
 * until the hand stopped, which reads as the line having been *deleted*, not
 * as it flickering. Restoring for at least one painted frame in between is
 * what turns a burst back into a countable series of blinks.
 *
 * A frame and a half at 60Hz, so the restore cannot fall between two paints.
 */
export const GAP_MS = 24

/** A span of cells in absolute buffer coordinates, as the renderer wants it. */
export interface HiddenSpan {
  row: number
  from: number
  to: number
}

/**
 * The cells a repeat covers: everything from just past the prompt to the
 * cursor, across however many rows the command wrapped onto.
 *
 * Returns nothing for an empty line, and that is not an oversight: at the
 * bottom of the history readline leaves the line blank, and blank text cannot
 * blink. The old overlay drew a fixed-width band there; this deliberately does
 * not, because a band appearing where there is no text is exactly the piece of
 * chrome this design set out to remove. An empty line that stays empty is its
 * own evidence — there is visibly nothing there.
 */
export function spansFor(origin: Cell, cursor: Cell): HiddenSpan[] {
  if (cursor.row < origin.row) return []
  const spans: HiddenSpan[] = []
  for (let row = origin.row; row <= cursor.row; row++) {
    const from = row === origin.row ? origin.col : 0
    // Every row but the last is a wrapped continuation, and full by
    // definition — that is what made it wrap. `to` is exclusive.
    const to = row === cursor.row ? cursor.col : Number.MAX_SAFE_INTEGER
    if (to <= from) continue
    spans.push({ row, from, to })
  }
  return spans
}

/**
 * Drives one pane's flicker.
 *
 * Deliberately holds no React state. The spans go straight to the renderer and
 * come back off it on a timer, so a flicker costs one field write and one
 * repaint rather than a re-render of the pane's whole component tree — which
 * matters when the events arrive as fast as someone can hold down Up.
 */
export class HistoryFlicker {
  private readonly apply: (spans: HiddenSpan[] | null) => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private hidden = false

  constructor(apply: (spans: HiddenSpan[] | null) => void) {
    this.apply = apply
  }

  /**
   * Blink these cells once.
   *
   * Called again while the text is still dark from the press before it, the
   * text is restored for a frame first and then hidden again, so each press
   * gets its own visible blink. See `GAP_MS` — without that, holding the key
   * down produced one long blank instead of a flicker.
   */
  flash(spans: HiddenSpan[]): void {
    if (spans.length === 0) return
    this.clear()
    if (!this.hidden) {
      this.hide(spans)
      return
    }
    this.show()
    this.timer = setTimeout(() => this.hide(spans), GAP_MS)
  }

  /** Put the text back and hold no timer — a disposed pane, or a line that
   * has ended. Safe to call when nothing is hidden. */
  stop(): void {
    this.clear()
    this.show()
  }

  private hide(spans: HiddenSpan[]): void {
    this.hidden = true
    this.apply(spans)
    this.timer = setTimeout(() => this.show(), HIDE_MS)
  }

  private show(): void {
    this.hidden = false
    this.timer = null
    this.apply(null)
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
