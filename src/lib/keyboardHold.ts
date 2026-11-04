/**
 * Android: keeps a terminal's grid when the keyboard opens, and slides it so the cursor
 * stays in the part still showing.
 *
 * Telling the host that the height changed makes programs redraw. Those that draw inline,
 * like Claude Code, can't reach what has already scrolled off, so each keyboard open or
 * close left overlapping copies of their output. The cost is that a full-screen program's
 * bottom rows can sit behind the keyboard, unless the cursor is there.
 */

/** A window this much shorter than it has been at this width has a keyboard open. */
const KEYBOARD_MIN_PX = 120

/** By width, so a rotation doesn't read as a keyboard. */
const tallestAtWidth = new Map<number, number>()

export function keyboardOpen(width: number, height: number): boolean {
  const tallest = Math.max(tallestAtWidth.get(width) ?? 0, height)
  tallestAtWidth.set(width, tallest)
  return tallest - height >= KEYBOARD_MIN_PX
}

/** Test seam: the heights are module state. */
export function resetKeyboardHold(): void {
  tallestAtWidth.clear()
}

/** How far up to slide a grid of `gridPx`, with `visiblePx` of it showing, so `cursorRow`
 * and the row after it can be seen. */
export function heldOffset(
  cursorRow: number,
  cellPx: number,
  gridPx: number,
  visiblePx: number,
): number {
  const needed = (cursorRow + 2) * cellPx - visiblePx
  return Math.max(0, Math.min(needed, gridPx - visiblePx))
}
