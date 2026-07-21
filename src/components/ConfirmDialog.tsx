import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'

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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div
      className="animate-in fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 duration-150"
      onClick={onCancel}
    >
      <div
        className="animate-in zoom-in-95 w-80 space-y-3 rounded-lg border border-white/10 bg-[#1f2028] p-5 shadow-2xl duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-white/90">
          <AlertTriangle size={15} className="shrink-0 text-amber-400" />
          <span className="font-medium">{title}</span>
        </div>
        <p className="text-xs leading-relaxed text-white/50">{body}</p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-xs text-white/70 transition-colors duration-100 hover:bg-white/10"
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
    </div>
  )
}
