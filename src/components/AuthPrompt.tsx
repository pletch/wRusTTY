import { useEffect, useRef, useState } from 'react'
import { KeyRound, ServerCog } from 'lucide-react'
import type { AuthPromptField } from '../lib/connection'

interface Props {
  name: string
  instructions: string
  fields: AuthPromptField[]
  host: string
  port: number
  isJump: boolean
  /** One response per field, in order, or `null` to cancel. */
  onAnswer: (responses: string[] | null) => void
}

/**
 * One round of keyboard-interactive (RFC 4256) authentication.
 *
 * Everything on screen except the heading comes from the server: this is the
 * method where the server decides what to ask, so the prompts are rendered
 * verbatim rather than reworded. "Password:" and "Verification code:" arrive
 * through the same channel and are told apart only by their own text.
 *
 * Deliberately not routed through `useDismissable`, for the same reason
 * `HostKeyPrompt` isn't: a handshake is parked on this answer, and a stray
 * click-away that silently cancels reads as a connection that failed for no
 * reason. Escape still cancels, but explicitly.
 */
export function AuthPrompt({
  name,
  instructions,
  fields,
  host,
  port,
  isJump,
  onAnswer,
}: Props) {
  const [values, setValues] = useState<string[]>(() => fields.map(() => ''))
  const firstInputRef = useRef<HTMLInputElement>(null)

  // The pane behind this has focus (the terminal grabs it as soon as a session
  // id comes back, which for an interactive login is well before the handshake
  // finishes), so the first field has to claim it or the user types their
  // password into the terminal underneath.
  useEffect(() => {
    firstInputRef.current?.focus()
  }, [])

  return (
    <div className="animate-in fade-in absolute inset-0 z-50 flex items-center justify-center bg-black/60 duration-150">
      <form
        className="animate-in zoom-in-95 w-96 space-y-3 rounded-lg border border-white/10 bg-[#1f2028] p-5 shadow-2xl duration-150"
        onSubmit={(e) => {
          e.preventDefault()
          onAnswer(values)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onAnswer(null)
          }
        }}
      >
        <h1 className="flex items-center gap-2 text-sm font-semibold text-white">
          <ServerCog size={16} className="text-sky-400" />
          {name.trim() || 'Authentication required'}
        </h1>

        {/* Which host is asking is not decoration. A jumped connection
            authenticates twice with prompts that can be word-for-word
            identical, and without this the target's password gets typed into
            the bastion. */}
        <p className="text-xs text-white/60">
          {isJump ? 'Jump host' : 'Server'}{' '}
          <span className="font-mono text-white/80">
            {host}:{port}
          </span>{' '}
          is asking:
        </p>

        {instructions.trim() && (
          <p className="whitespace-pre-wrap rounded bg-black/30 p-2 text-xs leading-relaxed text-white/70">
            {instructions.trim()}
          </p>
        )}

        <div className="space-y-2">
          {fields.map((field, i) => (
            <label key={i} className="block space-y-1">
              <span className="flex items-center gap-1.5 text-[11px] text-white/60">
                <KeyRound size={11} className="shrink-0 text-white/40" />
                {/* Verbatim, trailing colon and all — rewording it would be
                    guessing at a PAM stack we can't see. */}
                <span className="font-mono">{field.prompt.trim() || `Response ${i + 1}`}</span>
              </span>
              <input
                ref={i === 0 ? firstInputRef : undefined}
                // The server tells us which of these is a secret; it is not
                // ours to guess. A visible TOTP code is fine and a visible
                // password is not, and only `echo` knows which this is.
                type={field.echo ? 'text' : 'password'}
                value={values[i]}
                onChange={(e) =>
                  setValues((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                }
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-xs text-white outline-none focus:border-sky-500/60"
              />
            </label>
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs text-white/70 transition-colors duration-100 hover:bg-white/10"
            onClick={() => onAnswer(null)}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-sky-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-100 hover:bg-sky-500"
          >
            Submit
          </button>
        </div>
      </form>
    </div>
  )
}
