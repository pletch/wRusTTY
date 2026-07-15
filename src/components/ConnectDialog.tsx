import { useState } from 'react'
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

const inputClass =
  'w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-sm text-white/90 outline-none focus:border-white/30'

type Protocol = 'ssh' | 'telnet' | 'serial'

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
        className="w-80 space-y-3 rounded-lg border border-white/10 bg-white/5 p-5"
      >
        <div className="flex gap-1 rounded bg-black/20 p-0.5 text-xs">
          {(['ssh', 'telnet', 'serial'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => switchProtocol(p)}
              className={`flex-1 rounded py-1 uppercase tracking-wide ${
                protocol === p ? 'bg-white/15 text-white' : 'text-white/40 hover:text-white/70'
              }`}
            >
              {p}
            </button>
          ))}
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
                className={`${inputClass} w-16`}
                placeholder="port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </div>

            {protocol === 'ssh' && (
              <>
                <input
                  className={inputClass}
                  placeholder="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />

                <div className="flex gap-3 text-xs text-white/70">
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={authType === 'Password'}
                      onChange={() => setAuthType('Password')}
                    />
                    Password
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={authType === 'PublicKey'}
                      onChange={() => setAuthType('PublicKey')}
                    />
                    Public key
                  </label>
                </div>

                {authType === 'Password' ? (
                  <input
                    className={inputClass}
                    placeholder="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                ) : (
                  <>
                    <input
                      className={inputClass}
                      placeholder="key path"
                      value={keyPath}
                      onChange={(e) => setKeyPath(e.target.value)}
                    />
                    <input
                      className={inputClass}
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
          <div className="space-y-2 border-t border-white/10 pt-2">
            <label className="flex items-center gap-2 text-xs text-white/70">
              <input
                type="checkbox"
                checked={saveProfile}
                onChange={(e) => setSaveProfile(e.target.checked)}
              />
              Save as session
            </label>
            {saveProfile && (
              <>
                <input
                  className={inputClass}
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
          className="w-full rounded bg-white/10 py-1.5 text-sm text-white/90 hover:bg-white/20"
        >
          Connect
        </button>
      </form>
    </div>
  )
}
