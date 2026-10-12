/** Which dismissable surface Escape should reach.
 *
 * Every surface listens for Escape on `window`, so they'd all hear it at once.
 * Instead they register while open, and only the topmost responds.
 * Registration order is mount order, which matches visual stacking for
 * surfaces opened by successive actions (a confirmation raised from a panel
 * mounts after it). A module-level array, since participants live in
 * unrelated trees and nothing re-renders on change.
 */

export type DismissToken = symbol

const stack: DismissToken[] = []

/** Registers `token` as topmost. Idempotent (re-registering moves it to the
 * top), so StrictMode's double effects are harmless. */
export function pushDismissable(token: DismissToken): void {
  removeDismissable(token)
  stack.push(token)
}

export function removeDismissable(token: DismissToken): void {
  const at = stack.indexOf(token)
  if (at !== -1) stack.splice(at, 1)
}

/** Whether `token` is the surface Escape should reach. An unregistered token
 * is never top. */
export function isTopDismissable(token: DismissToken): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token
}

/** Test seam: the stack is module state. */
export function resetDismissStack(): void {
  stack.length = 0
}
