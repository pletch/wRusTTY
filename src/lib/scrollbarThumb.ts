/** The line a scrollbar thumb dragged to `thumbTop` asks to show. */
export function lineForThumb(thumbTop: number, maxThumbTop: number, maxScroll: number): number {
  if (maxThumbTop <= 0) return 0
  const clamped = Math.min(Math.max(0, thumbTop), maxThumbTop)
  return Math.round((clamped / maxThumbTop) * maxScroll)
}
