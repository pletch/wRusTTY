/** Where the session list's context menu opens.
 *
 * Beside the row, never under the cursor — which is what it used to do, and
 * which was wrong in two compounding ways. The menu is taller than a row, so
 * opening it at the click point laid it over the sessions *below* the one it
 * belongs to. A click that missed an item slightly, or one meant only to
 * dismiss the menu, therefore landed on another session: with the vault
 * unlocked that connects to a host nobody asked for, and with it locked the
 * whole browser is replaced by that host's unlock prompt. And once the menu
 * closed, the cursor was left hovering a highlighted row that was not the row
 * being worked on, which reads as the app having selected it.
 *
 * Anchoring to the row's right edge puts the menu over the connect form
 * instead, where the worst a stray click can do is focus a text field.
 */

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
    // Vertically the menu still follows the cursor, so it stays visibly
    // attached to the row it is about; both axes are clamped so the last
    // session in a long list, or a narrow window, cannot open one off-screen.
    x: Math.min(rowRight + GAP, viewportWidth - MENU_WIDTH - EDGE_MARGIN),
    y: Math.min(clientY, viewportHeight - MENU_MAX_HEIGHT - EDGE_MARGIN),
  }
}
