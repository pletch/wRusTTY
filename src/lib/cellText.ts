/**
 * Splitting text into terminal cells, for DOM drawn over the grid (the inline
 * suggestion). A DOM text run advances by the font's per-character width,
 * which differs slightly from the engine's rounded cell width, so it drifts.
 * Boxing each unit to one cell matches the grid by construction.
 */

/**
 * Whether a code point occupies two cells: CJK, Hangul, kana, fullwidth forms
 * and emoji, not a full width table. Being wrong costs a column of alignment
 * in dim text, never a sent byte.
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

/** Marks that combine with the previous character and take no cell (accents,
 * variation selectors, ZWJ). */
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
 * Splits `text` into one- or two-cell units, folding combining marks into the
 * character they modify.
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
 * Takes as many units as fit in `maxCells`, never splitting a wide character
 * across the edge.
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
