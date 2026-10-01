/**
 * The title bar's handle on the window, put back over a modal's backdrop.
 *
 * Every modal dims the whole window, title bar included, and its backdrop takes
 * the presses the tab strip's drag region would have had. That is right for the
 * tabs and the window buttons — a modal is waiting for an answer — but it also
 * took the one way to move the window, and that turned out to matter: a window
 * restored partly off-screen put the "Restore sessions?" prompt below the
 * bottom of the display, with nothing left on screen that would move it.
 *
 * A strip the height of the title bar rather than the whole backdrop, because
 * Tauri starts the OS move loop on mousedown over a drag region, and most of
 * these backdrops close their dialog on a click. Double-click maximizes, which
 * Tauri's drag script does for any drag region.
 *
 * Render it as the backdrop's first child, and give the dialog `relative` so a
 * tall one still paints, and takes presses, above it.
 */
export function WindowDragStrip() {
  return (
    <div
      data-tauri-drag-region
      aria-hidden
      className="absolute inset-x-0 top-0 h-10"
      // A press that never moves still ends in a click, and the backdrop's
      // click is "dismiss".
      onClick={(e) => e.stopPropagation()}
    />
  )
}
