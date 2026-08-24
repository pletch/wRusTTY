import { ShieldAlert, ShieldQuestion, KeyRound } from 'lucide-react'

interface Props {
  host: string
  port: number
  fingerprint: string
  status: 'unknown' | 'changed'
  /** For 'changed' only: the fingerprint previously on record. */
  storedFingerprint: string | null
  onAnswer: (accept: boolean) => void
}

export function HostKeyPrompt({
  host,
  port,
  fingerprint,
  status,
  storedFingerprint,
  onAnswer,
}: Props) {
  const isChanged = status === 'changed'

  return (
    <div className="animate-in fade-in absolute inset-0 z-50 flex items-center justify-center bg-black/60 duration-150">
      <div
        className={`animate-in zoom-in-95 w-96 space-y-3 rounded-lg border p-5 shadow-2xl duration-150 ${
          // The alarm state is a red wash *over* the surface rather than a
          // fixed near-black red, for the reason every other panel here
          // stopped being a fixed dark hex: `text-chrome` turns black on a
          // light theme, and black on red-950 is the warning nobody can
          // read. As a colour plus a one-stop gradient, not one shorthand —
          // Chrome keeps the gradient and drops the colour if they are
          // written together (see tabHoverWash).
          isChanged
            ? 'border-red-500/50 bg-surface bg-gradient-to-b from-red-500/20 to-red-500/20'
            : 'border-chrome/10 bg-surface'
        }`}
      >
        <h1 className="flex items-center gap-2 text-sm font-semibold text-chrome">
          {isChanged ? (
            <ShieldAlert size={16} className="text-red-400" />
          ) : (
            <ShieldQuestion size={16} className="text-amber-400" />
          )}
          {isChanged ? 'Host key has changed' : 'Unknown host'}
        </h1>

        <p className="text-xs text-chrome/80">
          The authenticity of host{' '}
          <span className="font-mono text-chrome">
            {host}:{port}
          </span>{' '}
          {isChanged ? 'does not match the key on record' : "can't be established"}.
        </p>

        {isChanged && storedFingerprint && (
          <div className="space-y-1">
            <p className="text-[11px] uppercase tracking-wide text-chrome/40">Key on record</p>
            <p className="flex items-center gap-2 rounded bg-black/30 p-2 font-mono text-xs text-chrome/60">
              <KeyRound size={12} className="shrink-0 text-chrome/40" />
              <span className="break-all line-through decoration-red-400/50">
                {storedFingerprint}
              </span>
            </p>
            <p className="text-[11px] uppercase tracking-wide text-chrome/40">Offered now</p>
          </div>
        )}
        <p className="flex items-center gap-2 rounded bg-black/30 p-2 font-mono text-xs text-chrome/80">
          <KeyRound size={12} className="shrink-0 text-chrome/40" />
          <span className="break-all">{fingerprint}</span>
        </p>

        {isChanged && (
          <p className="text-xs leading-relaxed text-red-300">
            This could mean the server was reconfigured, or someone is
            intercepting your connection. Do not accept unless you can verify
            this fingerprint through another channel.
          </p>
        )}

        {/* On `changed`, the emphasis is inverted against every other dialog
            in the app: Reject takes the filled primary slot, and accepting
            becomes the ghost. A red-filled Accept reads as "this is the
            important button" at least as much as it reads "danger", and this
            is the one dialog where the button muscle memory lands on has to
            be the safe one. Danger still gets said — in red text on the
            action that carries it — it just stops being said with emphasis.

            `unknown` deliberately keeps the ordinary arrangement. A
            first-connect TOFU prompt is routine and accepting is the expected
            answer; adding friction there is how people get trained to click
            straight through the one above. */}
        <div className="flex justify-end gap-2 pt-1">
          {isChanged ? (
            <>
              <button
                className="rounded px-3 py-1.5 text-xs text-red-300/90 transition-colors duration-100 hover:bg-red-500/15"
                onClick={() => onAnswer(true)}
              >
                Accept anyway
              </button>
              <button
                className="rounded bg-sky-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-100 hover:bg-sky-500"
                onClick={() => onAnswer(false)}
              >
                Reject
              </button>
            </>
          ) : (
            <>
              <button
                className="rounded px-3 py-1.5 text-xs text-chrome/70 transition-colors duration-100 hover:bg-chrome/10"
                onClick={() => onAnswer(false)}
              >
                Reject
              </button>
              <button
                className="rounded bg-sky-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-100 hover:bg-sky-500"
                onClick={() => onAnswer(true)}
              >
                Accept &amp; connect
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
