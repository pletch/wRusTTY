/**
 * The title bar's drag handle, restored over a modal's backdrop, so a modal
 * never removes the only way to move the window.
 *
 * Only title-bar height, because Tauri starts the OS move loop on mousedown
 * over a drag region and most backdrops close their dialog on click.
 * Double-click maximizes, as for any drag region. Render it as the backdrop's
 * first child, and give the dialog `relative` so a tall one stays above it.
 */
export function WindowDragStrip() {
  return (
    <div
      data-tauri-drag-region
      aria-hidden
      className="absolute inset-x-0 top-0 h-10"
      // A press without movement still ends in a click, which would dismiss.
      onClick={(e) => e.stopPropagation()}
    />
  )
}
