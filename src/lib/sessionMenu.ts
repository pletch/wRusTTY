/** Where the session list's context menu opens: beside the row, over the
 * connect form, rather than under the cursor, where it would cover the
 * sessions below and a stray click could connect to the wrong host. */

/** `w-36` in the markup. */
const MENU_WIDTH = 144
/** The tallest the menu gets: four items plus its padding. */
const MENU_MAX_HEIGHT = 128

/** Gap from the row, and the margin kept from a viewport edge. */
const GAP = 4
const EDGE_MARGIN = 8

/** Moves a menu of a measured size back inside the viewport. `reservedBelow` is what sits
 * over the viewport's bottom, like the key row and status bar on a phone. */
export function keepMenuOnScreen(
  at: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  reservedBelow = 0,
): { x: number; y: number } {
  const maxX = viewport.width - size.width - EDGE_MARGIN
  const maxY = viewport.height - reservedBelow - size.height - EDGE_MARGIN
  return {
    x: Math.max(EDGE_MARGIN, Math.min(at.x, maxX)),
    y: Math.max(EDGE_MARGIN, Math.min(at.y, maxY)),
  }
}

export function menuAnchor(
  rowRight: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  return {
    // Vertically it follows the cursor to stay attached to its row; both axes
    // are clamped to the viewport.
    x: Math.min(rowRight + GAP, viewportWidth - MENU_WIDTH - EDGE_MARGIN),
    y: Math.min(clientY, viewportHeight - MENU_MAX_HEIGHT - EDGE_MARGIN),
  }
}
