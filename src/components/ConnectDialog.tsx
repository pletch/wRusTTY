import { useReducer, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Terminal as TerminalIcon, Radio, Cable, Save, Plug, FolderOpen } from 'lucide-react'
import type { AuthMethod } from '../lib/ssh'
import type { SessionProfile, SerialProfile } from '../lib/profiles'
import { serialProfileFrom } from '../lib/profiles'
import type { PortInfo } from '../lib/serial'
import type { Workspace } from '../lib/workspaces'
import type { VaultSecret } from '../lib/vault'
import type { ConnectionSource } from '../lib/connection'
import { SerialFields } from './SerialFields'
import { SessionBrowser } from './SessionBrowser'
import {
  connectDraftReducer,
  initialConnectDraft,
  isInitiallyVaulted,
  TERM_TYPES,
  TERM_CUSTOM,
  BACKSPACE_OPTIONS,
  NEW_FOLDER_SENTINEL,
} from '../state/connectDraft'
import type { Protocol } from '../state/connectDraft'

export interface ConnectDialogInitial {
  id?: string
  /** Opens the form on this protocol's tab — a saved telnet session must not
   * land on the SSH form with its host prefilled and its port wrong, and a
   * saved serial one must not land on either. */
  protocol?: 'ssh' | 'telnet' | 'serial'
  label?: string
  host?: string
  port?: number
  username?: string
  authType?: 'Password' | 'PublicKey' | 'Agent'
  keyPath?: string
  folder?: string | null
  hasCredential?: boolean
  jumpProfileId?: string | null
  termType?: string | null
  backspaceSendsCtrlH?: boolean | null
  /** Seconds between SSH keepalives — null/absent means the 60s default. */
  keepaliveSeconds?: number | null
  /** Serial only — the stored line settings and adapter identity. */
  serial?: SerialProfile | null
}

// Deliberately excludes `w-full` — some usages need `flex-1`/a fixed width
// instead, and mixing same-property utilities (`w-full` + `w-16`) relies on
// Tailwind's generated-CSS order rather than className order to resolve the
// conflict, which isn't guaranteed to go the way it reads left-to-right.
const inputClass =
  'rounded border border-white/10 bg-black/20 px-2 py-1.5 text-sm text-white/90 outline-none transition-colors duration-100 focus:border-sky-400/50'

const protocolIcons: Record<Protocol, typeof TerminalIcon> = {
  ssh: TerminalIcon,
  telnet: Radio,
  serial: Cable,
}

interface Props {
  /** `paneOptions` carries terminal-side behaviour that isn't part of any
   * protocol's config — see `PaneLeaf.backspaceSendsCtrlH`. */
  onConnect: (
    source: ConnectionSource,
    logSession: boolean,
    paneOptions?: { backspaceSendsCtrlH: boolean | null },
  ) => void
  /** Saved workspaces, listed above the sessions. Absent hides the section. */
  workspaces?: Workspace[]
  onOpenWorkspace?: (workspace: Workspace) => void
  /** Awaited before connecting when the connection will go through the saved
   * profile — otherwise the write races the read and the session connects
   * with the values it had *before* this edit. */
  onSaveProfile?: (profile: SessionProfile) => void | Promise<void>
  onSaveCredential?: (profileId: string, secret: VaultSecret) => void
  /** Reads a key file server-side and stores it whole in the vault, as an
   * alternative to referencing a path — the plaintext key never comes
   * through this form. */
  onImportKeyToVault?: (profileId: string, keyPath: string, passphrase: string | null) => void
  /** Clears a profile's vault entry — used when switching a vaulted-key
   * session back to a plain on-disk path, so the old key doesn't linger. */
  onDeleteCredential?: (profileId: string) => void
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
  /** Sessions were added by the PuTTY import — the owner re-reads the list. */
  onSessionsImported?: () => void
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
  /** Drags a session from one row onto another within the same folder
   * group, reordering the saved-sessions list. */
  onReorderSessions?: (draggedId: string, targetId: string) => void
}

export function ConnectDialog({
  onConnect,
  onSaveProfile,
  onSaveCredential,
  onImportKeyToVault,
  onDeleteCredential,
  vaultUnlocked,
  initial,
  error,
  sessions,
  workspaces,
  onOpenWorkspace,
  onSelectSession,
  onEditSession,
  onDeleteSession,
  onSessionsImported,
  onUnlockAndSelectSession,
  osUnlockAvailable,
  onUnlockWithOsAndSelectSession,
  onReorderSessions,
}: Props) {
  const [draft, dispatch] = useReducer(connectDraftReducer, initial, initialConnectDraft)
  // Kept out of the draft reducer: this isn't a field the user edits, it's the
  // identity of whichever port they picked, read from the live port list at
  // the moment they picked it. Seeded from the profile being edited so
  // re-saving without touching the port dropdown doesn't discard it.
  const [serialUsb, setSerialUsb] = useState<PortInfo['usb']>(
    initial?.serial?.identity.usb ?? null,
  )
  const {
    protocol,
    host,
    port,
    username,
    authType,
    keyPath,
    keyStorage,
    passphrase,
    password,
    termType,
    termCustom,
    backspace,
    label,
    folder,
    isNewFolder,
    jumpProfileId,
    keepalive,
    serialConfig,
    logSession,
    saveProfile,
    saveCredential,
  } = draft

  // Small setter wrappers so the field markup below reads the same as it
  // did as independent useState hooks — see state/connectDraft.ts for the
  // cross-field rules (protocol switch, terminal-type Custom entry, new
  // folder) that aren't just a plain field set.
  const setHost = (v: string) => dispatch({ type: 'fieldSet', field: 'host', value: v })
  const setPort = (v: string) => dispatch({ type: 'fieldSet', field: 'port', value: v })
  const setUsername = (v: string) => dispatch({ type: 'fieldSet', field: 'username', value: v })
  const setAuthType = (v: typeof authType) => dispatch({ type: 'fieldSet', field: 'authType', value: v })
  const setKeyPath = (v: string) => dispatch({ type: 'fieldSet', field: 'keyPath', value: v })
  const setKeyStorage = (v: 'path' | 'vault') => dispatch({ type: 'fieldSet', field: 'keyStorage', value: v })
  const setPassphrase = (v: string) => dispatch({ type: 'fieldSet', field: 'passphrase', value: v })
  const setPassword = (v: string) => dispatch({ type: 'fieldSet', field: 'password', value: v })
  const setTermType = (v: string) => dispatch({ type: 'fieldSet', field: 'termType', value: v })
  const setBackspace = (v: string) => dispatch({ type: 'fieldSet', field: 'backspace', value: v })
  const setLabel = (v: string) => dispatch({ type: 'fieldSet', field: 'label', value: v })
  const setFolder = (v: string) => dispatch({ type: 'fieldSet', field: 'folder', value: v })
  const setJumpProfileId = (v: string) => dispatch({ type: 'fieldSet', field: 'jumpProfileId', value: v })
  const setKeepalive = (v: string) => dispatch({ type: 'fieldSet', field: 'keepalive', value: v })
  const setSerialConfig = (v: typeof serialConfig) => dispatch({ type: 'fieldSet', field: 'serialConfig', value: v })
  const setLogSession = (v: boolean) => dispatch({ type: 'fieldSet', field: 'logSession', value: v })
  const setSaveProfile = (v: boolean) => dispatch({ type: 'fieldSet', field: 'saveProfile', value: v })
  const setSaveCredential = (v: boolean) => dispatch({ type: 'fieldSet', field: 'saveCredential', value: v })

  function switchProtocol(next: Protocol) {
    dispatch({ type: 'protocolSwitched', protocol: next, hasInitialTermType: Boolean(initial?.termType) })
  }

  async function browseForKey() {
    const picked = await open({ multiple: false })
    if (!picked || Array.isArray(picked)) return
    setKeyPath(picked)
  }

  // A public-key profile with no keyPath and an existing vault credential
  // means the key itself already lives in the vault — the default path
  // placeholder would be misleading there, so leave it blank instead.
  const vaultedInitially = isInitiallyVaulted(initial)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const paneOptions = { backspaceSendsCtrlH: backspace === 'ctrlh' }

    if (protocol === 'ssh') {
      const usingVaultKey = authType === 'PublicKey' && keyStorage === 'vault'
      // Leaving the key-path field blank while "Store key in vault" is
      // selected means "keep using whatever's already vaulted" — not "this
      // session no longer has a key." Connecting should then go through
      // the saved profile (which resolves the credential from the vault,
      // server-side) rather than building a manual AuthMethod::PublicKey
      // with an empty path, which can only ever fail to find a key that
      // was never on disk to begin with.
      const relyOnExistingVaultedKey = usingVaultKey && vaultedInitially && !keyPath.trim()

      // Connecting manually sends exactly what this form holds — and the
      // credential fields are deliberately blank whenever a secret is already
      // vaulted, because the plaintext never travels back to the webview to
      // prefill them. Sending that blank as the password is an authentication
      // failure every single time, which is what editing any saved
      // password session and pressing Connect used to do.
      //
      // When the profile already holds what we'd need, connect *through* it
      // instead and let Rust resolve the secret. Typing a fresh password or
      // passphrase opts back out, since the form then has something the vault
      // may not.
      const relyOnSavedCredential =
        Boolean(initial?.id) &&
        (relyOnExistingVaultedKey ||
          (Boolean(initial?.hasCredential) &&
            ((authType === 'Password' && !password) ||
              (authType === 'PublicKey' && !usingVaultKey && !passphrase))))

      const auth: AuthMethod =
        authType === 'Agent'
          ? { type: 'Agent' }
          : authType === 'Password'
            ? { type: 'Password', password }
            : { type: 'PublicKey', key_path: keyPath, passphrase: passphrase || null }

      if (saveProfile && onSaveProfile) {
        const profileId = initial?.id ?? crypto.randomUUID()
        // An unnamed session saved silently with no way to tell it apart
        // from a real save was worse than picking a reasonable default —
        // the host is always present and is what the sidebar would show
        // as the subtitle anyway.
        const resolvedLabel = label.trim() || host
        // A public key with no passphrase has no secret to store — nothing
        // actually gets saved to the vault in that case even with the
        // checkbox on, so hasCredential has to agree, or the sidebar would
        // offer to "unlock the vault" for a session that never put
        // anything there. Vault-mode keys have their own hasCredential
        // logic below instead, since the key itself is the stored secret.
        // Agent auth has no secret of ours to store — the key never leaves
        // the agent — so it must never mark the profile as having a vault
        // credential, or the sidebar would offer to unlock the vault for a
        // session that put nothing in it.
        //
        // `hasNewSecret` is what makes an editing pass safe. The credential
        // fields start blank even when a secret is vaulted, because the
        // plaintext never comes back to the webview to prefill them — so
        // "save credential is ticked" plus "field is empty" means *keep what
        // is stored*, never "store an empty string over it".
        const hasNewSecret = authType === 'Password' ? Boolean(password) : Boolean(passphrase)
        const willSaveCredential =
          authType !== 'Agent' &&
          !usingVaultKey &&
          saveCredential &&
          Boolean(onSaveCredential) &&
          vaultUnlocked &&
          hasNewSecret

        if (usingVaultKey && keyPath && onImportKeyToVault) {
          // The key and its own passphrase travel together as one vault
          // secret, separate from the generic password/passphrase
          // credential path above.
          onImportKeyToVault(profileId, keyPath, passphrase || null)
        } else if (authType === 'Agent' && initial?.hasCredential && onDeleteCredential) {
          // Switched an existing session over to the agent. Whatever it had
          // vaulted — password, passphrase, or the key itself — is no longer
          // reachable through this profile, and nothing else references that
          // entry, so drop it rather than leave it orphaned.
          onDeleteCredential(profileId)
        } else if (!usingVaultKey && vaultedInitially && onDeleteCredential) {
          // Switched back to a plain on-disk path — the previously vaulted
          // key is no longer referenced by anything, so don't leave it
          // behind as an orphaned vault entry.
          onDeleteCredential(profileId)
        }

        await onSaveProfile({
          id: profileId,
          label: resolvedLabel,
          folder: folder.trim() || null,
          host,
          port: Number(port) || 22,
          protocol: 'ssh',
          username,
          authType:
            authType === 'Agent' ? 'agent' : authType === 'Password' ? 'password' : 'public_key',
          keyPath: authType === 'PublicKey' && !usingVaultKey ? keyPath : null,
          termType: termType.trim() || null,
          backspaceSendsCtrlH: backspace === 'ctrlh',
          // Otherwise preserves a prior credential's flag across an unrelated
          // edit — there's no "forget stored credential" affordance yet, so
          // saving shouldn't silently lose track of one that already exists.
          // Agent auth is the exception, and has to be: carrying the old flag
          // forward would leave the sidebar offering to unlock the vault for
          // a session that no longer goes near it (see the branch above, which
          // deletes the entry that flag pointed at).
          hasCredential: usingVaultKey
            ? Boolean(keyPath) || vaultedInitially
            : authType !== 'Agent' && (willSaveCredential || Boolean(initial?.hasCredential)),
          jumpProfileId: jumpProfileId || null,
          // '' means "use the default", which is null rather than 0 — 0 is
          // the distinct, deliberate "turn keepalives off".
          keepaliveSeconds: keepalive === '' ? null : Number(keepalive),
          serial: null,
        })

        if (willSaveCredential && onSaveCredential) {
          const secret: VaultSecret =
            authType === 'Password'
              ? { type: 'Password', password }
              : { type: 'Passphrase', passphrase }
          onSaveCredential(profileId, secret)
        }
      }

      if (relyOnSavedCredential && initial?.id) {
        onConnect({ protocol: 'sshProfile', profileId: initial.id }, logSession, paneOptions)
      } else {
        onConnect(
          {
            protocol: 'ssh',
            config: {
              host,
              port: Number(port) || 22,
              username,
              auth,
              // Was missing entirely, so a terminal type set on this form was
              // silently dropped on every manual connection — it only ever
              // took effect via the saved-profile path.
              term_type: termType.trim() || null,
              keepalive_seconds: keepalive === '' ? null : Number(keepalive),
            },
            jumpProfileId: jumpProfileId || null,
          },
          logSession,
          paneOptions,
        )
      }
    } else if (protocol === 'telnet') {
      // No credential half to any of this: telnet has no auth of its own, so
      // saving is purely "remember this endpoint and how to drive its
      // terminal" and never touches the vault.
      if (saveProfile && onSaveProfile) {
        await onSaveProfile({
          id: initial?.id ?? crypto.randomUUID(),
          label: label.trim() || host,
          folder: folder.trim() || null,
          host,
          port: Number(port) || 23,
          protocol: 'telnet',
          username: '',
          authType: '',
          keyPath: null,
          hasCredential: false,
          jumpProfileId: null,
          termType: termType.trim() || null,
          backspaceSendsCtrlH: backspace === 'ctrlh',
          // Telnet has no keepalive of its own.
          keepaliveSeconds: null,
          serial: null,
        })
      }
      onConnect(
        {
          protocol: 'telnet',
          config: { host, port: Number(port) || 23, term_type: termType.trim() || null },
        },
        logSession,
        paneOptions,
      )
    } else {
      // Like telnet, no credential half — serial has no auth at all, so
      // saving is purely "remember this adapter and its line settings".
      if (saveProfile && onSaveProfile) {
        const profileId = initial?.id ?? crypto.randomUUID()
        await onSaveProfile({
          id: profileId,
          label: label.trim() || serialConfig.portName,
          folder: folder.trim() || null,
          // Unused for serial; carries the port name so anything reading
          // `host` generically shows something meaningful.
          host: serialConfig.portName,
          port: 0,
          protocol: 'serial',
          username: '',
          authType: '',
          keyPath: null,
          hasCredential: false,
          jumpProfileId: null,
          termType: null,
          backspaceSendsCtrlH: backspace === 'ctrlh',
          // No idle timeout on a wire.
          keepaliveSeconds: null,
          serial: serialProfileFrom(serialConfig, serialUsb),
        })
        // Connect through the profile so this very first connection resolves
        // the adapter the same way every later one will — if the identity is
        // wrong, it fails now, while the user is still looking at the form,
        // rather than the next time they open the session.
        onConnect({ protocol: 'serialProfile', profileId }, logSession, paneOptions)
        return
      }
      onConnect({ protocol: 'serial', config: serialConfig }, logSession, paneOptions)
    }
  }

  const existingFolders = [
    ...new Set((sessions ?? []).map((s) => s.folder).filter((f): f is string => !!f)),
  ].sort()

  return (
    <SessionBrowser
      sessions={sessions}
      workspaces={workspaces}
      onOpenWorkspace={onOpenWorkspace}
      onSelectSession={onSelectSession}
      onEditSession={onEditSession}
      onDeleteSession={onDeleteSession}
      onUnlockAndSelectSession={onUnlockAndSelectSession}
      osUnlockAvailable={osUnlockAvailable}
      onUnlockWithOsAndSelectSession={onUnlockWithOsAndSelectSession}
      onReorderSessions={onReorderSessions}
      vaultUnlocked={vaultUnlocked}
      onSessionsImported={onSessionsImported}
    >
      {/* Scrolls in its own right now that the card is capped — without
          this a form taller than the cap would be clipped by the card's
          overflow-hidden with no way to reach the rest of it. */}
      <form onSubmit={submit} className="w-80 space-y-3 overflow-y-auto p-5">
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
          <SerialFields
            config={serialConfig}
            onChange={setSerialConfig}
            onIdentityChange={setSerialUsb}
          />
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
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      className="accent-sky-400"
                      checked={authType === 'Agent'}
                      onChange={() => setAuthType('Agent')}
                    />
                    SSH agent
                  </label>
                </div>

                {authType === 'Agent' ? (
                  <p className="text-xs text-white/40">
                    Keys come from Pageant or the Windows OpenSSH agent — whichever is running.
                    Nothing is stored here, and hardware keys (FIDO2, PIV, YubiKey) work this way
                    only.
                  </p>
                ) : authType === 'Password' ? (
                  <>
                    <input
                      className={`${inputClass} w-full`}
                      placeholder={
                        initial?.hasCredential ? '•••••••• (saved — leave blank to keep)' : 'password'
                      }
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    {initial?.hasCredential && !password && (
                      <p className="text-xs text-white/40">
                        Password is stored in the vault — enter a new one to replace it.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex gap-1.5">
                      <input
                        className={`${inputClass} w-full flex-1`}
                        placeholder={
                          keyStorage === 'vault' && vaultedInitially && !keyPath
                            ? 'browse to replace the vaulted key'
                            : 'key path'
                        }
                        value={keyPath}
                        onChange={(e) => setKeyPath(e.target.value)}
                        required={saveProfile && keyStorage === 'vault' && !vaultedInitially}
                      />
                      <button
                        type="button"
                        onClick={browseForKey}
                        title="Browse for key file"
                        className="flex shrink-0 items-center justify-center rounded border border-white/10 bg-black/20 px-2 text-white/50 transition-colors duration-100 hover:text-white/90"
                      >
                        <FolderOpen size={13} />
                      </button>
                    </div>
                    <input
                      className={`${inputClass} w-full`}
                      placeholder={
                        initial?.hasCredential && keyPath
                          ? '•••••••• (saved — leave blank to keep)'
                          : 'passphrase (optional)'
                      }
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                    />
                    {keyStorage === 'vault' && vaultedInitially && !keyPath && (
                      <p className="text-xs text-white/40">
                        Key is stored in the vault — browse above to replace it.
                      </p>
                    )}
                  </>
                )}

                {/* Every other field in this form is labelled by its own
                    placeholder, which a select can't have — which is how
                    "Jump via" ended up repeated on every row, restating the
                    field on each option and eating the width the session
                    names needed. Hoisting it to a caption says it once. */}
                {sessions && sessions.filter((s) => s.id !== initial?.id).length > 0 && (
                  <label className="block space-y-1">
                    <span className="text-xs text-white/40">Jump host</span>
                    <select
                      // Same indicator-overlap fix as the terminal-type
                      // select — more pressing here, since these labels are
                      // user-chosen session names of any length.
                      className={`${inputClass} w-full truncate pr-7`}
                      value={jumpProfileId}
                      onChange={(e) => setJumpProfileId(e.target.value)}
                      title="Connect through another saved session first (SSH ProxyJump), e.g. a Tailscale-reachable machine that can reach this host"
                    >
                      <option value="">None — connect directly</option>
                      {sessions
                        .filter((s) => s.id !== initial?.id)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label} ({s.host})
                          </option>
                        ))}
                    </select>
                  </label>
                )}
              </>
            )}
          </>
        )}

        {/* Terminal behaviour, shared across protocols rather than nested
            inside the SSH branch where these started.

            Terminal type reaches SSH through the PTY request and telnet
            through RFC 1091 option negotiation — different wire mechanisms,
            same user-facing question. Serial has neither: it's a raw byte
            stream with nothing to negotiate with, so the control is hidden
            rather than shown and ignored. */}
        {protocol !== 'serial' && (
          <>
            {/* A select with an explicit Custom row, not a datalist.
                A datalist looks right but behaves as an autocomplete
                filter: once the field holds a value it only offers
                options matching that text, so picking one collapses the
                list to a single entry and the control appears broken
                until the field is cleared. */}
            <label className="block space-y-1">
              <span className="text-xs text-white/40">Terminal type</span>
              <select
                // pr-7 rather than inputClass's px-2: a native select
                // draws its indicator inside the padding box, so the
                // shared input padding leaves the longest label running
                // underneath the arrow.
                className={`${inputClass} w-full truncate pr-7`}
                value={termCustom ? TERM_CUSTOM : termType}
                onChange={(e) => dispatch({ type: 'termTypeSelected', value: e.target.value })}
                title="Sets TERM for the remote session. The default suits almost everything — some network and embedded gear needs vt100."
              >
                {TERM_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
                <option value={TERM_CUSTOM}>Custom…</option>
              </select>
            </label>
            {termCustom && (
              <input
                className={`${inputClass} w-full`}
                placeholder="terminal type, e.g. putty-256color"
                value={termType}
                onChange={(e) => setTermType(e.target.value)}
                autoFocus
              />
            )}
          </>
        )}

        {/* SSH only — telnet has no keepalive of its own, and serial has no
            idle timeout to survive. Per-session rather than a global setting:
            the firewall dropping the connection is on the path to one host,
            so the box behind a corporate NAT needs this and the one on the
            LAN doesn't. PuTTY puts it in Connection → "Seconds between
            keepalives", which is where a migrating user will look. */}
        {protocol === 'ssh' && (
          <label className="block space-y-1">
            <span className="text-xs text-white/40">Keepalive (seconds)</span>
            <input
              className={`${inputClass} w-full`}
              inputMode="numeric"
              placeholder="60 (default) — 0 to disable"
              value={keepalive}
              onChange={(e) => setKeepalive(e.target.value.replace(/[^0-9]/g, ''))}
              title="How often to send a keepalive so an idle connection isn't dropped by a firewall or NAT. Blank uses 60 seconds; 0 turns keepalives off."
            />
          </label>
        )}

        {/* Applies to every protocol: this is the local terminal choosing
            which byte to emit, not anything negotiated with the far end. */}
        <label className="block space-y-1">
          <span className="text-xs text-white/40">Backspace key sends</span>
          <select
            className={`${inputClass} w-full truncate pr-7`}
            value={backspace}
            onChange={(e) => setBackspace(e.target.value)}
            title="Which byte the Backspace key sends. Switch to ^H if backspace does nothing or echoes ^? on the far end."
          >
            {BACKSPACE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {/* Serial is saveable now. It wasn't, because a COM number stops
            meaning anything once the adapter moves socket — but the profile
            records the adapter's USB VID/PID/serial instead, and resolves a
            live COM number at connect time. */}
        {onSaveProfile && (
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
            {protocol === 'serial' && saveProfile && !serialUsb && (
              // Worth saying before the save rather than after a failed
              // connect weeks later: without an identity this profile is only
              // as good as PuTTY's was.
              <p className="text-xs text-amber-300/80">
                This port reports no USB identity, so the session will look for{' '}
                {serialConfig.portName || 'it'} by name and won&apos;t follow the adapter to a
                different socket.
              </p>
            )}
            {saveProfile && (
              <>
                <input
                  className={`${inputClass} w-full`}
                  placeholder={`session name (defaults to "${host || 'host'}")`}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
                {isNewFolder ? (
                  <div className="flex gap-1.5">
                    <input
                      className={`${inputClass} w-full flex-1`}
                      placeholder="new folder name"
                      autoFocus
                      value={folder}
                      onChange={(e) => setFolder(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        dispatch({ type: 'newFolderCancelled', initialFolder: initial?.folder ?? '' })
                      }
                      className="shrink-0 rounded border border-white/10 bg-black/20 px-2 text-xs text-white/50 transition-colors duration-100 hover:text-white/90"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <select
                    className={`${inputClass} w-full`}
                    value={folder}
                    onChange={(e) => dispatch({ type: 'folderSelected', value: e.target.value })}
                  >
                    <option value="">No folder</option>
                    {existingFolders.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                    <option value={NEW_FOLDER_SENTINEL}>+ New folder...</option>
                  </select>
                )}
                {onSaveCredential && (authType === 'Password' || keyStorage === 'path') && (
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
                {authType === 'PublicKey' && onImportKeyToVault && (
                  <div className="flex gap-3 text-xs text-white/70">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        className="accent-sky-400"
                        checked={keyStorage === 'path'}
                        onChange={() => setKeyStorage('path')}
                      />
                      Key file on disk
                    </label>
                    <label
                      className={`flex items-center gap-1.5 ${vaultUnlocked ? '' : 'text-white/30'}`}
                    >
                      <input
                        type="radio"
                        className="accent-sky-400"
                        checked={keyStorage === 'vault'}
                        disabled={!vaultUnlocked}
                        onChange={() => setKeyStorage('vault')}
                      />
                      Store key in vault (portable)
                    </label>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <label className="flex cursor-pointer items-center gap-2 text-xs text-white/70">
          <input
            type="checkbox"
            className="accent-sky-400"
            checked={logSession}
            onChange={(e) => setLogSession(e.target.checked)}
          />
          Log this session to a file (from connect)
        </label>

        <button
          type="submit"
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-sky-500/90 py-1.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-sky-500"
        >
          <Plug size={14} />
          Connect
        </button>
      </form>
    </SessionBrowser>
  )
}
