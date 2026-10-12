import { placeSuggestions, type SuggestionView } from '../lib/autocomplete'

/**
 * The list of recent commands on offer, under the line being typed. Opened
 * with Ctrl+Space when a prefix is ambiguous; the inline suggestion is the
 * default view and claims no keys.
 *
 * Anchored to the input's origin, so it doesn't slide as characters are
 * typed. Being asked for is what earns it the arrow keys: Up/Down move,
 * Right or Enter accepts without running (a second Enter runs), and Escape
 * hands the keys back to the shell.
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
  // The line is scrolled off screen; nothing to anchor to.
  if (!place) return null

  return (
    <div
      // Not focusable: focus stays on the terminal, and the pane's key handler
      // drives the list.
      className="pointer-events-auto absolute z-20 overflow-y-auto overscroll-contain rounded-md border border-chrome/10 bg-[#1b1d22]/95 shadow-lg shadow-black/40 backdrop-blur-sm"
      style={{
        left: Math.max(0, view.origin.col * cell.width),
        top: Math.max(0, place.top),
        // Makes the flipped case exact.
        transform: place.below ? undefined : 'translateY(-100%)',
        maxHeight: place.maxHeight,
        // Wide enough for a real command, never wider than the pane.
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
          // `onMouseDown`, so the pane never loses focus between press and release.
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(i)
          }}
          className={`block w-full truncate px-2 py-1 text-left font-mono ${
            i === view.index ? 'bg-sky-400/20 text-chrome' : 'text-chrome/60 hover:bg-chrome/5'
          }`}
          title={item}
        >
          {/* The typed part is dimmed, so the eye goes to the completion. */}
          <span className="text-chrome/35">{item.slice(0, view.typed.length)}</span>
          {item.slice(view.typed.length)}
        </button>
      ))}
    </div>
  )
}
