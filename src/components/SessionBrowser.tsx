import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Folder,
  LayoutGrid,
  Lock,
  Network,
  Server,
  Plug,
  Pencil,
  Trash2,
  ChevronRight,
  ChevronDown,
  Fingerprint,
  Zap,
} from 'lucide-react'
import type { SessionProfile } from '../lib/profiles'
import { profileSubtitle, puttySessionCount } from '../lib/profiles'
import { isPuttyOfferSettled, settlePuttyOffer, runPuttyImport } from '../lib/puttyBanner'
import type { Workspace } from '../lib/workspaces'

const inputClass =
  'rounded border border-white/10 bg-black/20 px-2 py-1.5 text-sm text-white/90 outline-none transition-colors duration-100 focus:border-sky-400/50'

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

interface Props {
  /** Saved sessions shown in a sidebar alongside the connect form — picking
   * one calls onSelectSession instead of prefilling anything here directly,
   * since the parent may skip its form entirely (e.g. a stored vault
   * credential lets it connect right away). */
  sessions?: SessionProfile[]
  workspaces?: Workspace[]
  onOpenWorkspace?: (workspace: Workspace) => void
  onSelectSession?: (profile: SessionProfile) => void
  /** Populates the caller's form from this profile without ever
   * auto-connecting, even if the vault already holds its credential — the
   * only way to edit a session's saved details rather than just reuse
   * them. */
  onEditSession?: (profile: SessionProfile) => void
  onDeleteSession?: (profile: SessionProfile) => void
  /** Sends this session's magic packet without connecting. Offered only for
   * a profile that has a MAC saved. */
  onWakeSession?: (profile: SessionProfile) => void
  /** A session with a stored credential picked while the vault is locked
   * prompts for the master password inline instead of just falling back to
   * the caller's form — this unlocks the vault and then behaves like
   * onSelectSession would have if it had been unlocked all along. */
  onUnlockAndSelectSession?: (profile: SessionProfile, masterPassword: string) => Promise<void>
  /** Whether the OS-keychain unlock (Windows sign-in) is currently enabled —
   * offers it as a one-click alternative to typing the master password in
   * the unlock prompt above, same as VaultMenu's own locked-state view. */
  osUnlockAvailable?: boolean
  onUnlockWithOsAndSelectSession?: (profile: SessionProfile) => Promise<void>
  vaultUnlocked?: boolean
  /** Drags a session from one row onto another within the same folder
   * group, reordering the saved-sessions list. */
  onReorderSessions?: (draggedId: string, targetId: string) => void
  /** The caller's own connect form, rendered alongside the sidebar — except
   * while a per-profile unlock is pending, when it (and the sidebar) are
   * replaced entirely by the unlock card. Both states share the same outer
   * card chrome, which is why this component owns that chrome rather than
   * the caller. */
  /** Sessions were added by the PuTTY import, so the caller should re-read
   * the saved list — this component renders it but doesn't own it. */
  onSessionsImported?: () => void
  children: ReactNode
}

/** The saved-session half of the connect dialog: a folder/session sidebar,
 * its drag-reorder and context menu, and the per-profile vault-unlock
 * prompt — folder collapse, drag state and the unlock flow are folder/
 * session browsing concerns, not anything about the draft profile being
 * filled in alongside them, which is why this is a separate component
 * rather than more of ConnectDialog's own state. */
export function SessionBrowser({
  sessions,
  workspaces,
  onOpenWorkspace,
  onSelectSession,
  onEditSession,
  onDeleteSession,
  onWakeSession,
  onUnlockAndSelectSession,
  osUnlockAvailable,
  onUnlockWithOsAndSelectSession,
  onReorderSessions,
  vaultUnlocked,
  onSessionsImported,
  children,
}: Props) {
  const [menu, setMenu] = useState<{ profile: SessionProfile; x: number; y: number } | null>(null)
  const [pendingUnlock, setPendingUnlock] = useState<SessionProfile | null>(null)
  const [unlockPassword, setUnlockPassword] = useState('')
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [collapsedFolders, setCollapsedFolders] = useState(loadCollapsedFolders)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  // null until the check has run — the prompt must not flash on screen and
  // disappear on the (overwhelmingly common) machine with no PuTTY installed.
  const [puttyCount, setPuttyCount] = useState<number | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    // Asked at most once ever. Skipping the count entirely when the offer has
    // already been settled also avoids a registry read on every pane opened
    // for the rest of the app's life.
    if (isPuttyOfferSettled()) {
      setPuttyCount(0)
      return
    }
    // Best-effort: a failed check just means the offer isn't made. This runs
    // on a screen the user is looking at, so it must not raise anything.
    puttySessionCount()
      .then(setPuttyCount)
      .catch(() => setPuttyCount(0))
  }, [])

  function dismissPuttyOffer() {
    settlePuttyOffer()
    setPuttyCount(0)
  }

  async function importFromPutty() {
    setImporting(true)
    // Hidden regardless of the outcome — the offer has been acted on, and a
    // banner that stays put after the user acts on it reads as a failure.
    const added = await runPuttyImport()
    setPuttyCount(0)
    setImporting(false)
    if (added) onSessionsImported?.()
  }

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

  function toggleFolder(name: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      saveCollapsedFolders(next)
      return next
    })
  }

  const groups = new Map<string, SessionProfile[]>()
  for (const s of sessions ?? []) {
    const key = s.folder ?? 'Sessions'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }

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
            <button type="button" onClick={() => setPendingUnlock(null)} className="hover:text-white/70">
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
            {/* Above the session folders, because a workspace is the larger
                unit — "open all of this" rather than "open one of these" —
                and because arriving at a blank tab and having to leave the
                dialog for the toolbar to open one is the wrong first move. */}
            {workspaces && workspaces.length > 0 && onOpenWorkspace && (
              <div className="mb-1 border-b border-white/10 pb-1.5">
                <div className="px-2 py-1 font-medium tracking-wide text-white/30">WORKSPACES</div>
                {workspaces.map((w) => (
                  <div
                    key={w.id}
                    onClick={() => onOpenWorkspace(w)}
                    className="mx-1 flex cursor-pointer items-start gap-1.5 rounded px-2 py-1.5 text-white/70 transition-colors duration-100 hover:bg-white/[0.06]"
                    title={`Open ${w.name}`}
                  >
                    <LayoutGrid size={11} className="mt-0.5 shrink-0 text-sky-400/40" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-white/90">{w.name}</div>
                      <div className="truncate text-white/40">
                        {w.tabs.length === 1 ? '1 tab' : `${w.tabs.length} tabs`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
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
                        {s.hasCredential && <Lock size={10} className="mt-0.5 shrink-0 text-white/25" />}
                      </div>
                    ))}
                </div>
              )
            })}
          </div>
        )}
        <div className="flex min-w-0 flex-col">
          {/* A one-time offer, not a standing notice. This is the screen you
              see most, so an offer that reappears after you have already
              decided against it is nagging — both buttons settle it for good,
              and Settings → Import is where it lives from then on. Shown only
              when there is genuinely something to import, and above the form
              rather than in the sidebar because the sidebar doesn't render at
              all with no saved sessions, which is exactly the state a
              first-run migrating user is in. */}
          {puttyCount !== null && puttyCount > 0 && (
            // `w-0 min-w-full` is load-bearing: this is a flex sibling of the
            // connect form, so a wider intrinsic size here would widen the
            // whole column and push the form out with it. Zero intrinsic
            // width means the column is sized by the form alone, and the
            // min-width makes this render across whatever that turns out to
            // be. Without it, the banner's text decides how wide the dialog
            // is, which is nobody's intent.
            <div className="w-0 min-w-full border-b border-white/10 bg-sky-400/[0.07] px-4 py-2.5 text-xs">
              <p className="text-white/60">
                Found <span className="text-white/90">{puttyCount}</span> saved PuTTY{' '}
                {puttyCount === 1 ? 'session' : 'sessions'} on this machine.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={importing}
                  onClick={importFromPutty}
                  className="rounded bg-sky-500/90 px-2.5 py-1 font-medium text-white transition-colors duration-100 hover:bg-sky-500 disabled:opacity-50"
                >
                  {importing ? 'Importing...' : 'Import them'}
                </button>
                <button
                  type="button"
                  onClick={dismissPuttyOffer}
                  className="rounded px-2 py-1 text-white/50 transition-colors duration-100 hover:bg-white/10 hover:text-white/80"
                >
                  Not now
                </button>
                <span className="ml-auto text-white/30">Settings → Import</span>
              </div>
            </div>
          )}
          {children}
        </div>
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
          {/* Only for a session that has a MAC — the command behind it fails
              without one, and an item that can only report that isn't worth
              a row. Sits above Delete so the destructive item stays last. */}
          {menu.profile.wakeOnLan && (
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/80 transition-colors duration-100 hover:bg-white/10"
              onClick={() => {
                onWakeSession?.(menu.profile)
                setMenu(null)
              }}
            >
              <Zap size={13} /> Wake
            </button>
          )}
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
