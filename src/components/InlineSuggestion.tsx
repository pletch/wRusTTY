import { suggestionSuffix, type SuggestionView } from '../lib/autocomplete'

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

  return (
    <div
      // Never interactive. There is nothing to click, and taking a pointer
      // event here would put the cursor somewhere the user did not ask for.
      className="pointer-events-none absolute select-none italic text-white/30"
      style={{
        left: view.cursor.col * cell.width,
        top: screenRow * cell.height,
        height: cell.height,
        // Clipped to the columns actually remaining on the row, so a long
        // suggestion stops at the edge of the grid instead of running past it.
        maxWidth: columnsLeft * cell.width,
        // The pane's own metrics. `whiteSpace: pre` keeps runs of spaces in a
        // command from collapsing, which would put every character after them
        // in the wrong column.
        fontFamily,
        fontSize,
        lineHeight: `${cell.height}px`,
        whiteSpace: 'pre',
        overflow: 'hidden',
      }}
      aria-hidden
    >
      {suffix}
    </div>
  )
}
