import { useState } from 'react'
import { Lock, Fingerprint, RotateCcw, ShieldCheck } from 'lucide-react'
import { WindowDragStrip } from './WindowDragStrip'

interface Props {
  count: number
  /** How many of `count` are administrator tabs, which come back waiting for
   * a UAC approval rather than connected. Named in the prompt so the total
   * matches the tabs that appear. */
  awaitingElevation?: number
  needsVaultUnlock: boolean
  osUnlockAvailable: boolean
  onRestore: () => void
  onUnlockAndRestore: (password: string) => Promise<void>
  onUnlockWithOsAndRestore: () => Promise<void>
  onDiscard: () => void
  /** Overrides the launch-restore wording when these sessions come from
   * somewhere else — a saved workspace opened mid-run. The mechanics are
   * identical (same vault gate, same unlock paths), only the sentence
   * differs, so this reuses the component rather than cloning it. */
  title?: string
  body?: string
  cancelLabel?: string
  /** The unlock button's verb, for callers whose action isn't a restore —
   * "Unlock & Reconnect" on the reconnect gate. Only wording; the button
   * still runs onUnlockAndRestore. */
  submitLabel?: string
}

const inputClass =
  'rounded border border-chrome/10 bg-black/20 px-2 py-1.5 text-sm text-chrome/90 outline-none transition-colors duration-100 focus:border-sky-400/50'

export function RestoreSessionsPrompt({
  count,
  awaitingElevation = 0,
  needsVaultUnlock,
  osUnlockAvailable,
  onRestore,
  onUnlockAndRestore,
  onUnlockWithOsAndRestore,
  onDiscard,
  title,
  body,
  cancelLabel,
  submitLabel,
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
      <WindowDragStrip />
      <div className="animate-in zoom-in-95 relative w-80 space-y-3 rounded-lg border border-chrome/10 bg-surface p-5 shadow-2xl duration-150">
        <div className="flex items-center gap-2 text-chrome/90">
          <RotateCcw size={15} className="text-sky-400" />
          <span className="font-medium">
            {title ?? `Restore ${count} session${count === 1 ? '' : 's'}?`}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-chrome/50">
          {body ??
            `${count === 1 ? 'A session was' : 'Sessions were'} open when wRusTTY last closed.`}
        </p>
        {awaitingElevation > 0 && (
          <p className="flex items-start gap-1.5 text-xs leading-relaxed text-chrome/50">
            <ShieldCheck size={13} className="mt-px shrink-0 text-amber-400" />
            <span>
              {awaitingElevation === 1
                ? count === 1
                  ? 'It is an administrator tab, and waits for you to approve it before it opens.'
                  : '1 of them is an administrator tab, and waits for you to approve it before it opens.'
                : `${awaitingElevation} of them are administrator tabs, and wait for you to approve each before it opens.`}
            </span>
          </p>
        )}

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
                <p className="flex items-center gap-2 text-chrome/30">
                  <span className="h-px flex-1 bg-chrome/10" /> or{' '}
                  <span className="h-px flex-1 bg-chrome/10" />
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
              {submitLabel ?? 'Unlock & Restore'}
            </button>
            <button
              type="button"
              onClick={onDiscard}
              className="w-full text-center text-xs text-chrome/40 hover:text-chrome/70"
            >
              {cancelLabel ?? 'Cancel — start fresh instead'}
            </button>
          </form>
        ) : (
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onDiscard}
              className="rounded px-3 py-1.5 text-xs text-chrome/70 transition-colors duration-100 hover:bg-chrome/10"
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
