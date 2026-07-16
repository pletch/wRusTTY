import { useEffect, useState } from 'react'
import { save, open } from '@tauri-apps/plugin-dialog'
import { Lock, Unlock, Download, Upload, Fingerprint, Trash2 } from 'lucide-react'
import * as vault from '../lib/vault'
import type { VaultStatus } from '../lib/vault'
import { toast } from '../lib/toast'

interface Props {
  status: VaultStatus
  onStatusChange: () => void
}

const fieldClass =
  'w-full rounded border border-white/10 bg-black/20 px-2 py-1.5 text-white/90 outline-none transition-colors duration-100 focus:border-sky-400/50'
const primaryButton =
  'w-full rounded bg-sky-500/90 py-1.5 font-medium text-white transition-colors duration-100 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50'
const secondaryButton =
  'flex w-full items-center gap-1.5 rounded py-1.5 text-white/60 transition-colors duration-100 hover:bg-white/10 hover:text-white/90'

export function VaultMenu({ status, onStatusChange }: Props) {
  const [open_, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [osUnlockOn, setOsUnlockOn] = useState(false)

  useEffect(() => {
    if (!open_) return
    setPassword('')
    setConfirmPassword('')
    setError(null)
    vault.osUnlockAvailable().then(setOsUnlockOn).catch(() => {})
  }, [open_, status])

  useEffect(() => {
    if (!open_) return
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-vault-menu]')) setOpen(false)
    }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open_])

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    if (password.length < 8) {
      setError('Use at least 8 characters')
      return
    }
    setBusy(true)
    try {
      await vault.create(password)
      onStatusChange()
      setOpen(false)
      toast.success('Vault created and unlocked')
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function submitUnlock(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await vault.unlock(password)
      onStatusChange()
      setOpen(false)
      toast.success('Vault unlocked')
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function submitUnlockWithOs() {
    setBusy(true)
    try {
      await vault.unlockWithOs()
      onStatusChange()
      setOpen(false)
      toast.success('Vault unlocked')
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function toggleOsUnlock(next: boolean) {
    setError(null)
    try {
      if (next) await vault.enableOsUnlock()
      else await vault.disableOsUnlock()
      setOsUnlockOn(next)
      // App.tsx tracks this too (for the session-picker's locked-vault
      // unlock prompt), so it needs to hear about the change as well.
      onStatusChange()
    } catch (err) {
      setError(String(err))
    }
  }

  async function doLock() {
    await vault.lock().catch(() => {})
    onStatusChange()
    setOpen(false)
    toast.info('Vault locked')
  }

  async function doDelete() {
    const ok = window.confirm(
      'Permanently delete the vault? Every credential stored in it will be lost — this cannot be undone. Saved sessions themselves are kept, just without their stored credentials.',
    )
    if (!ok) return
    try {
      await vault.deleteVault()
      onStatusChange()
      setOpen(false)
      toast.info('Vault deleted')
    } catch (err) {
      setError(String(err))
    }
  }

  async function doExport() {
    const dest = await save({
      defaultPath: 'wr-shell-export.wrb',
      // Saved session profiles reference vault entries by id and are
      // meaningless without each other, so the export bundles both — a
      // plain `.wrv` (vault-only) export from an older build isn't
      // importable here anymore, hence the distinct extension.
      filters: [{ name: 'wr-shell export bundle', extensions: ['wrb'] }],
    })
    if (!dest) return
    try {
      await vault.exportVault(dest)
      toast.success('Vault and saved sessions exported')
    } catch (err) {
      setError(String(err))
    }
  }

  async function doImport() {
    const src = await open({
      multiple: false,
      filters: [{ name: 'wr-shell export bundle', extensions: ['wrb'] }],
    })
    if (!src || Array.isArray(src)) return
    const ok = window.confirm(
      'Importing replaces the current vault and saved sessions. You will need the imported file\'s master password to unlock it. Continue?',
    )
    if (!ok) return
    try {
      await vault.importVault(src)
      onStatusChange()
      toast.info('Vault and saved sessions imported — unlock the vault with its master password')
    } catch (err) {
      setError(String(err))
    }
  }

  const Icon = status === 'unlocked' ? Unlock : Lock

  return (
    <div className="relative" data-vault-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-white/10 ${
          status === 'unlocked' ? 'text-emerald-400' : 'text-white/50 hover:text-white/90'
        }`}
        title={`Vault: ${status}`}
      >
        <Icon size={15} strokeWidth={2} />
      </button>
      {open_ && (
        <div
          className="animate-in fade-in slide-in-from-top-1 absolute right-0 top-full z-50 mt-1.5 w-72 origin-top-right rounded-lg border border-white/10 bg-[#1f2028] p-3 text-xs shadow-xl duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          {status === 'uninitialized' && (
            <form onSubmit={submitCreate} className="space-y-2">
              <p className="text-white/60">
                Create a master password to encrypt saved credentials.
              </p>
              <input
                type="password"
                autoFocus
                placeholder="master password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={fieldClass}
              />
              <input
                type="password"
                placeholder="confirm password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={fieldClass}
              />
              {error && <p className="text-red-400">{error}</p>}
              <button type="submit" disabled={busy} className={primaryButton}>
                Create vault
              </button>
              <button type="button" onClick={doImport} className={secondaryButton}>
                <Upload size={13} /> Import existing vault...
              </button>
            </form>
          )}

          {status === 'locked' && (
            <form onSubmit={submitUnlock} className="space-y-2">
              {osUnlockOn && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={submitUnlockWithOs}
                    className={`${primaryButton} flex items-center justify-center gap-1.5`}
                  >
                    <Fingerprint size={13} /> Unlock with Windows sign-in
                  </button>
                  <p className="flex items-center gap-2 text-white/30">
                    <span className="h-px flex-1 bg-white/10" /> or <span className="h-px flex-1 bg-white/10" />
                  </p>
                </>
              )}
              <p className="text-white/60">Enter your master password to unlock.</p>
              <input
                type="password"
                autoFocus
                placeholder="master password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={fieldClass}
              />
              {error && <p className="text-red-400">{error}</p>}
              <button type="submit" disabled={busy} className={primaryButton}>
                Unlock
              </button>
              <button type="button" onClick={doImport} className={secondaryButton}>
                <Upload size={13} /> Import a different vault...
              </button>
              <button
                type="button"
                onClick={doDelete}
                className={`${secondaryButton} text-red-300/90 hover:text-red-300`}
              >
                <Trash2 size={13} /> Delete vault...
              </button>
            </form>
          )}

          {status === 'unlocked' && (
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-emerald-400/90">
                <Unlock size={13} /> Vault is unlocked
              </p>
              <label className="flex items-start gap-2 py-1 text-white/70">
                <input
                  type="checkbox"
                  checked={osUnlockOn}
                  onChange={(e) => toggleOsUnlock(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Unlock with Windows sign-in
                  <span className="block text-white/40">
                    Skips the master password — each unlock still requires a
                    fresh Windows Hello/PIN check instead of Argon2.
                  </span>
                </span>
              </label>
              {error && <p className="text-red-400">{error}</p>}
              <button onClick={doLock} className={primaryButton}>
                Lock now
              </button>
              <button onClick={doExport} className={secondaryButton}>
                <Download size={13} /> Export vault & sessions...
              </button>
              <button onClick={doImport} className={secondaryButton}>
                <Upload size={13} /> Import vault & sessions...
              </button>
              <button
                onClick={doDelete}
                className={`${secondaryButton} text-red-300/90 hover:text-red-300`}
              >
                <Trash2 size={13} /> Delete vault...
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
