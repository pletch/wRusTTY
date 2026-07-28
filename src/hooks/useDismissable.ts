import { useEffect } from 'react'

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

  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // `onDismiss` is called, never compared — listing it would re-bind on every
    // render for callers passing an inline arrow, which is most of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useEffect(() => {
    if (!active || !within) return
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(within)) onDismiss()
    }
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, within])
}
