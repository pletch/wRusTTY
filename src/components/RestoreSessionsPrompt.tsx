import { useState } from 'react'
import { Lock, Fingerprint, RotateCcw } from 'lucide-react'

interface Props {
  count: number
  needsVaultUnlock: boolean
  osUnlockAvailable: boolean
  onRestore: () => void
  onUnlockAndRestore: (password: string) => Promise<void>
  onUnlockWithOsAndRestore: () => Promise<void>
  onDiscard: () => void
}

const inputClass =
  'rounded border border-white/10 bg-black/20 px-2 py-1.5 text-sm text-white/90 outline-none transition-colors duration-100 focus:border-sky-400/50'

export function RestoreSessionsPrompt({
  count,
  needsVaultUnlock,
  osUnlockAvailable,
  onRestore,
  onUnlockAndRestore,
  onUnlockWithOsAndRestore,
  onDiscard,
}: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submitUnlock(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onUnlockAndRestore(password)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function submitUnlockWithOs() {
    setBusy(true)
    setError(null)
    try {
      await onUnlockWithOsAndRestore()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="animate-in fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 duration-150">
      <div className="animate-in zoom-in-95 w-80 space-y-3 rounded-lg border border-white/10 bg-[#1f2028] p-5 shadow-2xl duration-150">
        <div className="flex items-center gap-2 text-white/90">
          <RotateCcw size={15} className="text-sky-400" />
          <span className="font-medium">
            Restore {count} session{count === 1 ? '' : 's'}?
          </span>
        </div>
        <p className="text-xs leading-relaxed text-white/50">
          {count === 1 ? 'A session was' : 'Sessions were'} open when wr-shell last closed.
        </p>

        {needsVaultUnlock ? (
          <form onSubmit={submitUnlock} className="space-y-3">
            {osUnlockAvailable && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={submitUnlockWithOs}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md bg-sky-500/90 py-1.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Fingerprint size={14} />
                  Unlock with Windows sign-in
                </button>
                <p className="flex items-center gap-2 text-white/30">
                  <span className="h-px flex-1 bg-white/10" /> or{' '}
                  <span className="h-px flex-1 bg-white/10" />
                </p>
              </>
            )}
            <input
              type="password"
              autoFocus
              placeholder="master password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${inputClass} w-full`}
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-sky-500/90 py-1.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Lock size={14} />
              Unlock & Restore
            </button>
            <button
              type="button"
              onClick={onDiscard}
              className="w-full text-center text-xs text-white/40 hover:text-white/70"
            >
              Cancel — start fresh instead
            </button>
          </form>
        ) : (
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onDiscard}
              className="rounded px-3 py-1.5 text-xs text-white/70 transition-colors duration-100 hover:bg-white/10"
            >
              Start fresh
            </button>
            <button
              onClick={onRestore}
              className="rounded bg-sky-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-100 hover:bg-sky-500"
            >
              Restore
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
