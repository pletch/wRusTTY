import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import { useDismissable } from '../hooks/useDismissable'

interface Props {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

/** A yes/no gate in front of something irreversible.
 *
 * Cancel is the default focus and Escape cancels, so the safe answer is the
 * one you get by reflex — this exists precisely because the destructive
 * action was too easy to trigger by reflex in the first place. */
export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  // Rendered only while asking, so it is always the surface Escape should
  // reach — and being registered last, it sits above whatever raised it.
  useDismissable(true, onCancel)

  // Portalled to the body and above z-50, because a confirmation is by
  // definition the topmost thing on screen — it is always raised *from*
  // something else. Rendered inline it sat inside #root while SettingsDialog
  // portals to the body, so at equal z-index the later DOM node won and the
  // confirmation was invisible behind the dialog that raised it: a dimmed,
  // apparently frozen app whose only way out was guessing Escape.
  return createPortal(
    <div
      // Marks this as a modal, so answering it does not read as a click away
      // from whatever raised it — see `useDismissable`.
      data-modal
      className="animate-in fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 duration-150"
      onClick={onCancel}
    >
      <div
        className="animate-in zoom-in-95 w-80 space-y-3 rounded-lg border border-chrome/10 bg-surface p-5 shadow-2xl duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-chrome/90">
          <AlertTriangle size={15} className="shrink-0 text-amber-400" />
          <span className="font-medium">{title}</span>
        </div>
        <p className="text-xs leading-relaxed text-chrome/50">{body}</p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-xs text-chrome/70 transition-colors duration-100 hover:bg-chrome/10"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded bg-red-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-100 hover:bg-red-500"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
