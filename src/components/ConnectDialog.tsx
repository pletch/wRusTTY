import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  Terminal as TerminalIcon,
  Radio,
  Cable,
  Save,
  Plug,
  Folder,
  FolderOpen,
  Server,
  Network,
  Lock,
  Pencil,
  Trash2,
  Fingerprint,
  ChevronRight,
  ChevronDown,
} from 'lucide-react'
import type { AuthMethod } from '../lib/ssh'
import type { SessionProfile } from '../lib/profiles'
import { profileSubtitle } from '../lib/profiles'
import type { VaultSecret } from '../lib/vault'
import type { ConnectionSource } from '../lib/connection'
import { defaultSerialConfig } from '../lib/serial'
import { SerialFields } from './SerialFields'

export interface ConnectDialogInitial {
  id?: string
  /** Opens the form on this protocol's tab — a saved telnet session must not
   * land on the SSH form with its host prefilled and its port wrong. */
  protocol?: 'ssh' | 'telnet'
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
}

/** Terminal types offered in the session form, most useful first. Blank means
 * "send the default", so it heads the list rather than being a separate
 * concept. Not exhaustive — hence the Custom entry, since the set genuinely
 * isn't closed (vendor strings, `putty-256color`, and so on). */
const TERM_TYPES: { value: string; label: string }[] = [
  // Labels stay short enough to fit the dialog's 20rem column alongside the
  // dropdown indicator. The qualifier in brackets is the whole reason a
  // caller would pick that row, so it earns its space; anything longer
  // belongs in the field's tooltip, not here.
  { value: '', label: 'xterm-256color (default)' },
  { value: 'xterm-direct', label: 'xterm-direct (24-bit)' },
  { value: 'xterm', label: 'xterm (PuTTY default)' },
  { value: 'vt100', label: 'vt100 (legacy gear)' },
  { value: 'vt220', label: 'vt220' },
  { value: 'ansi', label: 'ansi' },
  { value: 'linux', label: 'linux' },
  { value: 'screen-256color', label: 'screen-256color' },
  { value: 'tmux-256color', label: 'tmux-256color' },
]

/** Sentinel for the Custom row. Can't collide with a real TERM value — the
 * leading underscores aren't valid in a terminfo entry name. */
const TERM_CUSTOM = '__custom__'

/** Two states, not three: there is no global preference to inherit from, so
 * the modern value is simply the default and a session either overrides it or
 * doesn't. A profile stored without the field reads as `^?` for the same
 * reason. */
const BACKSPACE_OPTIONS: { value: string; label: string }[] = [
  { value: 'del', label: '^? (DEL) — modern Unix' },
  { value: 'ctrlh', label: '^H (Ctrl-H) — network / legacy gear' },
]

/** Telnet in 2026 is overwhelmingly network gear, console servers, and
 * legacy systems, so the form pre-selects the value that suits them. Set as
 * a *visible* form default rather than in the protocol's own defaults on the
 * Rust side: the user can see what will be sent and change it in one click,
 * instead of a silent downgrade they'd have to go looking for. */
const TELNET_DEFAULT_TERM = 'vt100'

interface Props {
  /** `paneOptions` carries terminal-side behaviour that isn't part of any
   * protocol's config — see `PaneLeaf.backspaceSendsCtrlH`. */
  onConnect: (
    source: ConnectionSource,
    logSession: boolean,
    paneOptions?: { backspaceSendsCtrlH: boolean | null },
  ) => void
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

const COLLAPSED_FOLDERS_KEY = 'wrustty.collapsed-session-folders'

function loadCollapsedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_FOLDERS_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function saveCollapsedFolders(folders: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...folders]))
  } catch {
    // Best-effort; a persistence failure shouldn't break folder collapsing.
  }
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
  onImportKeyToVault,
  onDeleteCredential,
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
  onReorderSessions,
}: Props) {
  const [protocol, setProtocol] = useState<Protocol>(initial?.protocol ?? 'ssh')

  // SSH + telnet share host/port.
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(String(initial?.port ?? (protocol === 'telnet' ? 23 : 22)))
  const [username, setUsername] = useState(initial?.username ?? '')
  const [authType, setAuthType] = useState<'Password' | 'PublicKey' | 'Agent'>(
    initial?.authType ?? 'Password',
  )
  const [termType, setTermType] = useState(initial?.termType ?? '')
  const [backspace, setBackspace] = useState(initial?.backspaceSendsCtrlH ? 'ctrlh' : 'del')
  // A saved session carrying a value that isn't on the list opens straight
  // into the free-text field, rather than silently snapping to the default.
  const [termCustom, setTermCustom] = useState(
    Boolean(initial?.termType) && !TERM_TYPES.some((t) => t.value === initial?.termType),
  )

  // Switching protocol re-applies that protocol's default terminal type,
  // unless we were prefilled from a saved session (which carries its own).
  // Deliberately overwrites a hand-picked value: changing protocol is a large
  // enough context switch that carrying the old one across would be the
  // surprising behaviour, not this.
  useEffect(() => {
    if (initial?.termType) return
    setTermCustom(false)
    setTermType(protocol === 'telnet' ? TELNET_DEFAULT_TERM : '')
  }, [protocol, initial?.termType])
  const [password, setPassword] = useState('')
  // A public-key profile with no keyPath and an existing vault credential
  // means the key itself already lives in the vault — the default path
  // placeholder would be misleading there, so leave it blank instead.
  const isInitiallyVaulted =
    initial?.authType === 'PublicKey' && initial?.keyPath === undefined && !!initial?.hasCredential
  const [keyPath, setKeyPath] = useState(
    initial?.keyPath ?? (isInitiallyVaulted ? '' : '~/.ssh/id_ed25519'),
  )
  const [keyStorage, setKeyStorage] = useState<'path' | 'vault'>(
    isInitiallyVaulted ? 'vault' : 'path',
  )
  const [passphrase, setPassphrase] = useState('')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [folder, setFolder] = useState(initial?.folder ?? '')
  const [jumpProfileId, setJumpProfileId] = useState(initial?.jumpProfileId ?? '')
  const [isNewFolder, setIsNewFolder] = useState(false)
  // Ad-hoc "log this whole session from the start" — an alternative to the
  // toolbar toggle (which can only arm logging after a session is already
  // connected, so it can't catch the login banner/MOTD). Enabling here sets
  // the pane's logging state before it connects, so the very first bytes are
  // captured; the toolbar icon then shows active and can stop it mid-session.
  const [logSession, setLogSession] = useState(false)
  // Defaults on whenever we're prefilled from a known profile (picked from
  // the sidebar, or via Edit) — connecting then naturally writes any
  // tweaks back to that same profile instead of leaving them stranded in
  // the form. Doesn't apply to a from-scratch manual connection, where
  // there's no profile yet to update.
  const [saveProfile, setSaveProfile] = useState(!!initial?.id)
  // On for a session that already has a stored credential: the user chose
  // that once, and an edit of some unrelated field shouldn't quietly read as
  // withdrawing it. Off for anything else, so storing a secret stays an
  // explicit act. Note this can't destroy the stored secret on its own —
  // `willSaveCredential` below also requires a *new* one to have been typed.
  const [saveCredential, setSaveCredential] = useState(Boolean(initial?.hasCredential))

  const [serialConfig, setSerialConfig] = useState(defaultSerialConfig)

  const [menu, setMenu] = useState<{ profile: SessionProfile; x: number; y: number } | null>(null)
  const [pendingUnlock, setPendingUnlock] = useState<SessionProfile | null>(null)
  const [unlockPassword, setUnlockPassword] = useState('')
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [collapsedFolders, setCollapsedFolders] = useState(loadCollapsedFolders)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

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

  async function browseForKey() {
    const picked = await open({ multiple: false })
    if (!picked || Array.isArray(picked)) return
    setKeyPath(picked)
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

  function toggleFolder(name: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      saveCollapsedFolders(next)
      return next
    })
  }

  function switchProtocol(next: Protocol) {
    setProtocol(next)
    if (next === 'telnet' && port === '22') setPort('23')
    if (next === 'ssh' && port === '23') setPort('22')
  }

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
      const relyOnExistingVaultedKey = usingVaultKey && isInitiallyVaulted && !keyPath.trim()

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
        } else if (!usingVaultKey && isInitiallyVaulted && onDeleteCredential) {
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
          // Preserves a prior credential's flag across an unrelated edit —
          // there's no "forget stored credential" affordance yet, so saving
          // shouldn't silently lose track of one that already exists.
          hasCredential: usingVaultKey
            ? Boolean(keyPath) || isInitiallyVaulted
            : willSaveCredential || Boolean(initial?.hasCredential),
          jumpProfileId: jumpProfileId || null,
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
      onConnect({ protocol: 'serial', config: serialConfig }, logSession, paneOptions)
    }
  }

  const groups = new Map<string, SessionProfile[]>()
  for (const s of sessions ?? []) {
    const key = s.folder ?? 'Sessions'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }

  const existingFolders = [
    ...new Set((sessions ?? []).map((s) => s.folder).filter((f): f is string => !!f)),
  ].sort()

  if (pendingUnlock) {
    return (
      // overflow-auto + m-auto on the card (instead of items/justify-center
      // on this wrapper) so a pane too short/narrow to fit the card doesn't
      // strand its top/bottom off-screen with no way to reach it — flex
      // centering via items-center/justify-center clips overflow at the
      // *start* of each axis when content is bigger than the container,
      // which auto margins on the child don't.
      <div className="flex h-full w-full overflow-auto p-4">
        <form
          onSubmit={submitUnlock}
          className="m-auto w-80 animate-in fade-in zoom-in-95 space-y-3 rounded-xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl duration-150"
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
    // See the pendingUnlock branch above for why this is overflow-auto +
    // m-auto on the card rather than items-center/justify-center here.
    <div className="flex h-full w-full overflow-auto p-4">
      {/* shrink-0: this card's own `overflow-hidden` (just for clipping the
          sidebar/form's rounded corners) resets its flex automatic min-width
          to 0 per spec, so without shrink-0 a too-narrow pane would shrink
          the card itself down to fit — clipping whatever doesn't fit via
          that same overflow-hidden — instead of the parent's overflow-auto
          ever seeing an overflow to scroll to. */}
      {/* Capped against the space actually available rather than a fixed
          height: the dialog takes whatever room it needs up to the pane, and
          only scrolls when the pane genuinely can't show it. A fixed cap
          forces a scrollbar on a window with plenty of room the moment the
          form grows past it. The 2rem subtracted is the wrapper's p-4, which
          `max-h-full` alone wouldn't account for. */}
      <div className="animate-in fade-in zoom-in-95 m-auto flex max-h-[calc(100%-2rem)] shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.04] shadow-2xl duration-150">
        {sessions && sessions.length > 0 && (
          // Fixed width, scrolls independently of the form — so having a
          // handful of saved sessions or a hundred never pushes the connect
          // form (which is what you actually came here to use) out of view.
          //
          // Left to the flex row's default stretch, so this is a uniform
          // full-height column that the folder list expands *into* as folders
          // are opened, rather than a panel whose own framing grows and
          // shrinks and leaves an edge partway down the dialog.
          <div className="w-44 shrink-0 overflow-y-auto border-r border-white/10 bg-black/10 py-2 text-xs">
            {[...groups.entries()].map(([folderName, items]) => {
              const collapsed = collapsedFolders.has(folderName)
              return (
                <div key={folderName}>
                  <button
                    type="button"
                    onClick={() => toggleFolder(folderName)}
                    className="flex w-full items-center gap-1 px-2 pb-1 pt-1.5 text-[10px] uppercase tracking-wide text-white/60 transition-colors duration-100 hover:text-white/90"
                  >
                    {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                    <Folder size={10} />
                    {folderName}
                  </button>
                  {!collapsed &&
                    items.map((s) => (
                      <div
                        key={s.id}
                        draggable
                        onDragStart={() => setDraggedId(s.id)}
                        onDragEnd={() => {
                          setDraggedId(null)
                          setDropTargetId(null)
                        }}
                        onDragOver={(e) => {
                          if (!draggedId || draggedId === s.id) return
                          const draggedProfile = sessions?.find((p) => p.id === draggedId)
                          if ((draggedProfile?.folder ?? null) !== (s.folder ?? null)) return
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                          setDropTargetId(s.id)
                        }}
                        onDragLeave={() => setDropTargetId((id) => (id === s.id ? null : id))}
                        onDrop={(e) => {
                          e.preventDefault()
                          if (draggedId) onReorderSessions?.(draggedId, s.id)
                          setDraggedId(null)
                          setDropTargetId(null)
                        }}
                        onClick={() => pickSession(s)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setMenu({ profile: s, x: e.clientX, y: e.clientY })
                        }}
                        className={`mx-1 flex cursor-pointer items-start gap-1.5 rounded px-2 py-1.5 text-white/70 transition-colors duration-100 hover:bg-white/[0.06] ${
                          draggedId === s.id ? 'opacity-40' : ''
                        } ${dropTargetId === s.id && draggedId !== s.id ? 'bg-sky-400/10' : ''}`}
                        title={`${s.username}@${s.host}:${s.port}`}
                      >
                        {/* Protocol shows as a per-item icon, not as its own
                            grouping level. Folders are what the user chose to
                            mean something ("Datacenter A", a customer); the
                            transport is an attribute of one entry. Grouping by
                            the attribute would override the organisation they
                            actually built — and would split the same device
                            reachable both ways into separate sections, which
                            is precisely when you want them adjacent. */}
                        {s.protocol === 'telnet' ? (
                          <Network size={11} className="mt-0.5 shrink-0 text-amber-400/40" />
                        ) : (
                          <Server size={11} className="mt-0.5 shrink-0 text-white/30" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-white/90">{s.label}</div>
                          <div className="truncate text-white/40">{profileSubtitle(s)}</div>
                        </div>
                        {s.hasCredential && (
                          <Lock size={10} className="mt-0.5 shrink-0 text-white/25" />
                        )}
                      </div>
                    ))}
                </div>
              )
            })}
          </div>
        )}
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
                            keyStorage === 'vault' && isInitiallyVaulted && !keyPath
                              ? 'browse to replace the vaulted key'
                              : 'key path'
                          }
                          value={keyPath}
                          onChange={(e) => setKeyPath(e.target.value)}
                          required={saveProfile && keyStorage === 'vault' && !isInitiallyVaulted}
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
                      {keyStorage === 'vault' && isInitiallyVaulted && !keyPath && (
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
                  onChange={(e) => {
                    const next = e.target.value
                    setTermCustom(next === TERM_CUSTOM)
                    // Clearing on entry to Custom avoids the free-text box
                    // opening pre-filled with the value just replaced.
                    setTermType(next === TERM_CUSTOM ? '' : next)
                  }}
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

          {protocol !== 'serial' && onSaveProfile && (
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
                        onClick={() => {
                          setIsNewFolder(false)
                          setFolder(initial?.folder ?? '')
                        }}
                        className="shrink-0 rounded border border-white/10 bg-black/20 px-2 text-xs text-white/50 transition-colors duration-100 hover:text-white/90"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <select
                      className={`${inputClass} w-full`}
                      value={folder}
                      onChange={(e) => {
                        if (e.target.value === '__new__') {
                          setIsNewFolder(true)
                          setFolder('')
                        } else {
                          setFolder(e.target.value)
                        }
                      }}
                    >
                      <option value="">No folder</option>
                      {existingFolders.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                      <option value="__new__">+ New folder...</option>
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
                        className={`flex items-center gap-1.5 ${
                          vaultUnlocked ? '' : 'text-white/30'
                        }`}
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
