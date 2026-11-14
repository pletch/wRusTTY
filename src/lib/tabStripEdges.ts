export interface StripEdges {
  /** More tabs off to the left. */
  left: boolean
  /** More tabs off to the right. */
  right: boolean
}

/** Which sides of a scrolling strip have more to show. The slack is for rounding, which
 * can report a pixel of overflow that isn't real. */
export function stripEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): StripEdges {
  return {
    left: scrollLeft > 1,
    right: scrollWidth - clientWidth - scrollLeft > 1,
  }
}

/** A span cut out of the strip, in px from its left; null runs to that edge. */
export type MaskHole = readonly [number | null, number | null]

/** Fades only the sides with more to show, `width` px deep, or null for no fade
 * at all. `hole` is cut out entirely: where the active tab is drawn over the
 * strip, so tabs passing under it vanish rather than show through its
 * translucent fill. A hole open to an edge replaces that side's fade. */
export function stripMask(
  { left, right }: StripEdges,
  width = 24,
  hole: MaskHole | null = null,
): string | null {
  if (!left && !right) return null
  const [from, to] = hole ?? [undefined, undefined]
  const start =
    from === null
      ? `transparent, transparent ${to}px, black ${to}px`
      : left
        ? `transparent, black ${width}px`
        : 'black'
  const cut =
    from !== null && from !== undefined && to !== null && to !== undefined
      ? `, black ${from}px, transparent ${from}px, transparent ${to}px, black ${to}px`
      : ''
  const end =
    to === null
      ? `black ${from}px, transparent ${from}px, transparent`
      : right
        ? `black calc(100% - ${width}px), transparent`
        : 'black'
  return `linear-gradient(to right, ${start}${cut}, ${end})`
}

/** The span to cut for the active tab drawn at `x` (`width` wide) whose own
 * slot is at `slotX`. Pinned at an edge, the cut runs on to that edge, so
 * nothing of the tabs it has passed shows beyond it either. */
export function activeTabHole(slotX: number, x: number, width: number): MaskHole {
  if (slotX < x - 0.5) return [null, x + width]
  if (slotX > x + 0.5) return [x, null]
  return [x, x + width]
}

/** The furthest the desktop strip can scroll: its tabs' extent past the view. */
export function maxOffset(contentWidth: number, viewWidth: number): number {
  return Math.max(0, contentWidth - viewWidth)
}

export function clampOffset(offset: number, max: number): number {
  return Math.min(Math.max(offset, 0), max)
}

/** Where the active tab is drawn, in px from the strip's left: its own slot,
 * held `inset` px in from whichever edge it would otherwise pass. Continuous in
 * `slotX`, so the tab slides into place and never jumps. */
export function pinnedX(slotX: number, tabWidth: number, viewWidth: number, inset: number): number {
  const far = viewWidth - inset - tabWidth
  // A view too narrow to hold the tab inside both insets: keep it at the left.
  if (far < inset) return inset
  return Math.min(Math.max(slotX, inset), far)
}

/** The offset that brings [start, end) (strip content coordinates) into view
 * with `room` px to spare on each side, moving as little as possible. */
export function offsetToReveal(
  start: number,
  end: number,
  offset: number,
  viewWidth: number,
  room: number,
): number {
  if (start - room < offset) return start - room
  if (end + room > offset + viewWidth) return end + room - viewWidth
  return offset
}
