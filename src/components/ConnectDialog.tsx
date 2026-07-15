import { useState } from 'react'
import { Terminal as TerminalIcon, Radio, Cable, Save, Plug } from 'lucide-react'
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
}

interface Props {
  onConnect: (source: ConnectionSource) => void
  onSaveProfile?: (profile: SessionProfile) => void
  onSaveCredential?: (profileId: string, secret: VaultSecret) => void
  vaultUnlocked?: boolean
  initial?: ConnectDialogInitial
  error?: string | null
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
  const [saveProfile, setSaveProfile] = useState(false)
  const [saveCredential, setSaveCredential] = useState(false)

  const [serialConfig, setSerialConfig] = useState(defaultSerialConfig)

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
        onSaveProfile({
          id: profileId,
          label: label.trim(),
          folder: initial?.folder ?? null,
          host,
          port: Number(port) || 22,
          username,
          authType: authType === 'Password' ? 'password' : 'public_key',
          keyPath: authType === 'PublicKey' ? keyPath : null,
        })

        if (saveCredential && onSaveCredential && vaultUnlocked) {
          const secret: VaultSecret =
            authType === 'Password'
              ? { type: 'Password', password }
              : { type: 'Passphrase', passphrase }
          if (authType === 'Password' || passphrase) {
            onSaveCredential(profileId, secret)
          }
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

  return (
    <div className="flex h-full w-full items-center justify-center">
      <form
        onSubmit={submit}
        className="w-80 animate-in fade-in zoom-in-95 space-y-3 rounded-xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl duration-150"
      >
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
  )
}
