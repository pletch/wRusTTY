import { useEffect, useState } from 'react'
import { KeyRound, Lock, Unlock, Upload, Fingerprint, Trash2 } from 'lucide-react'
import * as vault from '../lib/vault'
import type { VaultStatus } from '../lib/vault'
import { toast } from '../lib/toast'
import { useDismissable } from '../hooks/useDismissable'
import { useConfirm } from './confirmContext'
import { importVaultBundle } from '../lib/vaultTransfer'
import { PasswordField } from './PasswordField'
import { isAndroid, osUnlockButtonLabel } from '../lib/platform'

interface Props {
  status: VaultStatus
  onStatusChange: () => void
}

const fieldClass =
  'w-full rounded border border-chrome/10 bg-black/20 px-2 py-1.5 text-chrome/90 outline-none transition-colors duration-100 focus:border-sky-400/50'
const primaryButton =
  'w-full rounded bg-sky-500/90 py-1.5 font-medium text-white transition-colors duration-100 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50'
const secondaryButton =
  'flex w-full items-center gap-1.5 rounded py-1.5 text-chrome/60 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/90'

export function VaultMenu({ status, onStatusChange }: Props) {
  const confirm = useConfirm()
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
  // A reset first proves it's you, then chooses the new password.
  const [resetStep, setResetStep] = useState<'verify' | 'choose' | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')

  useEffect(() => {
    if (!open_) return
    setPassword('')
    setConfirmPassword('')
    setCurrentPassword('')
    setResetStep(null)
    setError(null)
    vault.osUnlockAvailable().then(setOsUnlockOn).catch(() => {})
    vault.osUnlockMethod().then(setOsUnlockMethod).catch(() => {})
  }, [open_, status])

  useDismissable(open_, () => setOpen(false), { within: '[data-vault-menu]' })

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

  // Enrollment blocks on a Windows Hello prompt; reflect the click right away
  // so the checkbox doesn't snap back and invite repeated clicks.
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

  function endReset() {
    setResetStep(null)
    setCurrentPassword('')
    setPassword('')
    setConfirmPassword('')
    setError(null)
  }

  /** `current` null is the Windows Hello or biometric route. */
  async function proveOwnership(current: string | null) {
    setError(null)
    setBusy(true)
    try {
      await vault.beginMasterPasswordReset(current)
      setCurrentPassword('')
      setResetStep('choose')
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault()
    if (!password) {
      setError('Enter a new master password')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    setError(null)
    setBusy(true)
    try {
      await vault.resetMasterPassword(password)
      endReset()
      toast.success('Master password reset')
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
    toast.info('Vault locked')
  }

  async function doDelete() {
    const ok = await confirm({
      title: 'Delete the vault?',
      body: 'Every credential stored in it will be lost — this cannot be undone. Saved sessions themselves are kept, just without their stored credentials.',
      confirmLabel: 'Delete vault',
    })
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

  // The bundle carries vault, sessions and workspaces together (each
  // references the next by id), hence its own extension. The file dialogs run
  // Rust-side; both helpers resolve `false` on cancel.
  async function doImport() {
    if (await importVaultBundle(confirm)) onStatusChange()
  }

  const Icon = status === 'unlocked' ? Unlock : Lock
  const iconColorClass =
    status === 'unlocked'
      ? 'text-emerald-400'
      : status === 'locked'
        ? 'text-red-400'
        : 'text-chrome/50 hover:text-chrome/90'

  return (
    <div className="relative" data-vault-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-chrome/10 ${iconColorClass}`}
        title={`Vault: ${status}`}
      >
        <Icon size={15} strokeWidth={2} />
      </button>
      {open_ && (
        <div
          className="animate-in fade-in slide-in-from-top-1 absolute right-0 top-full z-50 mt-1.5 w-72 origin-top-right rounded-lg border border-chrome/10 bg-surface p-3 text-xs shadow-xl duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          {status === 'uninitialized' && (
            <form onSubmit={submitCreate} className="space-y-2">
              <p className="text-chrome/60">
                Create a master password to encrypt saved credentials.
              </p>
              <PasswordField
                autoFocus
                placeholder="master password"
                value={password}
                onChange={setPassword}
                className={fieldClass}
              />
              <PasswordField
                placeholder="confirm password"
                value={confirmPassword}
                onChange={setConfirmPassword}
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
                    {osUnlockMethod
                      ? `Unlock with ${osUnlockMethod.label}`
                      : osUnlockButtonLabel()}
                  </button>
                  <p className="flex items-center gap-2 text-chrome/30">
                    <span className="h-px flex-1 bg-chrome/10" /> or <span className="h-px flex-1 bg-chrome/10" />
                  </p>
                </>
              )}
              <p className="text-chrome/60">Enter your master password to unlock.</p>
              <PasswordField
                autoFocus
                placeholder="master password"
                value={password}
                onChange={setPassword}
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
                className={`flex items-start gap-2 py-1 text-chrome/70 ${
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
                      {isAndroid
                        ? 'Confirm with your fingerprint or face to continue.'
                        : 'Waiting for Windows Hello — answer the prompt to continue. It may open behind this window.'}
                    </span>
                  ) : osUnlockOn && osUnlockMethod ? (
                    <span className="block text-chrome/40">
                      Using {osUnlockMethod.label}.{' '}
                      {/* Non-exportability is left unsaid on purpose: it's
                          true of every Hello credential, so stating it tells
                          the user nothing they can act on. What isn't obvious
                          is that the key is machine-bound, which is what they
                          actually hit when they move the vault. */}
                      {osUnlockMethod.protection === 'android-keystore' && (
                        <span className="text-emerald-400/70">
                          Protected by this phone&apos;s secure hardware. Other devices need your
                          master password, and so does this one if its fingerprints or face change.
                        </span>
                      )}
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
                    <span className="block text-chrome/40">
                      {isAndroid
                        ? 'Skips the master password, using your fingerprint or face.'
                        : 'Skips the master password, using Windows Hello where this machine supports it.'}
                    </span>
                  )}
                </span>
              </label>
              {error && !resetStep && <p className="text-red-400">{error}</p>}
              {resetStep === 'verify' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (currentPassword) void proveOwnership(currentPassword)
                    else setError('Enter your current master password')
                  }}
                  className="space-y-2 border-t border-chrome/10 pt-2"
                >
                  <p className="text-chrome/60">Confirm it&apos;s you to reset the master password.</p>
                  <PasswordField
                    autoFocus
                    placeholder="current master password"
                    value={currentPassword}
                    onChange={setCurrentPassword}
                    className={fieldClass}
                  />
                  {error && <p className="text-red-400">{error}</p>}
                  <button type="submit" disabled={busy} className={primaryButton}>
                    Continue
                  </button>
                  {osUnlockOn && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => proveOwnership(null)}
                      className={secondaryButton}
                    >
                      <Fingerprint size={13} /> Use {osUnlockMethod?.label ?? 'device unlock'} instead
                    </button>
                  )}
                  <button type="button" onClick={endReset} className={secondaryButton}>
                    Cancel
                  </button>
                </form>
              )}
              {resetStep === 'choose' && (
                <form onSubmit={submitReset} className="space-y-2 border-t border-chrome/10 pt-2">
                  <p className="text-chrome/60">Choose a new master password.</p>
                  <PasswordField
                    autoFocus
                    placeholder="new master password"
                    value={password}
                    onChange={setPassword}
                    className={fieldClass}
                  />
                  <PasswordField
                    placeholder="confirm new password"
                    value={confirmPassword}
                    onChange={setConfirmPassword}
                    className={fieldClass}
                  />
                  <p className="text-chrome/40">
                    Can&apos;t be recovered if forgotten. Exports you already made keep the old
                    password.
                  </p>
                  {error && <p className="text-red-400">{error}</p>}
                  <button type="submit" disabled={busy} className={primaryButton}>
                    Reset master password
                  </button>
                  <button type="button" onClick={endReset} className={secondaryButton}>
                    Cancel
                  </button>
                </form>
              )}
              {!resetStep && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null)
                    setResetStep('verify')
                  }}
                  className={secondaryButton}
                >
                  <KeyRound size={13} /> Reset master password...
                </button>
              )}
              <button onClick={doLock} className={primaryButton}>
                Lock now
              </button>
              {/* Export and import live in Settings -> Backup & import now.
                  This menu is about lock state; a padlock icon is not where
                  anyone looks for "how do I back this up". The locked and
                  uninitialized states below keep an import, because that is a
                  recovery path for someone who cannot get in at all, and
                  sending them to Settings from a dead end would be hostile. */}
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
