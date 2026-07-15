import { ShieldAlert, ShieldQuestion, KeyRound } from 'lucide-react'

interface Props {
  host: string
  port: number
  fingerprint: string
  status: 'unknown' | 'changed'
  onAnswer: (accept: boolean) => void
}

export function HostKeyPrompt({ host, port, fingerprint, status, onAnswer }: Props) {
  const isChanged = status === 'changed'

  return (
    <div className="animate-in fade-in absolute inset-0 z-50 flex items-center justify-center bg-black/60 duration-150">
      <div
        className={`animate-in zoom-in-95 w-96 space-y-3 rounded-lg border p-5 shadow-2xl duration-150 ${
          isChanged ? 'border-red-500/50 bg-red-950/80' : 'border-white/10 bg-[#1f2028]'
        }`}
      >
        <h1 className="flex items-center gap-2 text-sm font-semibold text-white">
          {isChanged ? (
            <ShieldAlert size={16} className="text-red-400" />
          ) : (
            <ShieldQuestion size={16} className="text-amber-400" />
          )}
          {isChanged ? 'Host key has changed' : 'Unknown host'}
        </h1>

        <p className="text-xs text-white/80">
          The authenticity of host{' '}
          <span className="font-mono text-white">
            {host}:{port}
          </span>{' '}
          {isChanged ? 'does not match the key on record' : "can't be established"}.
        </p>

        <p className="flex items-center gap-2 rounded bg-black/30 p-2 font-mono text-xs text-white/80">
          <KeyRound size={12} className="shrink-0 text-white/40" />
          <span className="break-all">{fingerprint}</span>
        </p>

        {isChanged && (
          <p className="text-xs leading-relaxed text-red-300">
            This could mean the server was reconfigured, or someone is
            intercepting your connection. Do not accept unless you can verify
            this fingerprint through another channel.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            className="rounded px-3 py-1.5 text-xs text-white/70 transition-colors duration-100 hover:bg-white/10"
            onClick={() => onAnswer(false)}
          >
            Reject
          </button>
          <button
            className={`rounded px-3 py-1.5 text-xs font-medium text-white transition-colors duration-100 ${
              isChanged ? 'bg-red-600 hover:bg-red-500' : 'bg-sky-500/90 hover:bg-sky-500'
            }`}
            onClick={() => onAnswer(true)}
          >
            {isChanged ? 'Accept anyway' : 'Accept & connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
