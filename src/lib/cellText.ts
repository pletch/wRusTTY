/**
 * Splitting text into terminal cells, for anything drawn as DOM *over* the
 * grid rather than into it.
 *
 * The inline suggestion is the only such thing so far, and it is why this
 * exists. A terminal paints every glyph at exactly one cell width; a DOM text
 * run advances by whatever the font says each character is worth. Those two
 * numbers are close and not equal — the engine's cell width is a measured,
 * rounded value — so a run of text laid out by the browser drifts a fraction
 * of a pixel per character against the grid beside it. Over a short word that
 * is invisible; over a fifty-character command it is a visible offset, and the
 * ghost text no longer lines up with the real text above it.
 *
 * Matching fonts and sizes does not fix it, because the mismatch is in the
 * *advance per character*. Boxing each unit to exactly one cell does, by
 * construction — which is also simply what the terminal itself does.
 */

/**
 * Whether a code point occupies two cells.
 *
 * The ranges a terminal actually cares about, not a full Unicode width table:
 * CJK, Hangul, kana, fullwidth forms, and the emoji blocks. Everything else is
 * one cell. This will be wrong for a handful of exotic code points, and being
 * wrong here costs a column of alignment in dim text — not a corrupted command,
 * because nothing derived from this is ever sent anywhere.
 */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, Kangxi
    (code >= 0x3041 && code <= 0x33ff) || // kana, CJK compatibility
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f6ff) || // emoji, through transport symbols
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd) // CJK extensions B+
  )
}

/** Marks that combine with the character before them and take no cell of their
 * own — an accent, a variation selector, a zero-width joiner. */
function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    (code >= 0xfe20 && code <= 0xfe2f) ||
    code === 0x200d // zero-width joiner
  )
}

/** One drawable unit and how many cells it occupies. */
export interface CellUnit {
  text: string
  cells: number
}

/**
 * Split `text` into units of one or two cells, folding combining marks into
 * the character they modify so an accent never gets a box of its own.
 */
export function toCellUnits(text: string): CellUnit[] {
  const units: CellUnit[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (isCombining(code) && units.length > 0) {
      units[units.length - 1].text += char
      continue
    }
    units.push({ text: char, cells: isWide(code) ? 2 : 1 })
  }
  return units
}

/**
 * Take as many units as fit in `maxCells`, never splitting a wide character
 * across the edge — half a glyph in the last column is worse than a blank one.
 */
export function fitToCells(units: CellUnit[], maxCells: number): CellUnit[] {
  const out: CellUnit[] = []
  let used = 0
  for (const unit of units) {
    if (used + unit.cells > maxCells) break
    out.push(unit)
    used += unit.cells
  }
  return out
}
