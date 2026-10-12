/**
 * Where the baseline sits inside a cell, for the grid and for DOM drawn over
 * it.
 *
 * CSS centers the font's ascent + descent (plus declared leading) in a line
 * box; the atlas centers the measured box in the cell and rounds to a whole
 * pixel, so the block cursor isn't off-center. The two agree for some fonts
 * and not others, so DOM text over the grid (the inline suggestion) needs a
 * correction. `cellText.ts` covers the horizontal half.
 */

/**
 * The atlas's baseline: the ascent + descent box centered in the cell,
 * rounded, and kept inside it. Shared by `GlyphAtlas` and the DOM side.
 */
export function cellBaseline(ascent: number, descent: number, cellHeight: number): number {
  return Math.max(
    0,
    Math.min(cellHeight, Math.round((cellHeight - (ascent + descent)) / 2 + ascent)),
  )
}

/** Memoized per font, size, cell height and device scale. */
const shifts = new Map<string, number>()

/**
 * How far to move DOM text down so its baseline lands on the grid's.
 *
 * Computed in device pixels, where the atlas rounds (it rasterizes at
 * `fontSize * dpr`); rounding at CSS scale differs on any non-1:1 display.
 * Zero when it can't be measured (no canvas, no layout, no metrics), since a
 * wrong correction is worse than none.
 */
export function domBaselineShift(
  fontFamily: string,
  fontSize: number,
  cellHeight: number,
  dpr: number = (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
): number {
  const key = [fontFamily, fontSize, cellHeight, dpr].join(' | ')
  const cached = shifts.get(key)
  if (cached !== undefined) return cached

  let shift = 0
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx) {
      const deviceSize = fontSize * dpr
      // The renderer derives the CSS cell height from the rounded device one, so
      // this is normally exact; rounded anyway.
      const deviceCell = Math.max(1, Math.round(cellHeight * dpr))
      ctx.font = `${deviceSize}px ${fontFamily}`
      // 'Mg', as the atlas measures: a cap and a descender.
      const m = ctx.measureText('Mg')
      const ascent = m.fontBoundingBoxAscent ?? deviceSize * 0.8
      const descent = m.fontBoundingBoxDescent ?? deviceSize * 0.2
      const grid = cellBaseline(ascent, descent, deviceCell) / dpr
      const css = measureCssBaseline(fontFamily, fontSize, cellHeight)
      if (css !== null) shift = grid - css
    }
  } catch {
    // Layout or canvas unavailable: no correction.
  }
  shifts.set(key, shift)
  return shift
}

/**
 * Where CSS puts the baseline in a line box of `cellHeight`, or null.
 * Measured, since half-leading depends on which metrics (hhea or OS/2, plus
 * line gap) the browser picks: a zero-sized inline-block's top edge sits on
 * the baseline.
 */
function measureCssBaseline(
  fontFamily: string,
  fontSize: number,
  cellHeight: number,
): number | null {
  if (typeof document === 'undefined' || !document.body) return null
  const box = document.createElement('div')
  box.style.cssText =
    `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;` +
    `font-size:${fontSize}px;line-height:${cellHeight}px`
  box.style.fontFamily = fontFamily
  const strut = document.createElement('span')
  strut.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden'
  box.append(document.createTextNode('Mg'), strut)
  document.body.append(box)
  try {
    const top = box.getBoundingClientRect().top
    const baseline = strut.getBoundingClientRect().top - top
    // Without layout (jsdom) every rect is zero, which is no answer.
    return baseline > 0 ? baseline : null
  } finally {
    box.remove()
  }
}
