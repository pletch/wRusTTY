import { suggestionSuffix, type SuggestionView } from '../lib/autocomplete'
import { domBaselineShift } from '../lib/cellBaseline'
import { fitToCells, toCellUnits } from '../lib/cellText'

/**
 * The suggestion as dim text sitting after the cursor, on the line itself.
 *
 * The default view, and the reason is empirical rather than aesthetic: the
 * dropdown this replaced produced three separate faults in use — it covered
 * the line being typed, it captured the arrow keys someone was using to walk
 * their shell history, and it painted out over the app's own status bar. None
 * of those are possible here. This occupies cells that are already blank (the
 * offer is only made with the cursor at the end of the line), so it covers
 * nothing; it needs no navigation, so it captures nothing; and it is one line
 * tall, so there is nothing to overflow.
 *
 * It is also *ignorable*, which is the property that matters most. A
 * suggestion is often wrong, and dim text you can type straight through costs
 * nothing to be wrong — where a box that appears over your work taxes every
 * keystroke whether or not it was any use.
 *
 * The list is still there, one Ctrl+Space away, for a prefix that really is
 * ambiguous. Much the same division PSReadLine draws with F2.
 *
 * **Drawn one cell at a time**, rather than as a run of text. Handing the
 * whole string to the browser lays it out at the font's own advance per
 * character, which is close to the engine's cell width and not equal to it —
 * so the ghost text drifts a fraction of a pixel per character and ends
 * visibly short of the real text above it by the end of a long command.
 * Boxing each character to exactly one cell makes that impossible instead of
 * merely unlikely, and is what the terminal itself does. See lib/cellText.ts.
 *
 * Not italic, for the same reason. A monospace family usually has no true
 * italic face, so the browser synthesises an oblique whose metrics differ
 * again — and once each character is boxed, a slanted glyph leans out of its
 * box and gets clipped. Dimming alone reads clearly enough as "not yet real".
 *
 * **And nudged onto the grid's baseline**, which is the vertical half of the
 * same argument. A line box centres the face's own ascent and descent; the
 * atlas centres a measured box and rounds it. Those agree for some faces and
 * not others — in Monaspace Neon and JetBrains Mono the ghost text sat a pixel
 * above the real text, in Fira Code and Consolas it did not. See
 * lib/cellBaseline.ts.
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
  /** The pane's own font, so the ghost text lines up with the real glyphs
   * beside it rather than approximating them. */
  fontFamily: string
  fontSize: number
}) {
  const suffix = suggestionSuffix(view)
  if (suffix === '') return null

  const screenRow = view.cursor.row - viewportY
  // Scrolled out of view, which happens when someone scrolls back through
  // history with an offer open.
  if (screenRow < 0 || screenRow >= rows) return null
  // Nothing to draw in: the cursor is already at the right edge, and anything
  // written here would wrap onto a row holding something else.
  const columnsLeft = cols - view.cursor.col
  if (columnsLeft <= 0) return null
  // Trimmed to the columns actually left on the row, so a long suggestion
  // stops at the edge of the grid rather than running past it — and never
  // with half a wide character in the last column.
  const units = fitToCells(toCellUnits(suffix), columnsLeft)
  if (units.length === 0) return null

  return (
    <div
      // Never interactive. There is nothing to click, and taking a pointer
      // event here would put the cursor somewhere the user did not ask for.
      className="pointer-events-none absolute select-none text-chrome/30"
      style={{
        left: view.cursor.col * cell.width,
        top: screenRow * cell.height,
        height: cell.height,
        fontFamily,
        fontSize,
        lineHeight: `${cell.height}px`,
        // Onto the grid's baseline rather than the line box's. Zero for a
        // face where the two already agree, and zero where it cannot be
        // measured at all.
        transform: `translateY(${domBaselineShift(fontFamily, fontSize, cell.height)}px)`,
        // `pre` keeps a run of spaces inside a command from collapsing, which
        // would put every character after it in the wrong column even with the
        // per-cell boxes below.
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
            // Nothing may lean into its neighbour's column.
            overflow: 'hidden',
          }}
        >
          {unit.text}
        </span>
      ))}
    </div>
  )
}
