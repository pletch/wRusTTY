import { useEffect, useRef } from 'react'
import { isTopDismissable, pushDismissable, removeDismissable } from '../lib/dismissStack'

/** Closing a transient surface with Escape and by clicking away, the same way
 * everywhere.
 *
 * Not applied to `HostKeyPrompt`: a fingerprint decision shouldn't be
 * answerable by a stray Escape, and dismissing would leave the SSH verifier
 * waiting.
 */
export function useDismissable(
  active: boolean,
  onDismiss: () => void,
  options: {
    /** Selector for the surface's own subtree (a click inside isn't a click
     * away). Omit to bind Escape only. */
    within?: string
  } = {},
) {
  const { within } = options
  // This surface's identity in the dismiss stack. A ref, so re-renders don't
  // re-register and steal the top spot.
  const token = useRef<symbol>(undefined as unknown as symbol)
  if (token.current === undefined) token.current = Symbol('dismissable')

  useEffect(() => {
    if (!active) return
    const self = token.current
    pushDismissable(self)
    const onKeyDown = (e: KeyboardEvent) => {
      // Every surface listens on `window` to catch Escape anywhere, so only the
      // topmost may act.
      if (e.key === 'Escape' && isTopDismissable(self)) onDismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      removeDismissable(self)
    }
    // `onDismiss` is called, never compared; listing it would re-bind every
    // render for inline callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useEffect(() => {
    if (!active || !within) return
    // React flushes passive effects at the end of a discrete event, so for a
    // surface opened by a click, this listener would catch that same click and
    // close it immediately. Callers should include their trigger in `within`;
    // this is the fallback.
    const attachedAt = performance.now()
    const onClick = (e: MouseEvent) => {
      if (e.timeStamp < attachedAt) return
      const target = e.target as HTMLElement
      // A click inside a modal (`ConfirmProvider` renders at the app root) is
      // never a click away from the panel that raised it. Matched by attribute so
      // panels needn't enumerate modals.
      if (target.closest('[data-modal]')) return
      if (!target.closest(within)) onDismiss()
    }
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, within])
}
