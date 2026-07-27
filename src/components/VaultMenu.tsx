import { useEffect, useState } from 'react'
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
  // Null whenever nothing is enrolled, so the toggle's own on/off state
  // stays driven by `osUnlockOn` and this only ever adds detail.
  const [osUnlockMethod, setOsUnlockMethod] = useState<vault.OsUnlockMethod | null>(null)
  const [osUnlockBusy, setOsUnlockBusy] = useState(false)

  useEffect(() => {
    if (!open_) return
    setPassword('')
    setConfirmPassword('')
    setError(null)
    vault.osUnlockAvailable().then(setOsUnlockOn).catch(() => {})
    vault.osUnlockMethod().then(setOsUnlockMethod).catch(() => {})
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

  // Enrolment raises a Windows Hello prompt and blocks until it's answered.
  // Without this the checkbox is controlled by state that can't update until
  // that returns, so it silently snaps back and sits there looking broken —
  // which invites exactly the repeated clicking that used to queue up a
  // prompt per click.
  async function toggleOsUnlock(next: boolean) {
    if (osUnlockBusy) return
    setError(null)
    setOsUnlockBusy(true)
    try {
      if (next) await vault.enableOsUnlock()
      else await vault.disableOsUnlock()
      setOsUnlockOn(next)
      // Which method got enrolled is decided on the Rust side (Windows Hello
      // where the machine supports it, Credential Manager otherwise), so read
      // it back rather than assuming.
      setOsUnlockMethod(next ? await vault.osUnlockMethod() : null)
      // App.tsx tracks this too (for the session-picker's locked-vault
      // unlock prompt), so it needs to hear about the change as well.
      onStatusChange()
    } catch (err) {
      setError(String(err))
    } finally {
      setOsUnlockBusy(false)
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

  // Saved session profiles reference vault entries by id, and workspaces
  // reference session profiles by id — each is meaningless without the
  // others, so the export bundles all three. A plain `.wrv` (vault-only)
  // export from an older build isn't importable here anymore, hence the
  // distinct extension. The file dialog itself now runs Rust-side (the
  // backend won't accept a path from this process), so there's no `save()`
  // or `open()` call here; both helpers resolve `false` on cancel.
  async function doExport() {
    // Stated before the dialog, not after: only the credentials are
    // encrypted in the bundle. Hostnames, usernames, ports, key paths and
    // jump topology travel as readable JSON, and "vault export" doesn't
    // suggest that on its own.
    const ok = window.confirm(
      'The export protects your saved credentials with the vault\'s master password. Session details — hostnames, usernames, ports, key file paths — are stored in the file as plain text. Keep it somewhere you would keep that list. Continue?',
    )
    if (!ok) return
    try {
      if (!(await vault.exportVault())) return
      toast.success('Vault, saved sessions, and workspaces exported')
    } catch (err) {
      setError(String(err))
    }
  }

  async function doImport() {
    const ok = window.confirm(
      'Importing replaces the current vault, saved sessions, and workspaces. You will need the imported file\'s master password to unlock it. Continue?',
    )
    if (!ok) return
    try {
      if (!(await vault.importVault())) return
      onStatusChange()
      toast.info(
        'Vault, saved sessions, and workspaces imported — unlock the vault with its master password',
      )
    } catch (err) {
      setError(String(err))
    }
  }

  const Icon = status === 'unlocked' ? Unlock : Lock
  const iconColorClass =
    status === 'unlocked'
      ? 'text-emerald-400'
      : status === 'locked'
        ? 'text-red-400'
        : 'text-white/50 hover:text-white/90'

  return (
    <div className="relative" data-vault-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-white/10 ${iconColorClass}`}
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
              <p className="flex items-center gap-1.5 text-red-400/90">
                <Lock size={13} /> Vault is locked
              </p>
              {osUnlockOn && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={submitUnlockWithOs}
                    className={`${primaryButton} flex items-center justify-center gap-1.5`}
                  >
                    <Fingerprint size={13} />
                    {osUnlockMethod ? `Unlock with ${osUnlockMethod.label}` : 'Unlock with Windows sign-in'}
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
              <label
                className={`flex items-start gap-2 py-1 text-white/70 ${
                  osUnlockBusy ? 'cursor-wait opacity-60' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={osUnlockOn}
                  disabled={osUnlockBusy}
                  onChange={(e) => toggleOsUnlock(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Unlock without the master password
                  {/* Deliberately spells out which of the two methods is in
                      play and how strong it is. They are not equivalent: one
                      keeps the key in the TPM, the other in Credential
                      Manager where any process running as this user can read
                      it, and silently presenting both as "Windows sign-in"
                      would hide exactly the thing worth knowing. */}
                  {osUnlockBusy ? (
                    <span className="block text-sky-300/70">
                      Waiting for Windows Hello — answer the prompt to continue. It may open
                      behind this window.
                    </span>
                  ) : osUnlockOn && osUnlockMethod ? (
                    <span className="block text-white/40">
                      Using {osUnlockMethod.label}.{' '}
                      {/* Non-exportability is left unsaid on purpose: it's
                          true of every Hello credential, so stating it tells
                          the user nothing they can act on. What isn't obvious
                          is that the key is machine-bound, which is what they
                          actually hit when they move the vault. */}
                      {osUnlockMethod.protection === 'tpm-attested' && (
                        <span className="text-emerald-400/70">
                          Backed by this machine&apos;s TPM. Set up per machine — other devices need
                          your master password.
                        </span>
                      )}
                      {osUnlockMethod.protection === 'hello-unattested' && (
                        <span className="text-emerald-400/70">
                          Set up per machine — other devices need your master password.
                        </span>
                      )}
                      {osUnlockMethod.protection === 'credential-manager' && (
                        <span className="text-amber-400/70">
                          The key is stored in Windows Credential Manager, which other programs
                          running as you can read. Weaker than the master password alone.
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="block text-white/40">
                      Skips the master password, using Windows Hello where this machine supports it.
                    </span>
                  )}
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
