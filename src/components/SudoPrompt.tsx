import { useEffect, useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'

interface Props {
  /** The file this is being asked for. Named, because "enter your password" with
   *  no object is exactly the prompt people type any password into. */
  remotePath: string
  /** A password was already tried and rejected. */
  retry: boolean
  /** The typed password, or `null` to cancel. */
  onAnswer: (password: string | null) => void
}

/**
 * Asks for the *remote host's* sudo password, to open a file as root.
 *
 * Deliberately unlike `AuthPrompt` in every respect a glance would pick up on —
 * amber rather than sky, a shield rather than a server, "sudo password" in the
 * heading. The two dialogs ask for different secrets: by the time this one
 * appears the SSH session is long since authenticated, and on a great many
 * hosts the sudo password is a different credential from the one that got the
 * user in. A dialog that looked like the login one would collect the login one.
 *
 * It also says what it is about to do, because that is the part the user is
 * actually consenting to. Answering this starts a privileged helper on the host
 * that stays up for as long as the file is open — a fact worth stating in the
 * dialog rather than in a release note.
 */
export function SudoPrompt({ remotePath, retry, onAnswer }: Props) {
  const [password, setPassword] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // The panel behind this had focus, so the field has to claim it or the
  // password is typed into whatever the Files panel does with keystrokes.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="animate-in fade-in absolute inset-0 z-50 flex items-center justify-center bg-black/60 duration-150">
      <form
        className="animate-in zoom-in-95 w-[26rem] space-y-3 rounded-lg border border-amber-500/25 bg-surface p-5 shadow-2xl duration-150"
        onSubmit={(e) => {
          e.preventDefault()
          onAnswer(password)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onAnswer(null)
          }
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
            // Never offered to a password manager: this is not the credential
            // for anything the browser has a concept of, and a saved entry here
            // would be filled into the SSH dialog later.
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
    </div>
  )
}
