/**
 * Showing a history repeat by blinking the recalled text itself, which
 * answers the user where they're looking and needs no new color per theme.
 * `WebGLRenderer.hiddenSpans` paints the covered glyphs in their background
 * color; no overlay is drawn.
 *
 * ## One flash per press, never more
 *
 * Exactly one hide-and-restore per keypress, never a self-running blink.
 * That's a safety constraint: flashing above about three per second is a
 * seizure risk, and holding Up generates ~30 events a second. Tied to the
 * keypress, the flash rate can't exceed it and stops when the key does. The
 * area is one line of text, not a screen region.
 */

import type { Cell } from './promptInput'

/**
 * How long the text stays hidden. The renderer paints on
 * `requestAnimationFrame`, so anything under two frames at 60Hz (~33ms) may
 * never be painted; this sits a little above, short of looking like a
 * dropped frame.
 */
export const HIDE_MS = 55

/**
 * How long the text comes back between two flashes in a row: a frame and a
 * half at 60Hz, so a held key's auto-repeat (~30ms) reads as a series of
 * blinks rather than one long blank.
 */
export const GAP_MS = 24

/** A span of cells in absolute buffer coordinates, as the renderer wants it. */
export interface HiddenSpan {
  row: number
  from: number
  to: number
}

/**
 * The cells a repeat covers: from just past the prompt to the cursor, across
 * any wrapped rows. Nothing for an empty line (the bottom of history), which
 * is visibly empty already.
 */
export function spansFor(origin: Cell, cursor: Cell): HiddenSpan[] {
  if (cursor.row < origin.row) return []
  const spans: HiddenSpan[] = []
  for (let row = origin.row; row <= cursor.row; row++) {
    const from = row === origin.row ? origin.col : 0
    // Rows before the last are wrapped and so full. `to` is exclusive.
    const to = row === cursor.row ? cursor.col : Number.MAX_SAFE_INTEGER
    if (to <= from) continue
    spans.push({ row, from, to })
  }
  return spans
}

/**
 * Drives one pane's flicker. Holds no React state: spans go straight to the
 * renderer, costing one field write and a repaint per press.
 */
export class HistoryFlicker {
  private readonly apply: (spans: HiddenSpan[] | null) => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private hidden = false

  constructor(apply: (spans: HiddenSpan[] | null) => void) {
    this.apply = apply
  }

  /**
   * Blinks these cells once. If the text is still dark from the last press, it's
   * restored for `GAP_MS` first, so each press gets its own blink.
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

  /** Restores the text and drops the timer. Safe when nothing is hidden. */
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
