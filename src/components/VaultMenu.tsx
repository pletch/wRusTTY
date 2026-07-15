import { useEffect, useState } from 'react'
import { save, open } from '@tauri-apps/plugin-dialog'
import * as vault from '../lib/vault'
import type { VaultStatus } from '../lib/vault'

interface Props {
  status: VaultStatus
  onStatusChange: () => void
}

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

  const icon = status === 'unlocked' ? '🔓' : '🔒'

  return (
    <div className="relative" data-vault-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-2 text-white/50 hover:text-white/90"
        title={`Vault: ${status}`}
      >
        {icon}
      </button>
      {open_ && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-72 rounded border border-white/10 bg-[#1f2028] p-3 text-xs shadow-lg"
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
                className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-white/90 outline-none focus:border-white/30"
              />
              <input
                type="password"
                placeholder="confirm password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-white/90 outline-none focus:border-white/30"
              />
              {error && <p className="text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded bg-white/10 py-1.5 text-white/90 hover:bg-white/20 disabled:opacity-50"
              >
                Create vault
              </button>
              <button
                type="button"
                onClick={doImport}
                className="w-full rounded py-1 text-white/50 hover:bg-white/10"
              >
                Import existing vault...
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
                className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-white/90 outline-none focus:border-white/30"
              />
              {error && <p className="text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded bg-white/10 py-1.5 text-white/90 hover:bg-white/20 disabled:opacity-50"
              >
                Unlock
              </button>
              <button
                type="button"
                onClick={doImport}
                className="w-full rounded py-1 text-white/50 hover:bg-white/10"
              >
                Import a different vault...
              </button>
            </form>
          )}

          {status === 'unlocked' && (
            <div className="space-y-2">
              <p className="text-white/60">Vault is unlocked.</p>
              {error && <p className="text-red-400">{error}</p>}
              <button
                onClick={doLock}
                className="w-full rounded bg-white/10 py-1.5 text-white/90 hover:bg-white/20"
              >
                Lock now
              </button>
              <button
                onClick={doExport}
                className="w-full rounded py-1 text-left text-white/70 hover:bg-white/10"
              >
                Export vault file...
              </button>
              <button
                onClick={doImport}
                className="w-full rounded py-1 text-left text-white/70 hover:bg-white/10"
              >
                Import vault file...
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
