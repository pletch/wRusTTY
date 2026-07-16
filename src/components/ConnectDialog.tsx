import { useEffect, useState } from 'react'
import {
  Terminal as TerminalIcon,
  Radio,
  Cable,
  Save,
  Plug,
  Folder,
  Server,
  Lock,
  Pencil,
  Trash2,
  Fingerprint,
} from 'lucide-react'
import type { AuthMethod } from '../lib/ssh'
import type { SessionProfile } from '../lib/profiles'
import type { VaultSecret } from '../lib/vault'
import type { ConnectionSource } from '../lib/connection'
import { defaultSerialConfig } from '../lib/serial'
import { SerialFields } from './SerialFields'

export interface ConnectDialogInitial {
  id?: string
  label?: string
  host?: string
  port?: number
  username?: string
  authType?: 'Password' | 'PublicKey'
  keyPath?: string
  folder?: string | null
  hasCredential?: boolean
}

interface Props {
  onConnect: (source: ConnectionSource) => void
  onSaveProfile?: (profile: SessionProfile) => void
  onSaveCredential?: (profileId: string, secret: VaultSecret) => void
  vaultUnlocked?: boolean
  initial?: ConnectDialogInitial
  error?: string | null
  /** Saved sessions shown in a sidebar alongside the manual connect form —
   * picking one calls onSelectSession instead of prefilling anything here
   * directly, since the parent may skip this form entirely (e.g. a stored
   * vault credential lets it connect right away). */
  sessions?: SessionProfile[]
  onSelectSession?: (profile: SessionProfile) => void
  /** Populates the form from this profile without ever auto-connecting,
   * even if the vault already holds its credential — the only way to edit
   * a session's saved details rather than just reuse them. */
  onEditSession?: (profile: SessionProfile) => void
  onDeleteSession?: (profile: SessionProfile) => void
  /** A session with a stored credential picked while the vault is locked
   * prompts for the master password inline instead of just falling back to
   * the manual form — this unlocks the vault and then behaves like
   * onSelectSession would have if it had been unlocked all along. */
  onUnlockAndSelectSession?: (profile: SessionProfile, masterPassword: string) => Promise<void>
  /** Whether the OS-keychain unlock (Windows sign-in) is currently enabled —
   * offers it as a one-click alternative to typing the master password in
   * the unlock prompt above, same as VaultMenu's own locked-state view. */
  osUnlockAvailable?: boolean
  onUnlockWithOsAndSelectSession?: (profile: SessionProfile) => Promise<void>
}

// Deliberately excludes `w-full` — some usages need `flex-1`/a fixed width
// instead, and mixing same-property utilities (`w-full` + `w-16`) relies on
// Tailwind's generated-CSS order rather than className order to resolve the
// conflict, which isn't guaranteed to go the way it reads left-to-right.
const inputClass =
  'rounded border border-white/10 bg-black/20 px-2 py-1.5 text-sm text-white/90 outline-none transition-colors duration-100 focus:border-sky-400/50'

type Protocol = 'ssh' | 'telnet' | 'serial'

const protocolIcons: Record<Protocol, typeof TerminalIcon> = {
  ssh: TerminalIcon,
  telnet: Radio,
  serial: Cable,
}

export function ConnectDialog({
  onConnect,
  onSaveProfile,
  onSaveCredential,
  vaultUnlocked,
  initial,
  error,
  sessions,
  onSelectSession,
  onEditSession,
  onDeleteSession,
  onUnlockAndSelectSession,
  osUnlockAvailable,
  onUnlockWithOsAndSelectSession,
}: Props) {
  const [protocol, setProtocol] = useState<Protocol>('ssh')

  // SSH + telnet share host/port.
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(String(initial?.port ?? (protocol === 'telnet' ? 23 : 22)))
  const [username, setUsername] = useState(initial?.username ?? '')
  const [authType, setAuthType] = useState<'Password' | 'PublicKey'>(
    initial?.authType ?? 'Password',
  )
  const [password, setPassword] = useState('')
  const [keyPath, setKeyPath] = useState(initial?.keyPath ?? '~/.ssh/id_ed25519')
  const [passphrase, setPassphrase] = useState('')
  const [label, setLabel] = useState(initial?.label ?? '')
  // Defaults on whenever we're prefilled from a known profile (picked from
  // the sidebar, or via Edit) — connecting then naturally writes any
  // tweaks back to that same profile instead of leaving them stranded in
  // the form. Doesn't apply to a from-scratch manual connection, where
  // there's no profile yet to update.
  const [saveProfile, setSaveProfile] = useState(!!initial?.id)
  const [saveCredential, setSaveCredential] = useState(false)

  const [serialConfig, setSerialConfig] = useState(defaultSerialConfig)

  const [menu, setMenu] = useState<{ profile: SessionProfile; x: number; y: number } | null>(null)
  const [pendingUnlock, setPendingUnlock] = useState<SessionProfile | null>(null)
  const [unlockPassword, setUnlockPassword] = useState('')
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  function pickSession(profile: SessionProfile) {
    if (profile.hasCredential && !vaultUnlocked && onUnlockAndSelectSession) {
      setPendingUnlock(profile)
      setUnlockPassword('')
      setUnlockError(null)
      return
    }
    onSelectSession?.(profile)
  }

  async function submitUnlock(e: React.FormEvent) {
    e.preventDefault()
    if (!pendingUnlock || !onUnlockAndSelectSession) return
    setUnlocking(true)
    setUnlockError(null)
    try {
      await onUnlockAndSelectSession(pendingUnlock, unlockPassword)
      setPendingUnlock(null)
    } catch (err) {
      setUnlockError(String(err))
    } finally {
      setUnlocking(false)
    }
  }

  async function submitUnlockWithOs() {
    if (!pendingUnlock || !onUnlockWithOsAndSelectSession) return
    setUnlocking(true)
    setUnlockError(null)
    try {
      await onUnlockWithOsAndSelectSession(pendingUnlock)
      setPendingUnlock(null)
    } catch (err) {
      setUnlockError(String(err))
    } finally {
      setUnlocking(false)
    }
  }

  function switchProtocol(next: Protocol) {
    setProtocol(next)
    if (next === 'telnet' && port === '22') setPort('23')
    if (next === 'ssh' && port === '23') setPort('22')
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()

    if (protocol === 'ssh') {
      const auth: AuthMethod =
        authType === 'Password'
          ? { type: 'Password', password }
          : { type: 'PublicKey', key_path: keyPath, passphrase: passphrase || null }

      if (saveProfile && onSaveProfile && label.trim()) {
        const profileId = initial?.id ?? crypto.randomUUID()
        // A public key with no passphrase has no secret to store — nothing
        // actually gets saved to the vault in that case even with the
        // checkbox on, so hasCredential has to agree, or the sidebar would
        // offer to "unlock the vault" for a session that never put
        // anything there.
        const willSaveCredential =
          saveCredential &&
          Boolean(onSaveCredential) &&
          vaultUnlocked &&
          (authType === 'Password' || Boolean(passphrase))
        onSaveProfile({
          id: profileId,
          label: label.trim(),
          folder: initial?.folder ?? null,
          host,
          port: Number(port) || 22,
          username,
          authType: authType === 'Password' ? 'password' : 'public_key',
          keyPath: authType === 'PublicKey' ? keyPath : null,
          // Preserves a prior credential's flag across an unrelated edit —
          // there's no "forget stored credential" affordance yet, so saving
          // shouldn't silently lose track of one that already exists.
          hasCredential: willSaveCredential || Boolean(initial?.hasCredential),
        })

        if (willSaveCredential && onSaveCredential) {
          const secret: VaultSecret =
            authType === 'Password'
              ? { type: 'Password', password }
              : { type: 'Passphrase', passphrase }
          onSaveCredential(profileId, secret)
        }
      }

      onConnect({
        protocol: 'ssh',
        config: { host, port: Number(port) || 22, username, auth },
      })
    } else if (protocol === 'telnet') {
      onConnect({ protocol: 'telnet', config: { host, port: Number(port) || 23 } })
    } else {
      onConnect({ protocol: 'serial', config: serialConfig })
    }
  }

  const groups = new Map<string, SessionProfile[]>()
  for (const s of sessions ?? []) {
    const key = s.folder ?? 'Sessions'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }

  if (pendingUnlock) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <form
          onSubmit={submitUnlock}
          className="w-80 animate-in fade-in zoom-in-95 space-y-3 rounded-xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl duration-150"
        >
          <div className="flex items-center gap-2 text-white/90">
            <Lock size={15} className="text-amber-400" />
            <span className="truncate font-medium">{pendingUnlock.label}</span>
          </div>
          <p className="text-xs leading-relaxed text-white/50">
            This session has a saved credential. Unlock the vault to connect automatically.
          </p>
          {osUnlockAvailable && onUnlockWithOsAndSelectSession && (
            <>
              <button
                type="button"
                disabled={unlocking}
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
            value={unlockPassword}
            onChange={(e) => setUnlockPassword(e.target.value)}
            className={`${inputClass} w-full`}
          />
          {unlockError && <p className="text-xs text-red-400">{unlockError}</p>}
          <button
            type="submit"
            disabled={unlocking}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-sky-500/90 py-1.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Lock size={14} />
            Unlock & Connect
          </button>
          <div className="flex items-center justify-between text-xs text-white/40">
            <button
              type="button"
              onClick={() => {
                onSelectSession?.(pendingUnlock)
                setPendingUnlock(null)
              }}
              className="hover:text-white/70"
            >
              Enter manually instead
            </button>
            <button
              type="button"
              onClick={() => setPendingUnlock(null)}
              className="hover:text-white/70"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="animate-in fade-in zoom-in-95 flex overflow-hidden rounded-xl border border-white/10 bg-white/[0.04] shadow-2xl duration-150">
        {sessions && sessions.length > 0 && (
          // Fixed width, scrolls independently of the form — so having a
          // handful of saved sessions or a hundred never pushes the connect
          // form (which is what you actually came here to use) out of view.
          <div className="max-h-[32rem] w-44 shrink-0 overflow-y-auto border-r border-white/10 bg-black/10 py-2 text-xs">
            {[...groups.entries()].map(([folder, items]) => (
              <div key={folder}>
                <div className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-wide text-white/60">
                  <Folder size={10} />
                  {folder}
                </div>
                {items.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => pickSession(s)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ profile: s, x: e.clientX, y: e.clientY })
                    }}
                    className="mx-1 flex cursor-pointer items-start gap-1.5 rounded px-2 py-1.5 text-white/70 transition-colors duration-100 hover:bg-white/[0.06]"
                    title={`${s.username}@${s.host}:${s.port}`}
                  >
                    <Server size={11} className="mt-0.5 shrink-0 text-white/30" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-white/90">{s.label}</div>
                      <div className="truncate text-white/40">
                        {s.username}@{s.host}
                      </div>
                    </div>
                    {s.hasCredential && (
                      <Lock size={10} className="mt-0.5 shrink-0 text-white/25" />
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        <form onSubmit={submit} className="w-80 space-y-3 p-5">
          <div className="flex gap-1 rounded-md bg-black/20 p-1 text-xs">
            {(['ssh', 'telnet', 'serial'] as const).map((p) => {
              const Icon = protocolIcons[p]
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => switchProtocol(p)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded py-1.5 uppercase tracking-wide transition-colors duration-150 ${
                    protocol === p
                      ? 'bg-white/15 text-white shadow-sm'
                      : 'text-white/40 hover:text-white/70'
                  }`}
                >
                  <Icon size={13} />
                  {p}
                </button>
              )
            })}
          </div>

          {protocol === 'serial' ? (
            <SerialFields config={serialConfig} onChange={setSerialConfig} />
          ) : (
            <>
              <div className="flex gap-2">
                <input
                  className={`${inputClass} min-w-0 flex-1`}
                  placeholder="host"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  required
                />
                <input
                  className={`${inputClass} w-16 shrink-0`}
                  placeholder="port"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                />
              </div>

              {protocol === 'ssh' && (
                <>
                  <input
                    className={`${inputClass} w-full`}
                    placeholder="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                  />

                  <div className="flex gap-3 text-xs text-white/70">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        className="accent-sky-400"
                        checked={authType === 'Password'}
                        onChange={() => setAuthType('Password')}
                      />
                      Password
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        className="accent-sky-400"
                        checked={authType === 'PublicKey'}
                        onChange={() => setAuthType('PublicKey')}
                      />
                      Public key
                    </label>
                  </div>

                  {authType === 'Password' ? (
                    <input
                      className={`${inputClass} w-full`}
                      placeholder="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  ) : (
                    <>
                      <input
                        className={`${inputClass} w-full`}
                        placeholder="key path"
                        value={keyPath}
                        onChange={(e) => setKeyPath(e.target.value)}
                      />
                      <input
                        className={`${inputClass} w-full`}
                        placeholder="passphrase (optional)"
                        type="password"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                      />
                    </>
                  )}
                </>
              )}
            </>
          )}

          {protocol === 'ssh' && onSaveProfile && (
            <div className="space-y-2 border-t border-white/10 pt-2.5">
              <label className="flex items-center gap-2 text-xs text-white/70">
                <input
                  type="checkbox"
                  className="accent-sky-400"
                  checked={saveProfile}
                  onChange={(e) => setSaveProfile(e.target.checked)}
                />
                <Save size={12} className="text-white/40" />
                Save as session
              </label>
              {saveProfile && (
                <>
                  <input
                    className={`${inputClass} w-full`}
                    placeholder="session name"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                  {onSaveCredential && (
                    <label
                      className={`flex items-center gap-2 text-xs ${
                        vaultUnlocked ? 'text-white/70' : 'text-white/30'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="accent-sky-400"
                        checked={saveCredential}
                        disabled={!vaultUnlocked}
                        onChange={(e) => setSaveCredential(e.target.checked)}
                      />
                      {vaultUnlocked
                        ? 'Also save credential to vault (next open skips this form)'
                        : 'Unlock the vault to also save the credential'}
                    </label>
                  )}
                </>
              )}
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-sky-500/90 py-1.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-sky-500"
          >
            <Plug size={14} />
            Connect
          </button>
        </form>
      </div>

      {menu && (
        <div
          className="animate-in fade-in zoom-in-95 fixed z-50 w-36 origin-top-left rounded-md border border-white/10 bg-[#1f2028] py-1 text-xs shadow-xl duration-100"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/80 transition-colors duration-100 hover:bg-white/10"
            onClick={() => {
              pickSession(menu.profile)
              setMenu(null)
            }}
          >
            <Plug size={13} /> Connect
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/80 transition-colors duration-100 hover:bg-white/10"
            onClick={() => {
              onEditSession?.(menu.profile)
              setMenu(null)
            }}
          >
            <Pencil size={13} /> Edit
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-300 transition-colors duration-100 hover:bg-white/10"
            onClick={() => {
              onDeleteSession?.(menu.profile)
              setMenu(null)
            }}
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>
      )}
    </div>
  )
}
