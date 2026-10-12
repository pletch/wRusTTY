/**
 * Box drawing, block elements and Powerline separators, drawn as geometry
 * against the cell rectangle instead of from the font.
 *
 * A font lays these out against its own em box, not the cell
 * (`round(ceil(fontSize * 1.2) * dpr)` px tall), leaving hairline seams
 * between rows. Drawing to the cell rect makes them tile exactly, and works on
 * hosts where no suitable font can be installed. Synthesized into atlas slots
 * like GLYPH_CURSOR_OUTLINE; nothing about the cache or packing changes.
 */

/** Arm weights. The index into an `Arms` tuple is [up, right, down, left]. */
const N = 0
const L = 1
const H = 2
const D = 3

type Arms = readonly [number, number, number, number]

/**
 * Line-drawing characters described by their four arm weights: all of
 * U+2500-U+257F except the dashes, arcs and diagonals.
 */
const ARMS: Record<number, Arms> = {
  0x2500: [N, L, N, L], 0x2501: [N, H, N, H],
  0x2502: [L, N, L, N], 0x2503: [H, N, H, N],

  0x250c: [N, L, L, N], 0x250d: [N, H, L, N], 0x250e: [N, L, H, N], 0x250f: [N, H, H, N],
  0x2510: [N, N, L, L], 0x2511: [N, N, L, H], 0x2512: [N, N, H, L], 0x2513: [N, N, H, H],
  0x2514: [L, L, N, N], 0x2515: [L, H, N, N], 0x2516: [H, L, N, N], 0x2517: [H, H, N, N],
  0x2518: [L, N, N, L], 0x2519: [L, N, N, H], 0x251a: [H, N, N, L], 0x251b: [H, N, N, H],

  0x251c: [L, L, L, N], 0x251d: [L, H, L, N], 0x251e: [H, L, L, N], 0x251f: [L, L, H, N],
  0x2520: [H, L, H, N], 0x2521: [H, H, L, N], 0x2522: [L, H, H, N], 0x2523: [H, H, H, N],

  0x2524: [L, N, L, L], 0x2525: [L, N, L, H], 0x2526: [H, N, L, L], 0x2527: [L, N, H, L],
  0x2528: [H, N, H, L], 0x2529: [H, N, L, H], 0x252a: [L, N, H, H], 0x252b: [H, N, H, H],

  0x252c: [N, L, L, L], 0x252d: [N, L, L, H], 0x252e: [N, H, L, L], 0x252f: [N, H, L, H],
  0x2530: [N, L, H, L], 0x2531: [N, L, H, H], 0x2532: [N, H, H, L], 0x2533: [N, H, H, H],

  0x2534: [L, L, N, L], 0x2535: [L, L, N, H], 0x2536: [L, H, N, L], 0x2537: [L, H, N, H],
  0x2538: [H, L, N, L], 0x2539: [H, L, N, H], 0x253a: [H, H, N, L], 0x253b: [H, H, N, H],

  0x253c: [L, L, L, L], 0x253d: [L, L, L, H], 0x253e: [L, H, L, L], 0x253f: [L, H, L, H],
  0x2540: [H, L, L, L], 0x2541: [L, L, H, L], 0x2542: [H, L, H, L], 0x2543: [H, L, L, H],
  0x2544: [H, H, L, L], 0x2545: [L, L, H, H], 0x2546: [L, H, H, L], 0x2547: [H, H, L, H],
  0x2548: [L, H, H, H], 0x2549: [H, L, H, H], 0x254a: [H, H, H, L], 0x254b: [H, H, H, H],

  0x2550: [N, D, N, D], 0x2551: [D, N, D, N],
  0x2552: [N, D, L, N], 0x2553: [N, L, D, N], 0x2554: [N, D, D, N],
  0x2555: [N, N, L, D], 0x2556: [N, N, D, L], 0x2557: [N, N, D, D],
  0x2558: [L, D, N, N], 0x2559: [D, L, N, N], 0x255a: [D, D, N, N],
  0x255b: [L, N, N, D], 0x255c: [D, N, N, L], 0x255d: [D, N, N, D],
  0x255e: [L, D, L, N], 0x255f: [D, L, D, N], 0x2560: [D, D, D, N],
  0x2561: [L, N, L, D], 0x2562: [D, N, D, L], 0x2563: [D, N, D, D],
  0x2564: [N, D, L, D], 0x2565: [N, L, D, L], 0x2566: [N, D, D, D],
  0x2567: [L, D, N, D], 0x2568: [D, L, N, L], 0x2569: [D, D, N, D],
  0x256a: [L, D, L, D], 0x256b: [D, L, D, L], 0x256c: [D, D, D, D],

  // The stubs: one arm only, from the center to one edge.
  0x2574: [N, N, N, L], 0x2575: [L, N, N, N], 0x2576: [N, L, N, N], 0x2577: [N, N, L, N],
  0x2578: [N, N, N, H], 0x2579: [H, N, N, N], 0x257a: [N, H, N, N], 0x257b: [N, N, H, N],
  // The transitions: a line that changes weight at the center of the cell.
  0x257c: [N, H, N, L], 0x257d: [L, N, H, N], 0x257e: [N, L, N, H], 0x257f: [H, N, L, N],
}

/** `[dashes, weight, vertical]` — U+2504-U+250B and U+254C-U+254F. */
const DASHED: Record<number, readonly [number, number, boolean]> = {
  0x2504: [3, L, false], 0x2505: [3, H, false],
  0x2506: [3, L, true], 0x2507: [3, H, true],
  0x2508: [4, L, false], 0x2509: [4, H, false],
  0x250a: [4, L, true], 0x250b: [4, H, true],
  0x254c: [2, L, false], 0x254d: [2, H, false],
  0x254e: [2, L, true], 0x254f: [2, H, true],
}

/** The rounded corners, as the two directions the curve joins. */
const ARCS: Record<number, readonly [boolean, boolean]> = {
  0x256d: [true, true], // down and right
  0x256e: [true, false], // down and left
  0x256f: [false, false], // up and left
  0x2570: [false, true], // up and right
}

/**
 * The sextants, U+1FB00-U+1FB3B: a 2x3 mosaic. Derived rather than
 * transcribed: masks in binary order (position 1 the low bit), skipping the
 * four combinations Unicode already had (empty, full, left and right column),
 * which is exactly 60 codepoints.
 */
const SEXTANTS = new Map<number, number>()
{
  const LEFT_COLUMN = 0b010101
  const RIGHT_COLUMN = 0b101010
  let cp = 0x1fb00
  for (let mask = 1; mask < 0b111111; mask++) {
    if (mask === LEFT_COLUMN || mask === RIGHT_COLUMN) continue
    SEXTANTS.set(cp++, mask)
  }
}

export function isBoxGlyph(cp: number): boolean {
  return (
    (cp >= 0x2500 && cp <= 0x259f) ||
    (cp >= 0xe0b0 && cp <= 0xe0bf) ||
    (cp >= 0x1fb00 && cp <= 0x1fb3b) ||
    (cp >= 0x1fb70 && cp <= 0x1fb8b)
  )
}

// Not claimed from Legacy Computing: smooth mosaics (U+1FB3C-U+1FB6F), shades
// and checkerboards (U+1FB8C-U+1FB9F), diagonals (U+1FBA0-U+1FBAF) and
// segmented digits (U+1FBF0+). They'd be transcribed rather than derived, and
// a wrong shape is worse than the font's.

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Draws one of these characters into `[x, y, w, h]` in the caller's
 * `fillStyle`. `light` is the atlas's rule thickness, matching SGR underlines.
 * Returns false for an unhandled codepoint, so the caller can use the font.
 */
export function drawBoxGlyph(
  ctx: CanvasRenderingContext2D,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
  light: number,
): boolean {
  if (!isBoxGlyph(cp)) return false

  ctx.save()
  // A stroked arc or scaled semicircle can round slightly outside the cell; the
  // neighboring slot isn't ours.
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()

  let handled = true
  if (cp >= 0x2580 && cp <= 0x259f) drawBlock(ctx, cp, x, y, w, h)
  else if (cp >= 0x1fb70) drawEighths(ctx, cp, x, y, w, h)
  else if (cp >= 0x1fb00) drawSextant(ctx, cp, x, y, w, h)
  else if (cp >= 0xe0b0) drawPowerline(ctx, cp, x, y, w, h, light)
  else if (DASHED[cp]) drawDashed(ctx, DASHED[cp], x, y, w, h, light)
  else if (ARCS[cp]) drawArc(ctx, ARCS[cp], x, y, w, h, light)
  else if (cp >= 0x2571 && cp <= 0x2573) drawDiagonal(ctx, cp, x, y, w, h, light)
  else if (ARMS[cp]) drawArms(ctx, ARMS[cp], x, y, w, h, light)
  else handled = false

  ctx.restore()
  return handled
}

/** Thickness of one arm at the given weight. A double rule is two light ones. */
function weightPx(weight: number, light: number): number {
  return weight === H ? Math.max(light + 1, Math.round(light * 2)) : light
}

/**
 * The arm model. Each arm runs from its cell edge to near the center; they
 * overlap there, so junctions come out solid without per-character cases.
 *
 * Double arms are drawn as an outline: the union of three-rule-wide bars,
 * minus the same union inset by one rule. That reproduces every double
 * junction (U+2554 an L, U+256C a plus, U+2560 a T).
 */
function drawArms(
  ctx: CanvasRenderingContext2D,
  arms: Arms,
  x: number,
  y: number,
  w: number,
  h: number,
  light: number,
): void {
  const [up, right, down, left] = arms
  const axX = x + w / 2
  const axY = y + h / 2

  if (up !== D && right !== D && down !== D && left !== D) {
    // Widest perpendicular arm, so a light arm crosses a heavy one fully.
    const vThick = up || down ? Math.max(weightPx(up, light), weightPx(down, light)) : 0
    const hThick = left || right ? Math.max(weightPx(left, light), weightPx(right, light)) : 0

    if (left || right) {
      // With no vertical arm, the band is the arm's own width, centering stubs.
      const m = vThick || hThick
      const a = Math.round(axX - m / 2)
      const b = a + m
      if (right) {
        const t = weightPx(right, light)
        ctx.fillRect(a, Math.round(axY - t / 2), x + w - a, t)
      }
      if (left) {
        const t = weightPx(left, light)
        ctx.fillRect(x, Math.round(axY - t / 2), b - x, t)
      }
    }
    if (up || down) {
      const m = hThick || vThick
      const a = Math.round(axY - m / 2)
      const b = a + m
      if (down) {
        const t = weightPx(down, light)
        ctx.fillRect(Math.round(axX - t / 2), a, t, y + h - a)
      }
      if (up) {
        const t = weightPx(up, light)
        ctx.fillRect(Math.round(axX - t / 2), y, t, b - y)
      }
    }
    return
  }

  // The three-rule band a double occupies, and the one-rule band inside it.
  const outerX0 = Math.round(axX - light * 1.5)
  const outerX1 = outerX0 + light * 3
  const outerY0 = Math.round(axY - light * 1.5)
  const outerY1 = outerY0 + light * 3
  const innerX0 = outerX0 + light
  const innerX1 = outerX1 - light
  const innerY0 = outerY0 + light
  const innerY1 = outerY1 - light

  // A double bar opposite single arms stops at the near face of that rule, so
  // U+2564 keeps the gap above its stem while U+2558 caps its pair.
  const isSingle = (a: number) => a === L || a === H
  const vSingle = isSingle(up) || isSingle(down)
  const hSingle = isSingle(left) || isSingle(right)
  const vSingleT = Math.max(isSingle(up) ? weightPx(up, light) : 0, isSingle(down) ? weightPx(down, light) : 0)
  const hSingleT = Math.max(isSingle(left) ? weightPx(left, light) : 0, isSingle(right) ? weightPx(right, light) : 0)

  const outer: Rect[] = []
  const inner: Rect[] = []
  const push = (into: Rect[], x0: number, y0: number, x1: number, y1: number) => {
    if (x1 > x0 && y1 > y0) into.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
  }

  // Inset a bar's inner end only where the pair is capped; insetting a merged
  // end would leave a stray bar in the gap.
  if (right === D) {
    const stop = vSingle ? Math.round(axX - vSingleT / 2) : outerX0
    push(outer, stop, outerY0, x + w, outerY1)
    push(inner, left === D ? stop : stop + light, innerY0, x + w, innerY1)
  }
  if (left === D) {
    const stop = vSingle ? Math.round(axX + vSingleT / 2) : outerX1
    push(outer, x, outerY0, stop, outerY1)
    push(inner, x, innerY0, right === D ? stop : stop - light, innerY1)
  }
  if (down === D) {
    const stop = hSingle ? Math.round(axY - hSingleT / 2) : outerY0
    push(outer, outerX0, stop, outerX1, y + h)
    push(inner, innerX0, up === D ? stop : stop + light, innerX1, y + h)
  }
  if (up === D) {
    const stop = hSingle ? Math.round(axY + hSingleT / 2) : outerY1
    push(outer, outerX0, y, outerX1, stop)
    push(inner, innerX0, y, innerX1, down === D ? stop : stop - light)
  }

  for (const r of outer) ctx.fillRect(r.x, r.y, r.w, r.h)
  // Erase: the atlas keeps only alpha, so the hole must be a hole.
  ctx.globalCompositeOperation = 'destination-out'
  for (const r of inner) ctx.fillRect(r.x, r.y, r.w, r.h)
  ctx.globalCompositeOperation = 'source-over'

  // Single arms of a mixed character, drawn over the outline. One whose
  // opposite is also single crosses the pair; alone, it stops at the near rule
  // (U+2564's stem).
  const crossV = isSingle(up) && isSingle(down)
  const crossH = isSingle(left) && isSingle(right)
  if (isSingle(right)) {
    const t = weightPx(right, light)
    const from = crossH ? x : innerX1
    ctx.fillRect(from, Math.round(axY - t / 2), x + w - from, t)
  }
  if (isSingle(left)) {
    const t = weightPx(left, light)
    const to = crossH ? x + w : innerX0
    ctx.fillRect(x, Math.round(axY - t / 2), to - x, t)
  }
  if (isSingle(down)) {
    const t = weightPx(down, light)
    const from = crossV ? y : innerY1
    ctx.fillRect(Math.round(axX - t / 2), from, t, y + h - from)
  }
  if (isSingle(up)) {
    const t = weightPx(up, light)
    const to = crossV ? y + h : innerY0
    ctx.fillRect(Math.round(axX - t / 2), y, t, to - y)
  }
}

/**
 * Equal dashes and gaps, starting and ending with a dash, so a column of
 * U+2506 doesn't clump at row boundaries.
 */
function drawDashed(
  ctx: CanvasRenderingContext2D,
  spec: readonly [number, number, boolean],
  x: number,
  y: number,
  w: number,
  h: number,
  light: number,
): void {
  const [count, weight, vertical] = spec
  const t = weightPx(weight, light)
  const span = vertical ? h : w
  const unit = span / (count * 2 - 1)
  for (let i = 0; i < count; i++) {
    const a = Math.round(i * unit * 2)
    const b = Math.round(i * unit * 2 + unit)
    if (vertical) ctx.fillRect(Math.round(x + w / 2 - t / 2), y + a, t, b - a)
    else ctx.fillRect(x + a, Math.round(y + h / 2 - t / 2), b - a, t)
  }
}

/**
 * The rounded corners. Stroked, since a rect decomposition would staircase
 * and antialiasing is what makes the curve read.
 */
function drawArc(
  ctx: CanvasRenderingContext2D,
  arc: readonly [boolean, boolean],
  x: number,
  y: number,
  w: number,
  h: number,
  light: number,
): void {
  const [down, right] = arc
  // On the same axis as a straight rule, so U+256D lines up with U+2502 below.
  const cx = Math.round(x + w / 2 - light / 2) + light / 2
  const cy = Math.round(y + h / 2 - light / 2) + light / 2
  const r = Math.min(w, h) / 2

  ctx.save()
  ctx.strokeStyle = ctx.fillStyle as string
  ctx.lineWidth = light
  ctx.beginPath()
  ctx.moveTo(right ? x + w : x, cy)
  ctx.arcTo(cx, cy, cx, down ? y + h : y, r)
  ctx.lineTo(cx, down ? y + h : y)
  ctx.stroke()
  ctx.restore()
}

/** U+2571-U+2573: the two diagonals and the two together. */
function drawDiagonal(
  ctx: CanvasRenderingContext2D,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
  light: number,
): void {
  ctx.save()
  ctx.strokeStyle = ctx.fillStyle as string
  ctx.lineWidth = light
  ctx.beginPath()
  if (cp !== 0x2572) {
    ctx.moveTo(x + w, y)
    ctx.lineTo(x, y + h)
  }
  if (cp !== 0x2571) {
    ctx.moveTo(x, y)
    ctx.lineTo(x + w, y + h)
  }
  ctx.stroke()
  ctx.restore()
}

/**
 * U+2580-U+259F. Eighths and quadrants are rounded against the cell rect, not
 * accumulated, so half blocks on adjacent rows meet exactly.
 */
function drawBlock(
  ctx: CanvasRenderingContext2D,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  // Lower eighths: U+2581 is one eighth through U+2588, the full block.
  if (cp >= 0x2581 && cp <= 0x2588) {
    const top = Math.round(y + h * (1 - (cp - 0x2580) / 8))
    ctx.fillRect(x, top, w, y + h - top)
    return
  }
  // Left eighths run the other way: U+2589 is seven eighths, U+258F is one.
  if (cp >= 0x2589 && cp <= 0x258f) {
    const right = Math.round(x + (w * (0x2590 - cp)) / 8)
    ctx.fillRect(x, y, right - x, h)
    return
  }
  const midX = Math.round(x + w / 2)
  const midY = Math.round(y + h / 2)
  switch (cp) {
    case 0x2580: // upper half
      ctx.fillRect(x, y, w, midY - y)
      return
    case 0x2590: // right half
      ctx.fillRect(midX, y, x + w - midX, h)
      return
    // The shades as alpha, not dither: a dither crawls against the pixel grid on
    // resize.
    case 0x2591:
    case 0x2592:
    case 0x2593:
      ctx.save()
      ctx.globalAlpha = (cp - 0x2590) * 0.25
      ctx.fillRect(x, y, w, h)
      ctx.restore()
      return
    case 0x2594: // upper one eighth
      ctx.fillRect(x, y, w, Math.round(h / 8))
      return
    case 0x2595: { // right one eighth
      const left = Math.round(x + (w * 7) / 8)
      ctx.fillRect(left, y, x + w - left, h)
      return
    }
  }
  // The quadrants, U+2596-U+259F, as a mask of
  // [upper-left, upper-right, lower-left, lower-right].
  const q = QUADRANTS[cp]
  if (q === undefined) return
  if (q & 0b1000) ctx.fillRect(x, y, midX - x, midY - y)
  if (q & 0b0100) ctx.fillRect(midX, y, x + w - midX, midY - y)
  if (q & 0b0010) ctx.fillRect(x, midY, midX - x, y + h - midY)
  if (q & 0b0001) ctx.fillRect(midX, midY, x + w - midX, y + h - midY)
}

const QUADRANTS: Record<number, number> = {
  0x2596: 0b0010, 0x2597: 0b0001, 0x2598: 0b1000, 0x2599: 0b1011,
  0x259a: 0b1001, 0x259b: 0b1110, 0x259c: 0b1101, 0x259d: 0b0100,
  0x259e: 0b0110, 0x259f: 0b0111,
}

/**
 * One sextant, with subcell boundaries rounded against the cell rect so
 * neighbors meet exactly.
 */
function drawSextant(
  ctx: CanvasRenderingContext2D,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const mask = SEXTANTS.get(cp)
  if (mask === undefined) return
  const xs = [x, Math.round(x + w / 2), x + w]
  const ys = [y, Math.round(y + h / 3), Math.round(y + (h * 2) / 3), y + h]
  for (let i = 0; i < 6; i++) {
    if ((mask >> i & 1) === 0) continue
    const col = i % 2
    const row = (i / 2) | 0
    ctx.fillRect(xs[col], ys[row], xs[col + 1] - xs[col], ys[row + 1] - ys[row])
  }
}

/**
 * U+1FB70-U+1FB8B: the eighth-block family filling the gaps around
 * U+2580-U+259F (interior eighth columns and rows, corner Ls, and upper/right
 * fractions).
 */
function drawEighths(
  ctx: CanvasRenderingContext2D,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  /** The nth eighth column, 1-indexed from the left. */
  const col = (n: number) => {
    const a = Math.round(x + (w * (n - 1)) / 8)
    ctx.fillRect(a, y, Math.round(x + (w * n) / 8) - a, h)
  }
  /** The nth eighth row, 1-indexed from the top. */
  const row = (n: number) => {
    const a = Math.round(y + (h * (n - 1)) / 8)
    ctx.fillRect(x, a, w, Math.round(y + (h * n) / 8) - a)
  }
  /** The top `n` eighths. */
  const upper = (n: number) => ctx.fillRect(x, y, w, Math.round(y + (h * n) / 8) - y)
  /** The rightmost `n` eighths. */
  const right = (n: number) => {
    const a = Math.round(x + (w * (8 - n)) / 8)
    ctx.fillRect(a, y, x + w - a, h)
  }

  if (cp <= 0x1fb75) return col(cp - 0x1fb70 + 2)
  if (cp <= 0x1fb7b) return row(cp - 0x1fb76 + 2)
  switch (cp) {
    case 0x1fb7c: col(1); row(8); return // left and lower
    case 0x1fb7d: col(1); row(1); return // left and upper
    case 0x1fb7e: col(8); row(1); return // right and upper
    case 0x1fb7f: col(8); row(8); return // right and lower
    case 0x1fb80: row(1); row(8); return // upper and lower
    case 0x1fb81: row(1); row(3); row(5); row(8); return
    case 0x1fb82: return upper(2)
    case 0x1fb83: return upper(3)
    case 0x1fb84: return upper(5)
    case 0x1fb85: return upper(6)
    case 0x1fb86: return upper(7)
    case 0x1fb87: return right(2)
    case 0x1fb88: return right(3)
    case 0x1fb89: return right(5)
    case 0x1fb8a: return right(6)
    case 0x1fb8b: return right(7)
  }
}

/**
 * U+E0B0-U+E0BF, the Powerline separators. Private-use, so only Nerd Font
 * patches carry them; drawn to the cell rect they meet the neighboring
 * segment exactly.
 */
function drawPowerline(
  ctx: CanvasRenderingContext2D,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
  light: number,
): void {
  // U+E0B8-U+E0BF: a triangle filling one corner half of the cell, and its
  // "soft" partner (the hypotenuse alone), keyed by the right-angle corner.
  if (cp >= 0xe0b8) {
    const i = cp - 0xe0b8
    // Even members are the filled triangle, odd ones the bare diagonal.
    const soft = (i & 1) === 1
    // The right-angle corner walks lower-left, lower-right, upper-left,
    // upper-right.
    const atBottom = i < 4
    const atLeft = (i & 2) === 0
    const cornerX = atLeft ? x : x + w
    const cornerY = atBottom ? y + h : y
    // The hypotenuse always runs between the two corners adjacent to it.
    const ax = atLeft ? x : x + w
    const ay = atBottom ? y : y + h
    const bx = atLeft ? x + w : x
    const by = atBottom ? y + h : y

    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    if (soft) {
      ctx.save()
      ctx.strokeStyle = ctx.fillStyle as string
      ctx.lineWidth = light
      ctx.stroke()
      ctx.restore()
    } else {
      ctx.lineTo(cornerX, cornerY)
      ctx.closePath()
      ctx.fill()
    }
    return
  }

  const pointsRight = cp === 0xe0b0 || cp === 0xe0b1 || cp === 0xe0b4 || cp === 0xe0b5
  const outline = cp === 0xe0b1 || cp === 0xe0b3 || cp === 0xe0b5 || cp === 0xe0b7
  const rounded = cp >= 0xe0b4
  const cy = y + h / 2

  ctx.beginPath()
  if (rounded) {
    // A half-ellipse: the cell is about twice as tall as wide.
    ctx.ellipse(pointsRight ? x : x + w, cy, w, h / 2, 0, -Math.PI / 2, Math.PI / 2, !pointsRight)
  } else {
    const back = pointsRight ? x : x + w
    ctx.moveTo(back, y)
    ctx.lineTo(pointsRight ? x + w : x, cy)
    ctx.lineTo(back, y + h)
  }

  if (outline) {
    ctx.save()
    ctx.strokeStyle = ctx.fillStyle as string
    ctx.lineWidth = light
    ctx.stroke()
    ctx.restore()
  } else {
    ctx.closePath()
    ctx.fill()
  }
}
