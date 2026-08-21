/**
 * Where the baseline sits inside a cell — the one place that is decided, for
 * the grid and for anything drawn as DOM over it.
 *
 * The grid does not put text where CSS would. A line box centres the font's
 * own ascent + descent (plus whatever leading the face declares) in the line
 * height; the atlas instead centres the *measured* ascent + descent box in the
 * cell and rounds to a whole pixel, because the block cursor is drawn as the
 * whole cell and any bias reads as the cursor sitting off-centre against the
 * character it covers.
 *
 * Those two answers agree for some fonts and not others, which is exactly how
 * this surfaced: the inline suggestion — the only text drawn as DOM over the
 * grid — sat a pixel high against the real text beside it in Monaspace Neon
 * and JetBrains Mono, and flush in Fira Code and Consolas. Measured at 14px in
 * a 17px cell:
 *
 * | face           | atlas | CSS | shift |
 * |----------------|-------|-----|-------|
 * | Monaspace Neon |    14 |  13 |    +1 |
 * | JetBrains Mono |    14 |  13 |    +1 |
 * | Fira Code      |    13 |  13 |     0 |
 * | Consolas       |    13 |  13 |     0 |
 *
 * (At 1:1. On a scaled display the same correction is a fraction of a CSS
 * pixel, being a whole *device* pixel — see `domBaselineShift`.)
 *
 * So it is not a Monaspace problem and never was a bundled-font problem — it
 * is two formulas, and until three fonts with different vertical metrics
 * shipped in the app, whether they agreed was luck. `cellText.ts` documents
 * the horizontal half of the same story: DOM drawn over a grid has to be told
 * where the grid is, in both axes.
 */

/**
 * The atlas's baseline: the ascent + descent box centred in the cell, rounded,
 * and never outside it.
 *
 * Exported so `GlyphAtlas` and the DOM side compute the same number from the
 * same expression rather than from two copies of it that agree today.
 */
export function cellBaseline(ascent: number, descent: number, cellHeight: number): number {
  return Math.max(
    0,
    Math.min(cellHeight, Math.round((cellHeight - (ascent + descent)) / 2 + ascent)),
  )
}

/** Memoized per font, size, cell height and device scale — this measures
 *  layout, and the answer only changes when one of those does. */
const shifts = new Map<string, number>()

/**
 * How far to move DOM text down so its baseline lands on the grid's.
 *
 * Computed in *device* pixels, because that is where the atlas computes it:
 * the renderer rasterizes at `fontSize * dpr` into device-sized cells so a
 * glyph is drawn at the resolution it is shown at, and the rounding in
 * `cellBaseline` therefore happens at device scale. Rounding the same
 * expression at CSS scale gives a different answer on any display that is not
 * 1:1 — which is most of them.
 *
 * Zero whenever the question cannot be asked — no canvas context, no layout,
 * a font that reports no metrics — because leaving the text where CSS put it
 * is what this did before, and a wrong correction is worse than none.
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
      // The renderer derives its CSS cell height back from the rounded device
      // one, so this multiplication is normally exact; rounded anyway rather
      // than trusting a caller to have come from there.
      const deviceCell = Math.max(1, Math.round(cellHeight * dpr))
      ctx.font = `${deviceSize}px ${fontFamily}`
      // 'Mg' for the reason the atlas measures it: a cap and a descender, so
      // the box is the font's rather than the string's.
      const m = ctx.measureText('Mg')
      const ascent = m.fontBoundingBoxAscent ?? deviceSize * 0.8
      const descent = m.fontBoundingBoxDescent ?? deviceSize * 0.2
      const grid = cellBaseline(ascent, descent, deviceCell) / dpr
      const css = measureCssBaseline(fontFamily, fontSize, cellHeight)
      if (css !== null) shift = grid - css
    }
  } catch {
    // Layout or canvas unavailable. Nothing to correct by, so correct by
    // nothing.
  }
  shifts.set(key, shift)
  return shift
}

/**
 * Where CSS puts the baseline in a line box of `cellHeight`, or null if the
 * environment cannot say.
 *
 * Measured rather than derived: half-leading is computed from the metrics the
 * *browser* chose for the face — hhea or OS/2, plus line gap, and which of
 * those it picks is a platform decision — so the only reliable way to know is
 * to lay a line out and look. A zero-sized inline-block sits on the baseline,
 * so its top edge is the answer.
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
    // jsdom and anything else without layout answers zero for every rect,
    // which is not a baseline of zero — it is no answer.
    return baseline > 0 ? baseline : null
  } finally {
    box.remove()
  }
}
