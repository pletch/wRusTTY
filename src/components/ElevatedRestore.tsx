import { ShieldCheck, X } from 'lucide-react'
import { shellDisplayName } from '../lib/local'

interface Props {
  /** The detected shell id the administrator tab was running. */
  shellId: string
  /** The name the tab had, when it had one of its own. */
  label?: string | null
  onReopen: () => void
  onClose: () => void
  /** Shows the full connect form instead, for changing something first. */
  onEdit: () => void
}

/**
 * What a restored administrator tab shows in place of the connect form.
 *
 * Decision 4 of docs/ELEVATED_TABS_PLAN.md: an elevated tab never reconnects
 * by itself, because that would be a UAC prompt nobody asked for. What comes
 * back is one question — reopen it, or close it — rather than the whole form
 * to read through for an answer that is almost always one of the two. The
 * reopen still goes through the prompt; this only saves finding the button.
 */
export function ElevatedRestore({ shellId, label, onReopen, onClose, onEdit }: Props) {
  const name = label || shellDisplayName(shellId) || shellId
  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-chrome/10 bg-black/30 p-4 text-sm">
        <div className="flex items-center gap-2 text-chrome/90">
          <ShieldCheck size={16} className="shrink-0 text-amber-400" />
          <span className="min-w-0 truncate font-medium">{name} · Administrator</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-chrome/50">
          This administrator tab was open when wRusTTY last closed. Reopening it asks for
          permission through Windows first.
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            autoFocus
            onClick={onReopen}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-amber-500/80 py-1.5 font-medium text-black transition-colors duration-150 hover:bg-amber-400"
          >
            <ShieldCheck size={14} />
            Reopen as administrator
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center gap-1.5 rounded-md border border-chrome/15 px-3 py-1.5 text-chrome/70 transition-colors duration-150 hover:bg-chrome/10 hover:text-chrome"
          >
            <X size={14} />
            Close
          </button>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="mt-3 text-xs text-chrome/40 underline-offset-2 transition-colors duration-100 hover:text-chrome/70 hover:underline"
        >
          Change settings first…
        </button>
      </div>
    </div>
  )
}
