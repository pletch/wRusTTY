/** Which dismissable surface Escape should actually reach.
 *
 * Every popover, panel and dialog listens for Escape on `window`, because that
 * is the only way to catch the key wherever focus happens to be. The cost is
 * that they all hear it at once: cancelling a confirmation raised *from* the
 * forwarding panel closed the confirmation and the panel underneath it, losing
 * the form that had just been filled in.
 *
 * So they queue. A surface registers while it is open, and only the one on top
 * responds to Escape — which is what "Escape closes the thing you are looking
 * at" means when things are stacked.
 *
 * Order is registration order, which is mount order, which for surfaces opened
 * by successive user actions is the same as visual stacking: a confirmation
 * raised from a panel mounts after it and therefore sits above it. Two surfaces
 * mounting in the *same* render would order child-first, which needn't match
 * z-order — no such pair exists today, and one would be a design smell anyway.
 *
 * A plain module-level array rather than context: this is a global ordering
 * question, the participants are spread across unrelated trees (ConfirmProvider
 * renders at the app root, the panels render inside a pane), and nothing
 * re-renders when it changes.
 */

export type DismissToken = symbol

const stack: DismissToken[] = []

/** Registers `token` as the topmost surface. Idempotent: registering something
 * already present moves it to the top rather than adding it twice, which is
 * what makes StrictMode's double-invoked effects harmless. */
export function pushDismissable(token: DismissToken): void {
  removeDismissable(token)
  stack.push(token)
}

export function removeDismissable(token: DismissToken): void {
  const at = stack.indexOf(token)
  if (at !== -1) stack.splice(at, 1)
}

/** Whether `token` is the surface Escape should reach. An unregistered token is
 * never top — a surface that failed to register stays silent rather than
 * competing with whatever is genuinely on top. */
export function isTopDismissable(token: DismissToken): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token
}

/** Test seam — the stack is module state. */
export function resetDismissStack(): void {
  stack.length = 0
}
