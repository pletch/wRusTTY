/**
 * The terminal's grid covers whole cells only, so a press can land on the pane's
 * padding or on the partial row and column around the grid. Left alone, the browser
 * moves focus off the terminal's hidden input there. On a phone with the keyboard
 * closed, that leaves nothing for a tap to open the keyboard for, and every later tap
 * in the same strip changes nothing, until something else refocuses the terminal.
 *
 * Handles a mousedown on the pane: a press on the pane itself or on the grid's
 * container, rather than on anything inside it, is treated as a press on the
 * terminal. Returns whether it was.
 */
export function pressAroundGrid(
  // React's event, not the native one: under React the native `currentTarget` is the
  // root React listens on, not the pane.
  e: { target: EventTarget | null; currentTarget: EventTarget | null; preventDefault(): void },
  container: Element | null,
  focusTerminal: () => void,
): boolean {
  if (e.target !== e.currentTarget && (container === null || e.target !== container)) return false
  e.preventDefault()
  focusTerminal()
  return true
}
