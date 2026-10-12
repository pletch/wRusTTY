import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ShieldAlert } from 'lucide-react'
import { useDismissable } from '../hooks/useDismissable'
import { WindowDragStrip } from './WindowDragStrip'

interface Props {
  /** The file this is for. Named, since an objectless "enter your password"
   *  gets any password typed into it. */
  remotePath: string
  /** A password was already tried and rejected. */
  retry: boolean
  /** The typed password, or `null` to cancel. */
  onAnswer: (password: string | null) => void
}

/**
 * Asks for the remote host's sudo password, to open a file as root.
 *
 * Visibly unlike `AuthPrompt` (amber, a shield, "sudo password"): the sudo
 * password often differs from the login credential, and a look-alike dialog
 * would collect the wrong one. It states that answering starts a privileged
 * helper that runs while the file is open.
 *
 * Rendered through a portal: its caller, the Files panel, is a small
 * transformed box, and a root password dialog must be app-modal.
 */
export function SudoPrompt({ remotePath, retry, onAnswer }: Props) {
  const [password, setPassword] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Escape via the shared stack, so it reaches this rather than the panel
  // underneath.
  useDismissable(true, () => onAnswer(null))

  // Claim focus from the panel behind.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return createPortal(
    <div
      // Not a click away from the Files panel waiting on it (see
      // `useDismissable`).
      data-modal
      className="animate-in fade-in fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 duration-150"
    >
      <WindowDragStrip />
      <form
        className="animate-in zoom-in-95 relative w-[26rem] max-w-full space-y-3 rounded-lg border border-amber-500/25 bg-surface p-5 shadow-2xl duration-150"
        onSubmit={(e) => {
          e.preventDefault()
          onAnswer(password)
        }}
      >
        <h1 className="flex items-center gap-2 text-sm font-semibold text-chrome">
          <ShieldAlert size={16} className="text-amber-400" />
          Open as root?
        </h1>

        <p className="text-xs leading-relaxed text-chrome/70">
          You cannot write{' '}
          <span className="break-all font-mono text-chrome/90">{remotePath}</span> as the user this
          session is connected as. Opening it as root needs the{' '}
          <span className="font-medium text-chrome/90">sudo password for that host</span> — not the
          password for this SSH connection.
        </p>

        <p className="rounded bg-amber-500/10 p-2 text-[11px] leading-relaxed text-amber-200/90">
          A privileged helper will run on the host until you stop watching the file. Your password
          is used once to start it and is not stored.
        </p>

        <label className="block space-y-1">
          <span className="text-[11px] text-chrome/60">sudo password</span>
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            // Never offered to a password manager, which would later fill it into the
            // SSH dialog.
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded border border-chrome/10 bg-black/30 px-2 py-1.5 font-mono text-xs text-chrome outline-none focus:border-amber-500/60"
          />
        </label>

        {retry && (
          <p className="text-[11px] text-red-400/90">
            That password was not accepted. Try again, or cancel.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs text-chrome/70 transition-colors duration-100 hover:bg-chrome/10"
            onClick={() => onAnswer(null)}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-amber-500/90 px-3 py-1.5 text-xs font-medium text-black transition-colors duration-100 hover:bg-amber-500"
          >
            Open as root
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
