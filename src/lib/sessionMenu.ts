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
