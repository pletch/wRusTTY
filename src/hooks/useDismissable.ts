import { useEffect, useRef } from 'react'
import { isTopDismissable, pushDismissable, removeDismissable } from '../lib/dismissStack'

/** Closing a transient surface with the keyboard, and by clicking away from it.
 *
 * Every popover and panel in the app had grown its own answer to this, and the
 * answers disagreed: SettingsDialog and ConfirmDialog closed on Escape, the
 * vault and workspace menus closed on a click outside but ignored Escape, and
 * the forwarding and files panels did neither — they could only be closed by
 * finding their own small ✕. Both panels even carried
 * `onClick={(e) => e.stopPropagation()}` on their root, defending against an
 * outside-click handler that was never written.
 *
 * One hook so the answer is the same everywhere, and so a surface added later
 * gets it by default rather than by remembering.
 *
 * Deliberately *not* applied to `HostKeyPrompt`. That prompt has Accept and
 * Reject and nothing else, on purpose: a fingerprint decision should not be
 * answerable by a stray Escape, and an unanswered prompt parks the SSH
 * verifier waiting for a reply that dismissing would never send.
 */
export function useDismissable(
  active: boolean,
  onDismiss: () => void,
  options: {
    /** Selector marking the surface's own subtree. A click inside it is not a
     * click away. Omit to skip click-away entirely and bind Escape only. */
    within?: string
  } = {},
) {
  const { within } = options
  // Identity for this surface in the dismiss stack. A ref so it survives
  // re-renders — a fresh token each render would re-register constantly and
  // keep stealing the top spot from whatever is genuinely above.
  const token = useRef<symbol>(undefined as unknown as symbol)
  if (token.current === undefined) token.current = Symbol('dismissable')

  useEffect(() => {
    if (!active) return
    const self = token.current
    pushDismissable(self)
    const onKeyDown = (e: KeyboardEvent) => {
      // Every surface listens on `window`, because that is the only way to
      // catch Escape wherever focus is — so without this check they all fire
      // at once, and cancelling a confirmation raised from a panel would close
      // the panel underneath it too.
      if (e.key === 'Escape' && isTopDismissable(self)) onDismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      removeDismissable(self)
    }
    // `onDismiss` is called, never compared — listing it would re-bind on every
    // render for callers passing an inline arrow, which is most of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useEffect(() => {
    if (!active || !within) return
    // React flushes passive effects synchronously at the end of a discrete
    // event, so for a surface opened by a click this listener is attached
    // while that very click is *still bubbling* toward window. It then arrives
    // here, is found to be outside the surface, and closes it again — the
    // surface appears never to open at all.
    //
    // Callers are expected to include their trigger in `within`, which is the
    // semantically right answer (pressing the trigger is not "clicking away").
    // This is the belt to that's braces: a caller who forgets gets a surface
    // that opens, rather than one that silently refuses to.
    const attachedAt = performance.now()
    const onClick = (e: MouseEvent) => {
      if (e.timeStamp < attachedAt) return
      const target = e.target as HTMLElement
      // A click inside a modal is never a click away from what raised it.
      //
      // `ConfirmProvider` renders at the app root, so a confirmation asked for
      // *by* a panel is not in that panel's subtree — and answering it was
      // therefore a click "away" by the selector's reckoning, which closed the
      // panel underneath. Escape has always had the dismiss stack to sort this
      // out; the click path never got the equivalent, and the asymmetry stayed
      // invisible for as long as no flow needed the panel afterwards.
      //
      // One that does: the Files panel asks whether to save a file as root,
      // and the answer arrives on a channel *the panel owns*. With the panel
      // unmounted by the very click that said yes, the sudo password dialog
      // was set on a component that no longer existed — so no dialog ever
      // appeared, and the operation waited two minutes and gave up.
      //
      // Matched by attribute rather than by adding every modal to each
      // caller's `within`: which surfaces are modal is a fact about them, not
      // something every panel should have to enumerate.
      if (target.closest('[data-modal]')) return
      if (!target.closest(within)) onDismiss()
    }
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, within])
}
