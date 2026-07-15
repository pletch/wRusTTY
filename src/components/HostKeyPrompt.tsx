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
    <div className="absolute inset-0 flex items-center justify-center bg-black/60">
      <div
        className={`w-96 space-y-3 rounded-lg border p-5 ${
          isChanged
            ? 'border-red-500/50 bg-red-950/80'
            : 'border-white/10 bg-[#1f2028]'
        }`}
      >
        <h1 className="text-sm font-semibold text-white">
          {isChanged ? '⚠ Host key has changed' : 'Unknown host'}
        </h1>

        <p className="text-xs text-white/80">
          The authenticity of host{' '}
          <span className="font-mono text-white">
            {host}:{port}
          </span>{' '}
          {isChanged ? 'does not match the key on record' : "can't be established"}.
        </p>

        <p className="rounded bg-black/30 p-2 font-mono text-xs text-white/80">
          {fingerprint}
        </p>

        {isChanged && (
          <p className="text-xs text-red-300">
            This could mean the server was reconfigured, or someone is
            intercepting your connection. Do not accept unless you can verify
            this fingerprint through another channel.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            className="rounded px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
            onClick={() => onAnswer(false)}
          >
            Reject
          </button>
          <button
            className={`rounded px-3 py-1.5 text-xs text-white ${
              isChanged ? 'bg-red-600 hover:bg-red-500' : 'bg-white/10 hover:bg-white/20'
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
