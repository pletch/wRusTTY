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

/** Fades only the sides with more to show, or null for no fade at all. */
export function stripMask({ left, right }: StripEdges): string | null {
  if (!left && !right) return null
  const start = left ? 'transparent, black 24px' : 'black'
  const end = right ? 'black calc(100% - 24px), transparent' : 'black'
  return `linear-gradient(to right, ${start}, ${end})`
}
