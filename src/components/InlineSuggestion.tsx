import { suggestionSuffix, type SuggestionView } from '../lib/autocomplete'
import { domBaselineShift } from '../lib/cellBaseline'
import { fitToCells, toCellUnits } from '../lib/cellText'

/**
 * The suggestion as dim text after the cursor, on the line itself. It only
 * appears with the cursor at the end of the line, so it covers nothing,
 * captures no keys and can't overflow, and it costs nothing to type through
 * when it's wrong. The list is a Ctrl+Space away for ambiguous prefixes (as
 * with PSReadLine's F2).
 *
 * Drawn one cell at a time, as the terminal does (see lib/cellText.ts): the
 * font's advance differs slightly from the cell width, so a text run would
 * drift. Not italic, since a synthesized oblique would lean out of its box.
 * Nudged onto the grid's baseline (see lib/cellBaseline.ts).
 */
export function InlineSuggestion({
  view,
  cell,
  viewportY,
  rows,
  cols,
  fontFamily,
  fontSize,
}: {
  view: SuggestionView
  /** Cell size in CSS pixels. */
  cell: { width: number; height: number }
  /** Absolute buffer row currently at the top of the viewport. */
  viewportY: number
  rows: number
  cols: number
  /** The pane's own font, so the ghost text matches the real glyphs. */
  fontFamily: string
  fontSize: number
}) {
  const suffix = suggestionSuffix(view)
  if (suffix === '') return null

  const screenRow = view.cursor.row - viewportY
  // Scrolled out of view.
  if (screenRow < 0 || screenRow >= rows) return null
  // Cursor at the right edge: anything written would wrap onto another row.
  const columnsLeft = cols - view.cursor.col
  if (columnsLeft <= 0) return null
  // Trimmed to the columns left, never splitting a wide character.
  const units = fitToCells(toCellUnits(suffix), columnsLeft)
  if (units.length === 0) return null

  return (
    <div
      // Never interactive; a click here would move the cursor unasked.
      className="pointer-events-none absolute select-none text-chrome/30"
      style={{
        left: view.cursor.col * cell.width,
        top: screenRow * cell.height,
        height: cell.height,
        fontFamily,
        fontSize,
        lineHeight: `${cell.height}px`,
        // Onto the grid's baseline; zero where they agree or it can't be measured.
        transform: `translateY(${domBaselineShift(fontFamily, fontSize, cell.height)}px)`,
        // `pre` keeps runs of spaces, or later characters would shift columns.
        whiteSpace: 'pre',
      }}
      aria-hidden
    >
      {units.map((unit, i) => (
        <span
          key={i}
          style={{
            display: 'inline-block',
            width: unit.cells * cell.width,
            // Nothing may lean into its neighbor's column.
            overflow: 'hidden',
          }}
        >
          {unit.text}
        </span>
      ))}
    </div>
  )
}
