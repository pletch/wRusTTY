import { placeSuggestions, type SuggestionView } from '../lib/autocomplete'

/**
 * The list of recent commands on offer, sitting under the line being typed.
 *
 * A dropdown rather than inline grey ghost-text, for the first version. Ghost
 * text is the prettier form and reads better once you know the feature is
 * there, but it needs either a second draw path in the WebGL renderer or an
 * absolutely-positioned span that stays pixel-aligned through font changes,
 * DPI changes and re-fits. A list is also the only form that can show more
 * than one candidate, which is what makes list navigation worth having.
 *
 * Anchored to the *origin* of the input rather than the cursor, so it stays
 * put as characters are typed instead of sliding right with every keystroke.
 *
 * It never takes the plain arrow keys — those belong to the shell's own
 * history recall, which is the most common thing anyone does at a prompt. Tab
 * or Right accepts, Ctrl+Up/Ctrl+Down move, Escape dismisses.
 */
export function SuggestionPopover({
  view,
  cell,
  viewportY,
  rows,
  onPick,
}: {
  view: SuggestionView
  /** Cell size in CSS pixels. */
  cell: { width: number; height: number }
  /** Absolute buffer row currently at the top of the viewport. */
  viewportY: number
  /** Rows on screen, for deciding which side of the line has more room. */
  rows: number
  onPick: (index: number) => void
}) {
  const place = placeSuggestions({
    cursorRow: view.cursor.row,
    viewportY,
    rows,
    cellHeight: cell.height,
  })
  // The line is not on screen — the user scrolled back through history while a
  // suggestion was open — so there is nothing to anchor to and nothing worth
  // drawing.
  if (!place) return null

  return (
    <div
      // Not focusable and not in the tab order: focus belongs to the terminal
      // the whole time, and taking it would stop the next keystroke reaching
      // the far end. The list is driven entirely from the pane's key handler.
      className="pointer-events-auto absolute z-20 overflow-y-auto overscroll-contain rounded-md border border-white/10 bg-[#1b1d22]/95 shadow-lg shadow-black/40 backdrop-blur-sm"
      style={{
        left: Math.max(0, view.origin.col * cell.width),
        top: Math.max(0, place.top),
        // See above: this is what makes the flipped case exact.
        transform: place.below ? undefined : 'translateY(-100%)',
        maxHeight: place.maxHeight,
        // Wide enough to read a real command, and never wider than the pane.
        maxWidth: '90%',
      }}
      role="listbox"
      aria-label="Recent commands"
    >
      {view.items.map((item, i) => (
        <button
          key={item}
          type="button"
          role="option"
          aria-selected={i === view.index}
          // Mouse is a convenience; the keyboard is the point. `onMouseDown`
          // rather than `onClick` so the pane never loses focus to the button
          // even for the instant between press and release.
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(i)
          }}
          className={`block w-full truncate px-2 py-1 text-left font-mono ${
            i === view.index ? 'bg-sky-400/20 text-white' : 'text-white/60 hover:bg-white/5'
          }`}
          title={item}
        >
          {/* What was typed is dimmed and the completion is not, so the eye
              goes straight to the part that is new. */}
          <span className="text-white/35">{item.slice(0, view.typed.length)}</span>
          {item.slice(view.typed.length)}
        </button>
      ))}
    </div>
  )
}
