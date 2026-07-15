import { useEffect, useState } from 'react'
import { save, open } from '@tauri-apps/plugin-dialog'
import { Lock, Unlock, Download, Upload } from 'lucide-react'
import * as vault from '../lib/vault'
import type { VaultStatus } from '../lib/vault'

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

  useEffect(() => {
    if (!open_) return
    setPassword('')
    setConfirmPassword('')
    setError(null)
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
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function doLock() {
    await vault.lock().catch(() => {})
    onStatusChange()
    setOpen(false)
  }

  async function doExport() {
    const dest = await save({
      defaultPath: 'wr-shell-vault.wrv',
      filters: [{ name: 'wr-shell vault', extensions: ['wrv'] }],
    })
    if (!dest) return
    try {
      await vault.exportVault(dest)
    } catch (err) {
      setError(String(err))
    }
  }

  async function doImport() {
    const src = await open({
      multiple: false,
      filters: [{ name: 'wr-shell vault', extensions: ['wrv'] }],
    })
    if (!src || Array.isArray(src)) return
    const ok = window.confirm(
      'Importing replaces the current vault file. You will need the imported file\'s master password to unlock it. Continue?',
    )
    if (!ok) return
    try {
      await vault.importVault(src)
      onStatusChange()
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
            </form>
          )}

          {status === 'unlocked' && (
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-emerald-400/90">
                <Unlock size={13} /> Vault is unlocked
              </p>
              {error && <p className="text-red-400">{error}</p>}
              <button onClick={doLock} className={primaryButton}>
                Lock now
              </button>
              <button onClick={doExport} className={secondaryButton}>
                <Download size={13} /> Export vault file...
              </button>
              <button onClick={doImport} className={secondaryButton}>
                <Upload size={13} /> Import vault file...
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
