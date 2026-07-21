import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pane } from './components/Pane'
import { Terminal } from './components/Terminal'
import { TabBar } from './components/TabBar'
import { QuickConnectPalette } from './components/QuickConnectPalette'
import { SettingsMenu } from './components/SettingsMenu'
import { VaultMenu } from './components/VaultMenu'
import { WorkspaceMenu } from './components/WorkspaceMenu'
import type { Workspace } from './lib/workspaces'
import * as workspaceApi from './lib/workspaces'
import { ToastHost } from './components/ToastHost'
import { WindowControls } from './components/WindowControls'
import { RestoreSessionsPrompt } from './components/RestoreSessionsPrompt'
import { StatusBar } from './components/StatusBar'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import {
  TerminalSquare,
  SplitSquareHorizontal,
  SplitSquareVertical,
  ScrollText,
  ArrowLeftRight,
  Folder,
  Search,
} from 'lucide-react'
import { toast } from './lib/toast'
import * as profiles from './lib/profiles'
import type { SessionProfile } from './lib/profiles'
import * as vault from './lib/vault'
import type { VaultStatus, VaultSecret } from './lib/vault'
import type { ConnectionSource } from './lib/connection'
import { sourceLabel } from './lib/connection'
import { loadSettings, saveSettings } from './lib/settings'
import { backgroundWithOpacity, backgroundTint, findTheme } from './lib/theme'
import { setWindowVibrancy } from './lib/windowEffects'
import { DRAG_PANE_MIME } from './lib/dragTypes'
import {
  allLeaves,
  blankLeaf,
  closeLeaf,
  findLeaf,
  firstLeaf,
  reidentify,
  splitLeaf,
  updateLeaf,
} from './lib/paneTree'
import * as sessionSnapshot from './lib/sessionSnapshot'
import type { SessionSnapshot } from './lib/sessionSnapshot'
import type { PaneLeaf, PaneNode, Tab } from './types'

/** Blanks the panes whose connection can only be resolved with an unlocked
 * vault, leaving everything else (telnet especially) intact. Those panes then
 * open on their connect form — which offers to unlock — instead of connecting
 * and failing.
 *
 * `prefill` rebuilds the form contents from the profile the pane referenced.
 * Without it a pane that was connected straight from the form (rather than
 * from the sidebar) carries no `initial`, and blanking its source would leave
 * an empty form with the host and username to re-enter by hand. */
function withoutVaultBoundSources(
  node: PaneNode,
  prefill: (profileId: string) => PaneLeaf['initial'],
): PaneNode {
  if (node.type === 'leaf') {
    if (node.source?.protocol !== 'sshProfile') return node
    return { ...node, source: null, initial: node.initial ?? prefill(node.source.profileId) }
  }
  return {
    ...node,
    children: [
      withoutVaultBoundSources(node.children[0], prefill),
      withoutVaultBoundSources(node.children[1], prefill),
    ],
  }
}

/** A tab holding one pane that has never connected — the state a new tab
 * starts in, showing the connect dialog. Opening a workspace from such a tab
 * should consume it rather than leave it stranded in front of the tabs it
 * just created. Any half-filled connect form in it goes too, which is fine:
 * choosing a workspace from that very form is choosing to move on. */
function isBlankTab(tab: Tab): boolean {
  const leaves = allLeaves(tab.root)
  return leaves.length === 1 && !leaves[0].source
}

function newTabId() {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// A leaf connected via a saved profile carries a `sshProfile` source whose
// only field is the profile's id — sourceLabel() for that variant returns
// the raw (UUID-looking) id, since resolving it to the profile's actual
// name requires the profile list, which isn't available down in lib/
// connection.ts. leaf.initial.label is filled in with the real name at
// connect time and is always the better title when present; every title
// computation should go through this instead of calling sourceLabel(source)
// directly, or a saved-profile pane's title regresses to its profile id
// the moment anything (focus, split, pop-out, attach) recomputes it.
function leafTitle(leaf: PaneLeaf, fallback: string): string {
  if (leaf.initial?.label) return leaf.initial.label
  if (leaf.source) return sourceLabel(leaf.source)
  return fallback
}

// Serial data-bits enum → the digit used in conventional framing notation
// (e.g. the "8" in "8N1"), for the status bar's serial detail string.
function dataBitsDigit(bits: 'Five' | 'Six' | 'Seven' | 'Eight'): number {
  return { Five: 5, Six: 6, Seven: 7, Eight: 8 }[bits]
}

function blankTab(): Tab {
  const leaf = blankLeaf()
  return { id: newTabId(), title: 'New Connection', root: leaf, activePaneId: leaf.id }
}

function refit() {
  // Terminal listens for window resize to re-fit; nudge it after a tab or
  // pane becomes visible/resized (it may have been sized while hidden).
  // A plain setTimeout(0) only guarantees "after this task," not "after the
  // browser has actually flushed layout for the newly-visible container" —
  // WebView2/Chromium schedules its layout/paint pipeline differently than
  // WebKitGTK, so the synthetic resize could fire before the container's
  // real size was settled, leaving xterm's fit computed against a
  // transitional size (visible as the cursor rendering a few columns off
  // right after a tab switch, self-correcting on the next full redraw).
  // Double rAF reliably waits for a completed paint first.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
  })
}

function App() {
  const [tabs, setTabs] = useState<Tab[]>(() => [blankTab()])
  const [activeTabId, setActiveTabId] = useState<string | null>(() => tabs[0]?.id ?? null)
  const [paneDragOverSpacer, setPaneDragOverSpacer] = useState(false)
  const [statusByPane, setStatusByPane] = useState<Record<string, string>>({})
  // Set by the toolbar search button to ask one specific pane's terminal to
  // open its search box (the box itself is per-Terminal local state, so this
  // is how an App-level control reaches into it). Targeted by pane id — not a
  // broadcast — because every tab has its own focused pane, so a plain signal
  // would open search in background tabs too. The nonce lets a repeat click on
  // the same pane re-fire.
  const [searchRequest, setSearchRequest] = useState<{ nonce: number; paneId: string } | null>(null)
  // Epoch ms a pane reached 'connected', for the status bar's uptime readout.
  // Set on the connected transition, cleared on any other status (see the
  // onStatus handler) so a reconnect restarts the clock rather than counting
  // through the outage.
  const [connectedAtByPane, setConnectedAtByPane] = useState<Record<string, number>>({})
  const [loggingByPane, setLoggingByPane] = useState<Record<string, boolean>>({})
  const [forwardsOpenByPane, setForwardsOpenByPane] = useState<Record<string, boolean>>({})
  const [filesOpenByPane, setFilesOpenByPane] = useState<Record<string, boolean>>({})
  const [sessionIdByPane, setSessionIdByPane] = useState<Record<string, string | null>>({})
  const [profilesVersion, setProfilesVersion] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // Kept fresh here (rather than fetched lazily wherever it's needed) since
  // it now backs both the quick-connect palette and the saved-sessions
  // sidebar inside every blank pane's connect dialog.
  const [sessions, setSessions] = useState<SessionProfile[]>([])
  useEffect(() => {
    profiles.listSessions().then(setSessions).catch(() => setSessions([]))
  }, [profilesVersion])
  // Held here rather than fetched by WorkspaceMenu, so the connect dialog's
  // sidebar and the toolbar menu read the same list and a save in one is
  // immediately visible in the other.
  const [workspacesVersion, setWorkspacesVersion] = useState(0)
  const [savedWorkspaces, setSavedWorkspaces] = useState<Workspace[]>([])
  useEffect(() => {
    workspaceApi
      .listWorkspaces()
      .then(setSavedWorkspaces)
      .catch(() => setSavedWorkspaces([]))
  }, [workspacesVersion])
  const [terminalSettings, setTerminalSettings] = useState(() => loadSettings())
  // Mirrors vibrancyMode/theme/opacity to the native window on every change
  // ('off' still round-trips through the Rust side, which clears both
  // effects unconditionally — the no-op case just costs one IPC call).
  useEffect(() => {
    const { backgroundOpacity, themeName, vibrancyMode } = terminalSettings
    const tint = backgroundTint(findTheme(themeName), backgroundOpacity)
    setWindowVibrancy(vibrancyMode, tint).catch(() => {})
  }, [terminalSettings.backgroundOpacity, terminalSettings.themeName, terminalSettings.vibrancyMode])
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>('uninitialized')
  const [osUnlockAvailable, setOsUnlockAvailable] = useState(false)
  const [maximized, setMaximized] = useState(false)
  // A previous run's session snapshot, awaiting Restore/Discard — set once
  // at startup (see the mount effect below) and cleared either way. Nothing
  // writes a fresh snapshot until this is resolved, so an unanswered prompt
  // can't have its own answer overwritten by the still-default blank tab
  // underneath it.
  const [pendingRestore, setPendingRestore] = useState<SessionSnapshot | null>(null)
  /** A workspace waiting on a vault unlock before its tabs are materialised,
   * with the tab it was launched from so that survives the prompt. */
  const [pendingWorkspace, setPendingWorkspace] = useState<{
    workspace: Workspace
    originTabId: string | null
  } | null>(null)
  const [restoreDecided, setRestoreDecided] = useState(false)
  // Every live <Terminal> is mounted exactly once here, in a flat pool keyed
  // by pane id, and portaled into whichever "slot" div currently represents
  // its position (see Pane.tsx). Dragging a connection between tabs/splits
  // only ever changes which slot its portal points at — the Terminal
  // component itself, and the session/xterm instance it owns, never
  // unmounts, so the live connection survives the move untouched.
  const [slots, setSlots] = useState<Record<string, HTMLDivElement>>({})

  // Stable across renders (empty deps — setSlots itself is guaranteed
  // stable by React) so that the per-leaf ref callbacks built from it in
  // Pane.tsx can themselves stay stable. Without that, a fresh callback
  // identity every render makes React think the ref "changed" on every
  // single render, perpetually detaching and reattaching it — each of
  // which calls setSlots, triggering another render, forever.
  const registerSlot = useCallback((paneId: string, el: HTMLDivElement | null) => {
    setSlots((prev) => {
      if (el) {
        if (prev[paneId] === el) return prev
        return { ...prev, [paneId]: el }
      }
      if (!(paneId in prev)) return prev
      const next = { ...prev }
      delete next[paneId]
      return next
    })
  }, [])

  // React's own reconciler (updatePortal, in react-dom's createChildReconciler)
  // discards and recreates a portal's entire subtree whenever the target
  // container passed to createPortal differs from the previous render's —
  // *even when the key is identical*. Splitting a pane or popping it to a
  // new tab reparents PaneLeafView in the React tree (it switches position
  // between a plain leaf and a child of a new PanelGroup), which unmounts
  // and remounts it, producing a brand new slot div — so portaling directly
  // into `slots[leaf.id]` (whatever it currently is) forces exactly this
  // "different container" case, tearing down and reconnecting the live
  // session, no matter how briefly the container changes. (Two earlier
  // attempts assumed the cause was a timing gap where the slot went
  // missing — a fixed delay, then a hidden fallback container — and both
  // still hit this, since switching between real-slot and fallback is
  // itself a container change.)
  //
  // The fix: never change what a leaf's portal targets. Each connected leaf
  // gets exactly one permanent container div, created once and portaled
  // into for its entire connected lifetime; a layout effect below physically
  // relocates *that same div* (plain DOM appendChild, invisible to React)
  // into whichever slot currently represents its position. The div's
  // identity — and therefore React's containerInfo — never changes, so
  // updatePortal always takes the "reuse" branch.
  const homeContainers = useRef<Record<string, HTMLDivElement>>({})

  function getHomeContainer(paneId: string): HTMLDivElement {
    let el = homeContainers.current[paneId]
    if (!el) {
      el = document.createElement('div')
      el.style.position = 'fixed'
      el.style.top = '0'
      el.style.left = '0'
      el.style.width = '0'
      el.style.height = '0'
      el.style.overflow = 'hidden'
      el.style.pointerEvents = 'none'
      document.body.appendChild(el)
      homeContainers.current[paneId] = el
    }
    return el
  }

  // Runs after every commit (so after a slot div's own mount/unmount has
  // already happened) and physically moves each connected leaf's permanent
  // container into its current slot, or parks it invisibly off-tree if it
  // doesn't have one at the moment — using useLayoutEffect rather than
  // useEffect so the move happens before the browser paints, avoiding a
  // visible flash of the pane looking empty.
  useLayoutEffect(() => {
    for (const paneId of Object.keys(homeContainers.current)) {
      const home = homeContainers.current[paneId]
      const slot = slots[paneId]
      if (slot && home.parentElement !== slot) {
        home.style.position = 'relative'
        home.style.inset = ''
        home.style.width = '100%'
        home.style.height = '100%'
        home.style.overflow = ''
        home.style.pointerEvents = ''
        slot.appendChild(home)
      } else if (!slot && home.parentElement !== document.body) {
        home.style.position = 'fixed'
        home.style.inset = '0'
        home.style.width = '0'
        home.style.height = '0'
        home.style.overflow = 'hidden'
        home.style.pointerEvents = 'none'
        document.body.appendChild(home)
      }
    }
  })

  // The window starts hidden (see tauri.conf.json) specifically so this can
  // show it only once real content is actually painted — tauri-plugin-
  // window-state restores saved size/position via an on_window_ready hook
  // that fires after the window's already been created (and, if visible by
  // default, already shown) at tauri.conf.json's plain 800x600 fallback, so
  // a visible-by-default window flashes at the wrong size for a moment
  // before snapping to its restored geometry. Waiting for this effect
  // (which only runs after the browser has painted this component's first
  // render) means the window only ever appears already correctly sized and
  // already showing the real UI, not a flash of blank/wrong-sized chrome.
  useEffect(() => {
    getCurrentWindow()
      .show()
      .catch(() => {})
  }, [])

  // Rounded corners only make sense for a floating window — a maximized
  // one should fill the screen edge-to-edge like any other app.
  useEffect(() => {
    const win = getCurrentWindow()
    win.isMaximized().then(setMaximized)
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setMaximized)
    })
    return () => {
      unlisten.then((f) => f())
    }
  }, [])

  function updateSettings(next: typeof terminalSettings) {
    setTerminalSettings(next)
    saveSettings(next)
  }

  function refreshVaultStatus() {
    vault
      .status()
      .then(setVaultStatus)
      .catch(() => {})
    // Kept alongside vault status (rather than only fetched inside
    // VaultMenu) so the locked-session unlock prompt in the connect
    // dialog's sidebar can also offer "Unlock with Windows sign-in".
    vault
      .osUnlockAvailable()
      .then(setOsUnlockAvailable)
      .catch(() => setOsUnlockAvailable(false))
    // A vault import replaces sessions.json too (they're exported as one
    // bundle — see vault_export/vault_import), so anything that can change
    // vault status also potentially changed the saved-sessions list.
    setProfilesVersion((v) => v + 1)
  }

  useEffect(() => {
    refreshVaultStatus()
  }, [])

  // The vault can also get locked from the Rust side with no frontend
  // command in flight (Windows session-lock auto-lock) — without this, the
  // vault menu would keep showing "unlocked" until something unrelated
  // happened to trigger a refresh.
  useEffect(() => {
    const unlisten = listen('vault-locked', () => refreshVaultStatus())
    return () => {
      unlisten.then((fn) => fn())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Runs once at startup, before anything has a chance to overwrite last
  // run's snapshot: if the setting is on and a snapshot with at least one
  // restorable session exists, hold off on deciding anything (leaves the
  // default blank tab showing underneath the prompt) until the user answers
  // it. Otherwise there's nothing to ask about — mark it decided immediately
  // so the persist-on-change effect below is free to start writing.
  useEffect(() => {
    if (!terminalSettings.restoreSessionsOnLaunch) {
      setRestoreDecided(true)
      return
    }
    const snapshot = sessionSnapshot.loadSnapshot()
    if (snapshot && sessionSnapshot.countSessions(snapshot.tabs) > 0) {
      setPendingRestore(snapshot)
    } else {
      setRestoreDecided(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keeps the on-disk snapshot current as tabs/panes change, rather than
  // only writing it on a clean exit — a crash or force-quit shouldn't lose
  // it either. Gated on restoreDecided so this can't fire (and overwrite
  // the very snapshot being offered) before the startup prompt is answered.
  useEffect(() => {
    if (!restoreDecided) return
    sessionSnapshot.saveSnapshot(tabs, activeTabId)
  }, [tabs, activeTabId, restoreDecided])

  function applyRestore(snapshot: SessionSnapshot) {
    setTabs(snapshot.tabs)
    setActiveTabId(snapshot.activeTabId)
    setPendingRestore(null)
    setRestoreDecided(true)
  }

  function discardRestore() {
    sessionSnapshot.clearSnapshot()
    setPendingRestore(null)
    setRestoreDecided(true)
  }

  function restoreSessions() {
    if (pendingRestore) applyRestore(pendingRestore)
  }

  async function unlockAndRestoreSessions(password: string) {
    if (!pendingRestore) return
    await vault.unlock(password)
    refreshVaultStatus()
    applyRestore(pendingRestore)
  }

  async function unlockWithOsAndRestoreSessions() {
    if (!pendingRestore) return
    await vault.unlockWithOs()
    // The Windows Hello/PIN prompt is a native OS-level dialog, not an
    // in-page one — closing it doesn't hand keyboard focus back to our
    // window the way dismissing a normal modal does, so without this the
    // terminal's own auto-focus (in Terminal.tsx, once it connects) lands
    // on a window that isn't actually focused.
    getCurrentWindow()
      .setFocus()
      .catch(() => {})
    refreshVaultStatus()
    applyRestore(pendingRestore)
  }

  function newTab() {
    const tab = blankTab()
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (activeTabId === id) {
        const idx = prev.findIndex((t) => t.id === id)
        const neighbor = next[idx] ?? next[idx - 1] ?? null
        setActiveTabId(neighbor?.id ?? null)
      }
      return next
    })
  }

  function selectTab(id: string) {
    setActiveTabId(id)
    refit()
  }

  function reorderTabs(draggedId: string, targetId: string) {
    if (draggedId === targetId) return
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === draggedId)
      const to = prev.findIndex((t) => t.id === targetId)
      if (from === -1 || to === -1) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  function stepTab(delta: 1 | -1) {
    if (tabs.length === 0) return
    const idx = tabs.findIndex((t) => t.id === activeTabId)
    const next = tabs[(idx + delta + tabs.length) % tabs.length]
    if (next) selectTab(next.id)
  }

  /** Duplicates the tab's active pane's session into a new single-pane tab. */
  function duplicateTab(id: string) {
    const sourceTab = tabs.find((t) => t.id === id)
    if (!sourceTab) return
    const activeLeaf = allLeaves(sourceTab.root).find((l) => l.id === sourceTab.activePaneId)
    if (!activeLeaf?.source) return
    const leaf = blankLeaf()
    leaf.source = activeLeaf.source
    leaf.initial = activeLeaf.initial
    const tab: Tab = { id: newTabId(), title: sourceTab.title, root: leaf, activePaneId: leaf.id }
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }

  /** Reconnects one specific pane in place (generation bump remounts its
   * Terminal, which reconnects). */
  function reconnectPane(tabId: string, paneId: string) {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? {
              ...t,
              root: updateLeaf(t.root, paneId, (l) => ({
                ...l,
                // Re-resolve from the profile instead of replaying the source
                // baked in at the original connect time — otherwise editing a
                // profile's host/port after connecting has no effect on
                // Reconnect, since sshProfile sources are the only ones
                // re-read fresh from disk on connect.
                source: l.initial?.id ? { protocol: 'sshProfile', profileId: l.initial.id } : l.source,
                generation: l.generation + 1,
              })),
            }
          : t,
      ),
    )
  }

  /** Reconnects the tab's active pane in place (the tab-context-menu action). */
  function reconnectTab(id: string) {
    const tab = tabs.find((t) => t.id === id)
    if (tab) reconnectPane(id, tab.activePaneId)
  }

  /** Adds a saved workspace's tabs to the window and focuses its first.
   *
   * Additive rather than replacing: opening a workspace must never close live
   * sessions someone is in the middle of. Opening the same one twice gives
   * duplicate tabs, which is visible and closable — the opposite mistake
   * isn't recoverable.
   *
   * When `vaultUsable` is false, panes that would need the vault open on
   * their (prefilled) connect form instead of carrying a source that can only
   * fail. Mounting them with the source intact is what made every tab in a
   * workspace come up as "vault is locked" with no way forward.
   */
  function materializeWorkspace(
    workspace: Workspace,
    vaultUsable: boolean,
    originTabId?: string | null,
  ) {
    const restored: Tab[] = workspace.tabs.map((t) => {
      const root = reidentify(
        vaultUsable
          ? t.root
          : withoutVaultBoundSources(t.root, (profileId) => {
              const p = sessions.find((s) => s.id === profileId)
              return p ? profileToInitial(p) : undefined
            }),
      )
      return { ...t, id: newTabId(), root, activePaneId: firstLeaf(root).id }
    })
    if (restored.length === 0) return
    setTabs((prev) => {
      // Consume the tab this was launched from when it has nothing in it —
      // typically the blank tab whose connect dialog was just used. Splicing
      // rather than appending also puts the workspace where that tab sat,
      // instead of after everything else.
      const target = originTabId ?? activeTabId
      const index = prev.findIndex((t) => t.id === target)
      if (index === -1 || !isBlankTab(prev[index])) return [...prev, ...restored]
      return [...prev.slice(0, index), ...restored, ...prev.slice(index + 1)]
    })
    setActiveTabId(restored[0].id)
  }

  /** Gates on the vault the same way the launch-restore flow does, rather
   * than letting each pane discover the lock separately and fail. */
  /** `originTabId` is the tab whose connect dialog launched this, so it can
   * be consumed rather than left empty in front of the new tabs. Absent (the
   * toolbar menu) falls back to the active tab, which is blank often enough
   * for the same tidy-up to apply. */
  function openWorkspace(workspace: Workspace, originTabId?: string) {
    // Only 'locked' is worth prompting for. With no vault created at all
    // there is nothing to unlock, so those panes go straight to their connect
    // forms rather than showing an unlock dialog that can't help.
    if (sessionSnapshot.needsVaultUnlock(workspace.tabs) && vaultStatus === 'locked') {
      // The origin has to survive the prompt, or unlocking would materialise
      // the workspace next to the blank tab instead of over it.
      setPendingWorkspace({ workspace, originTabId: originTabId ?? activeTabId })
      return
    }
    materializeWorkspace(workspace, vaultStatus === 'unlocked', originTabId)
  }

  function openPendingWorkspace() {
    if (!pendingWorkspace) return
    const { workspace, originTabId } = pendingWorkspace
    materializeWorkspace(workspace, vaultStatus === 'unlocked', originTabId)
    setPendingWorkspace(null)
  }

  async function unlockAndOpenWorkspace(password: string) {
    if (!pendingWorkspace) return
    const { workspace, originTabId } = pendingWorkspace
    await vault.unlock(password)
    refreshVaultStatus()
    materializeWorkspace(workspace, true, originTabId)
    setPendingWorkspace(null)
  }

  async function unlockWithOsAndOpenWorkspace() {
    if (!pendingWorkspace) return
    const { workspace, originTabId } = pendingWorkspace
    await vault.unlockWithOs()
    // Same native-prompt focus problem as the launch-restore path.
    getCurrentWindow()
      .setFocus()
      .catch(() => {})
    refreshVaultStatus()
    materializeWorkspace(workspace, true, originTabId)
    setPendingWorkspace(null)
  }

  function connectPane(
    tabId: string,
    paneId: string,
    source: ConnectionSource,
    logSession = false,
    paneOptions?: { backspaceSendsCtrlH: boolean | null },
  ) {
    // Set logging state before the source, so the Terminal mounts with logging
    // already armed and captures output from the first byte (batched with the
    // setTabs below in the same event, so it's a single render). The toolbar
    // icon then reflects this and can stop it mid-session.
    setLoggingByPane((prev) => ({ ...prev, [paneId]: logSession }))
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t
        const root = updateLeaf(t.root, paneId, (l) => ({
          ...l,
          source,
          backspaceSendsCtrlH: paneOptions?.backspaceSendsCtrlH ?? null,
        }))
        const leaf = allLeaves(root).find((l) => l.id === paneId)
        const title = paneId === t.activePaneId && leaf ? leafTitle(leaf, t.title) : t.title
        return { ...t, root, title }
      }),
    )
  }

  /** Clears a pane's connection back to blank (reopening the connect
   * dialog in place) without touching the rest of the tab/tree — the only
   * way back for a pane whose connection failed (bad credential, unreachable
   * host, etc.), since closing it would otherwise take any sibling panes in
   * the same split down with it too, and simply retrying replays the exact
   * same failing source. `initial` is kept (not cleared) so the dialog
   * reopens pre-filled with the same profile, in case the fix is just
   * editing it (e.g. re-importing a missing vaulted key) rather than
   * picking something else entirely. */
  function disconnectPane(tabId: string, paneId: string) {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t
        const root = updateLeaf(t.root, paneId, (l) => ({ ...l, source: null }))
        const leaf = allLeaves(root).find((l) => l.id === paneId)
        const title = paneId === t.activePaneId && leaf ? leafTitle(leaf, t.title) : t.title
        return { ...t, root, title }
      }),
    )
  }

  function focusPane(tabId: string, paneId: string) {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId || t.activePaneId === paneId) return t
        const leaf = allLeaves(t.root).find((l) => l.id === paneId)
        return {
          ...t,
          activePaneId: paneId,
          title: leaf ? leafTitle(leaf, t.title) : t.title,
        }
      }),
    )
  }

  function splitPane(tabId: string, paneId: string, direction: 'horizontal' | 'vertical') {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t
        const root = splitLeaf(t.root, paneId, direction)
        const newLeafId = allLeaves(root).find((l) => !allLeaves(t.root).some((old) => old.id === l.id))?.id
        return { ...t, root, activePaneId: newLeafId ?? t.activePaneId }
      }),
    )
    refit()
  }

  function toggleLogging(paneId: string) {
    setLoggingByPane((prev) => ({ ...prev, [paneId]: !prev[paneId] }))
  }

  function toggleForwards(paneId: string) {
    setForwardsOpenByPane((prev) => ({ ...prev, [paneId]: !prev[paneId] }))
    // Both panels anchor to the same corner of the pane — keep them
    // mutually exclusive rather than stacking or overlapping.
    setFilesOpenByPane((prev) => ({ ...prev, [paneId]: false }))
  }

  function closeForwards(paneId: string) {
    setForwardsOpenByPane((prev) => ({ ...prev, [paneId]: false }))
  }

  function toggleFiles(paneId: string) {
    setFilesOpenByPane((prev) => ({ ...prev, [paneId]: !prev[paneId] }))
    setForwardsOpenByPane((prev) => ({ ...prev, [paneId]: false }))
  }

  function closeFiles(paneId: string) {
    setFilesOpenByPane((prev) => ({ ...prev, [paneId]: false }))
  }

  function closePane(tabId: string, paneId: string) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    const newRoot = closeLeaf(tab.root, paneId)
    if (!newRoot) {
      closeTab(tabId)
      return
    }
    const activePaneId = tab.activePaneId === paneId ? firstLeaf(newRoot).id : tab.activePaneId
    // Same reasoning as popPaneToNewTab below: the tab's title may have been
    // describing the pane that just closed (e.g. you closed the one that was
    // focused), so it needs to follow whichever pane is left behind as
    // active now instead of staying stuck on the closed pane's old title.
    const activeLeaf = allLeaves(newRoot).find((l) => l.id === activePaneId)
    const title = activeLeaf ? leafTitle(activeLeaf, tab.title) : tab.title
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, root: newRoot, activePaneId, title } : t)))
    refit()
  }

  /** Extracts a pane out of its (split) tab into its own new tab. The leaf
   * object — and the pooled Terminal/session it identifies — carries over
   * untouched; only its tree position changes. */
  function popPaneToNewTab(tabId: string, paneId: string) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    const leaf = findLeaf(tab.root, paneId)
    const newRoot = closeLeaf(tab.root, paneId)
    if (!leaf || !newRoot) return // only offered when the tab actually has a split
    const newActivePaneId = tab.activePaneId === paneId ? firstLeaf(newRoot).id : tab.activePaneId
    const poppedTab: Tab = {
      id: newTabId(),
      title: leafTitle(leaf, 'New Connection'),
      root: leaf,
      activePaneId: leaf.id,
    }
    // The remaining tab's title may have been describing the pane that
    // just left — e.g. it was named after the pane you're popping out —
    // so it needs to follow whichever pane is left behind as active now,
    // the same way focusPane already does when switching panes normally.
    const remainingActiveLeaf = allLeaves(newRoot).find((l) => l.id === newActivePaneId)
    const remainingTitle = remainingActiveLeaf ? leafTitle(remainingActiveLeaf, tab.title) : tab.title
    setTabs((prev) => [
      ...prev.map((t) =>
        t.id === tabId ? { ...t, root: newRoot, activePaneId: newActivePaneId, title: remainingTitle } : t,
      ),
      poppedTab,
    ])
    setActiveTabId(poppedTab.id)
    refit()
  }

  /** Attaches a dragged tab's connection into an empty pane elsewhere,
   * closing the tab it came from. Same principle as popPaneToNewTab: the
   * leaf object moves, its id (and therefore its pooled Terminal) doesn't
   * change, so the live session is untouched by the move. */
  function attachTabToPane(targetPaneId: string, draggedTabId: string) {
    const draggedTab = tabs.find((t) => t.id === draggedTabId)
    if (!draggedTab || draggedTab.root.type !== 'leaf' || !draggedTab.root.source) return
    const draggedLeaf: PaneLeaf = draggedTab.root
    const withoutDragged = tabs.filter((t) => t.id !== draggedTabId)
    const next = withoutDragged.map((t) => {
      if (!findLeaf(t.root, targetPaneId)) return t
      const root = updateLeaf(t.root, targetPaneId, () => draggedLeaf)
      // The attached leaf keeps the dragged leaf's own id (not
      // targetPaneId) — see the comment above this function — so
      // activePaneId, if it was pointing at targetPaneId, is left
      // referencing an id that no longer exists anywhere in the tree
      // unless it's remapped onto the new one here. Left stale, it
      // silently breaks every later lookup keyed off activePaneId — not
      // just the active-pane highlight, but e.g. popPaneToNewTab's title
      // recompute too, since its "is this the pane that's active" check
      // can never match again.
      const activePaneId = t.activePaneId === targetPaneId ? draggedLeaf.id : t.activePaneId
      // Same reasoning as connectPane: only follow the newly-attached
      // connection if it landed on the tab's actual active pane, so an
      // attach into some other (non-focused) split pane doesn't rename a
      // tab that's still showing something else.
      const title = targetPaneId === t.activePaneId ? leafTitle(draggedLeaf, t.title) : t.title
      return { ...t, root, activePaneId, title }
    })
    setTabs(next)
    if (activeTabId === draggedTabId) {
      const idx = tabs.findIndex((t) => t.id === draggedTabId)
      const neighbor = next[idx] ?? next[idx - 1] ?? null
      setActiveTabId(neighbor?.id ?? null)
    }
    refit()
    toast.success(`Attached ${leafTitle(draggedLeaf, sourceLabel(draggedLeaf.source!))}`)
  }

  function profileToInitial(profile: SessionProfile): PaneLeaf['initial'] {
    return {
      id: profile.id,
      protocol: profile.protocol,
      label: profile.label,
      folder: profile.folder,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authType:
        profile.authType === 'password'
          ? 'Password'
          : profile.authType === 'agent'
            ? 'Agent'
            : 'PublicKey',
      keyPath: profile.keyPath ?? undefined,
      hasCredential: profile.hasCredential,
      jumpProfileId: profile.jumpProfileId,
      termType: profile.termType,
      backspaceSendsCtrlH: profile.backspaceSendsCtrlH,
    }
  }

  // Shared by both "open in a new tab" (openSavedSession) and "load into
  // this pane" (connectPaneFromProfile): resolves whether we can skip the
  // manual connect form and go straight to connecting, with the secret (if
  // any) resolved on the Rust side, never sent to the frontend — plus the
  // prefill data for the connect form either way.
  //
  // Password auth always needs a secret to connect at all, so it only goes
  // direct when the vault actually has one saved. Public-key auth doesn't
  // necessarily need one — an unencrypted key connects fine with no
  // passphrase — and there's no way to know from here whether the key on
  // disk is actually encrypted, so it always goes direct (once the vault is
  // unlocked); if the key does turn out to need a passphrase that isn't
  // saved, the connection just fails the same way a stale saved password
  // would, which this app already treats as an acceptable outcome of
  // auto-connecting rather than a reason to withhold it.
  //
  // Agent auth needs neither a secret nor an unlocked vault — the agent holds
  // the key — so it always connects direct, and notably does *not* wait on
  // the vault the way the other two do.
  async function resolveProfileSource(profile: SessionProfile) {
    // Telnet has no credential to resolve and nothing for the Rust side to
    // look up, so it connects straight from the profile's own fields — no
    // vault involvement, and no `telnetProfile` source variant needed.
    if (profile.protocol === 'telnet') {
      return {
        source: {
          protocol: 'telnet' as const,
          config: { host: profile.host, port: profile.port, term_type: profile.termType },
        },
        initial: profileToInitial(profile),
      }
    }

    const canConnectDirect =
      profile.authType === 'agent' ||
      (vaultStatus === 'unlocked' &&
        (profile.authType === 'public_key' ||
          (await vault.hasCredential(profile.id).catch(() => false))))
    const source: ConnectionSource | null = canConnectDirect
      ? { protocol: 'sshProfile', profileId: profile.id }
      : null
    return { source, initial: profileToInitial(profile) }
  }

  async function openSavedSession(profile: SessionProfile) {
    const { source, initial } = await resolveProfileSource(profile)
    const leaf = blankLeaf()
    leaf.source = source
    leaf.initial = initial
    const tab: Tab = { id: newTabId(), title: profile.label, root: leaf, activePaneId: leaf.id }
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }

  /** Applies a source/initial pair to an already-open pane, in place —
   * shared by connectPaneFromProfile, editPaneFromProfile, and
   * unlockVaultAndConnectProfile below. */
  function applyProfileToPane(
    tabId: string,
    paneId: string,
    source: ConnectionSource | null,
    initial: PaneLeaf['initial'],
  ) {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t
        // Also carried onto the leaf directly: connecting straight from the
        // sidebar never opens the dialog, so this is the only path by which
        // a saved session's backspace preference reaches its terminal.
        const root = updateLeaf(t.root, paneId, (l) => ({
          ...l,
          source: source ?? l.source,
          initial,
          backspaceSendsCtrlH: initial?.backspaceSendsCtrlH ?? null,
        }))
        const leaf = allLeaves(root).find((l) => l.id === paneId)
        const title = paneId === t.activePaneId && leaf ? leafTitle(leaf, t.title) : t.title
        return { ...t, root, title }
      }),
    )
  }

  /** Loads a saved session into an already-open (blank) pane, in place —
   * used by the saved-sessions sidebar inside that pane's own connect
   * dialog, so picking a session there doesn't spawn a whole new tab. */
  async function connectPaneFromProfile(tabId: string, paneId: string, profile: SessionProfile) {
    const { source, initial } = await resolveProfileSource(profile)
    applyProfileToPane(tabId, paneId, source, initial)
  }

  /** Populates the form from this profile without ever auto-connecting —
   * the only way to edit a session's saved details rather than just reuse
   * them, since a plain pick auto-connects whenever the vault already has
   * a credential for it. */
  function editPaneFromProfile(tabId: string, paneId: string, profile: SessionProfile) {
    applyProfileToPane(tabId, paneId, null, profileToInitial(profile))
  }

  /** Unlocks the vault with a freshly-typed master password, then connects
   * the picked session exactly as it would have if the vault had already
   * been unlocked — checking `hasCredential` fresh against the Rust side
   * rather than trusting `vaultStatus` React state, which wouldn't have
   * caught up yet at this point in the same call. */
  async function unlockVaultAndConnectProfile(
    tabId: string,
    paneId: string,
    profile: SessionProfile,
    password: string,
  ) {
    await vault.unlock(password)
    refreshVaultStatus()
    const hasCredential = await vault.hasCredential(profile.id).catch(() => false)
    const source: ConnectionSource | null = hasCredential
      ? { protocol: 'sshProfile', profileId: profile.id }
      : null
    applyProfileToPane(tabId, paneId, source, profileToInitial(profile))
  }

  /** Same as unlockVaultAndConnectProfile, but via the OS-keychain unlock
   * (Windows sign-in, gated by a fresh Windows Hello/PIN check on Windows)
   * instead of a typed master password. */
  async function unlockWithOsAndConnectProfile(
    tabId: string,
    paneId: string,
    profile: SessionProfile,
  ) {
    await vault.unlockWithOs()
    // See the identical comment in unlockWithOsAndRestoreSessions — the
    // native OS unlock prompt doesn't return keyboard focus to our window
    // on its own, which otherwise left the freshly-connected terminal's
    // auto-focus call landing on an unfocused window.
    getCurrentWindow()
      .setFocus()
      .catch(() => {})
    refreshVaultStatus()
    const hasCredential = await vault.hasCredential(profile.id).catch(() => false)
    const source: ConnectionSource | null = hasCredential
      ? { protocol: 'sshProfile', profileId: profile.id }
      : null
    applyProfileToPane(tabId, paneId, source, profileToInitial(profile))
  }

  function deleteSessionProfile(profile: SessionProfile) {
    // Deleting the profile doesn't touch the vault on its own — without
    // this, a profile with hasCredential would leave its actual credential
    // orphaned in the vault forever, keyed by an id nothing references
    // anymore. Best-effort: the profile itself is still gone either way,
    // even if the vault happens to be locked right now and can't be
    // reached (nothing else currently offers a way to remove a single
    // orphaned entry, but it's harmless sitting unused).
    if (profile.hasCredential) {
      vault.deleteCredential(profile.id).catch(() => {})
    }
    profiles
      .deleteSession(profile.id)
      .then(() => {
        setProfilesVersion((v) => v + 1)
        toast.info(`Deleted "${profile.label}"`)
      })
      .catch((err) => toast.error(`Couldn't delete session: ${err}`))
  }

  // Returns the promise so ConnectDialog can await the write before
  // connecting through the profile it just saved — otherwise the connection
  // reads whatever was on disk beforehand.
  function saveProfile(profile: SessionProfile) {
    return profiles
      .saveSession(profile)
      .then(() => {
        setProfilesVersion((v) => v + 1)
        toast.success(`Saved session "${profile.label}"`)
      })
      .catch((err) => toast.error(`Couldn't save session: ${err}`))
  }

  function reorderSessions(draggedId: string, targetId: string) {
    if (draggedId === targetId) return
    setSessions((prev) => {
      const from = prev.findIndex((s) => s.id === draggedId)
      const to = prev.findIndex((s) => s.id === targetId)
      if (from === -1 || to === -1) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      profiles
        .reorderSessions(next.map((s) => s.id))
        .catch((err) => toast.error(`Couldn't reorder sessions: ${err}`))
      return next
    })
  }

  function saveCredential(profileId: string, secret: VaultSecret) {
    vault
      .setCredential(profileId, secret)
      .then(() => toast.success('Credential saved to vault'))
      .catch((err) => toast.error(`Couldn't save credential: ${err}`))
  }

  function importKeyToVault(profileId: string, keyPath: string, passphrase: string | null) {
    vault
      .importKey(profileId, keyPath, passphrase)
      .then(() => toast.success('Key stored in vault'))
      .catch((err) => toast.error(`Couldn't store key in vault: ${err}`))
  }

  function deleteCredentialFromVault(profileId: string) {
    vault.deleteCredential(profileId).catch(() => {})
  }

  function openPalette() {
    setPaletteOpen(true)
  }

  // Keydown handlers close over state that changes every render; rather than
  // re-subscribing the listener on every change, keep a ref to the latest
  // callbacks and mount the listener once.
  const shortcutsRef = useRef({ newTab, closeTab, stepTab, openPalette, activeTabId })
  shortcutsRef.current = { newTab, closeTab, stepTab, openPalette, activeTabId }

  useEffect(() => {
    // Capture phase so these fire before xterm's own keydown handler can
    // treat them as shell input (e.g. Ctrl+W deletes a word in most
    // shells, so tab shortcuts intentionally avoid plain Ctrl combos).
    function onKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey) return
      const s = shortcutsRef.current

      if (e.key === 'Tab') {
        e.preventDefault()
        s.stepTab(e.shiftKey ? -1 : 1)
      } else if (e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        s.newTab()
      } else if (e.shiftKey && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        if (s.activeTabId) s.closeTab(s.activeTabId)
      } else if (e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        s.openPalette()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // Split/logging/port-forwarding controls act on whichever pane is
  // currently focused, rather than living as buttons on the pane itself.
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeLeaf = activeTab && allLeaves(activeTab.root).find((l) => l.id === activeTab.activePaneId)
  const activePaneId = activeTab?.activePaneId
  const activeIsSsh =
    activeLeaf?.source?.protocol === 'ssh' || activeLeaf?.source?.protocol === 'sshProfile'
  const activeSessionId = activePaneId ? (sessionIdByPane[activePaneId] ?? null) : null

  // Status-bar readout for the active pane: a display protocol tag plus a
  // resolved target string. sshProfile carries only an id, so its label is
  // looked up from saved sessions; serial appends its baud + framing (e.g.
  // "115200 8N1") since that's the identifying detail for a serial link.
  const activePaneLeaves = activeTab ? allLeaves(activeTab.root) : []
  const statusBarConn = ((): { protocol: string; target: string } | null => {
    const src = activeLeaf?.source
    if (!src) return null
    switch (src.protocol) {
      case 'ssh':
        // sourceLabel gives user@host; append the port here so the status bar
        // shows the full endpoint (useful when it isn't the default 22).
        return { protocol: 'SSH', target: `${sourceLabel(src)}:${src.config.port}` }
      case 'sshProfile': {
        const p = sessions.find((s) => s.id === src.profileId)
        // Show the resolved endpoint (user@host:port), matching the direct-ssh
        // case, rather than the profile's display label. Falls back to the raw
        // id only if the profile can't be found (then its fields are gone too).
        const target = p ? `${p.username}@${p.host}:${p.port}` : src.profileId
        return { protocol: 'SSH', target }
      }
      case 'telnet':
        return { protocol: 'TELNET', target: sourceLabel(src) }
      case 'serial': {
        const c = src.config
        const framing = `${dataBitsDigit(c.dataBits)}${c.parity[0]}${c.stopBits === 'Two' ? 2 : 1}`
        return { protocol: 'SERIAL', target: `${c.portName} · ${c.baudRate} ${framing}` }
      }
    }
  })()
  const activePaneIndex = activePaneId
    ? activePaneLeaves.findIndex((l) => l.id === activePaneId) + 1
    : 0

  // Flat list of every live (source-holding) pane across every tab — the
  // pool that Terminal instances are portaled from. See the `slots` comment
  // above for why this exists instead of rendering Terminal inline per tab.
  const connectedEntries = tabs.flatMap((tab) =>
    allLeaves(tab.root)
      .filter((leaf) => leaf.source)
      .map((leaf) => ({ tab, leaf })),
  )

  // Prunes home containers for leaves that are truly gone (disconnected or
  // closed, not just mid-move) — otherwise every one ever created would sit
  // in the DOM forever.
  useEffect(() => {
    const liveIds = new Set(connectedEntries.map(({ leaf }) => leaf.id))
    for (const [id, el] of Object.entries(homeContainers.current)) {
      if (!liveIds.has(id)) {
        el.remove()
        delete homeContainers.current[id]
      }
    }
  })

  return (
    <div
      className={`flex h-screen w-screen flex-col overflow-hidden ${
        maximized ? '' : 'rounded-lg border border-white/10'
      }`}
      style={{
        background: backgroundWithOpacity(
          findTheme(terminalSettings.themeName),
          terminalSettings.backgroundOpacity,
        ),
      }}
    >
      <div className="flex h-10 shrink-0 items-stretch border-b border-white/10 bg-black/20">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          statusByPane={statusByPane}
          onSelect={selectTab}
          onClose={closeTab}
          onNew={newTab}
          onDuplicate={duplicateTab}
          onReconnect={reconnectTab}
          onReorder={reorderTabs}
          onDropPaneAsNewTab={popPaneToNewTab}
        />
        <div
          data-tauri-drag-region
          className={`min-w-0 flex-1 transition-colors duration-100 ${
            paneDragOverSpacer ? 'bg-sky-400/10' : ''
          }`}
          onDoubleClick={() => getCurrentWindow().toggleMaximize()}
          // The rest of what visually reads as "the tab bar" — everything
          // to the right of the last real tab/the "+" button — is this
          // separate drag-region spacer, not part of <TabBar> itself, so it
          // needs its own acceptance of a pane being dragged out of a split
          // (see the grip in Pane.tsx) or dropping anywhere here would
          // silently do nothing.
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DRAG_PANE_MIME)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setPaneDragOverSpacer(true)
          }}
          onDragLeave={() => setPaneDragOverSpacer(false)}
          onDrop={(e) => {
            setPaneDragOverSpacer(false)
            const raw = e.dataTransfer.getData(DRAG_PANE_MIME)
            if (!raw) return
            e.preventDefault()
            const { tabId, paneId } = JSON.parse(raw) as { tabId: string; paneId: string }
            popPaneToNewTab(tabId, paneId)
          }}
        />
        {activeTab && (
          <div className="flex shrink-0 items-center gap-0.5 border-l border-white/10 px-1.5">
            {activeLeaf?.source && (
              <button
                className="flex items-center justify-center rounded p-1.5 text-white/50 transition-colors duration-fast ease-swift hover:bg-white/10 hover:text-white/90"
                title="Find in terminal (Ctrl+Shift+F)"
                onClick={() =>
                  activePaneId &&
                  setSearchRequest((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, paneId: activePaneId }))
                }
              >
                <Search size={15} strokeWidth={2} />
              </button>
            )}
            {activeLeaf?.source && (
              <button
                className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-white/10 ${
                  activePaneId && loggingByPane[activePaneId]
                    ? 'text-red-400 hover:text-red-300'
                    : 'text-white/50 hover:text-white/90'
                }`}
                title={
                  activePaneId && loggingByPane[activePaneId]
                    ? 'Session logging on — click to stop'
                    : 'Log session output to a file'
                }
                onClick={() => activePaneId && toggleLogging(activePaneId)}
              >
                <ScrollText size={15} strokeWidth={2} />
              </button>
            )}
            {activeIsSsh && activeSessionId && (
              <button
                className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-white/10 ${
                  activePaneId && forwardsOpenByPane[activePaneId]
                    ? 'text-white/90'
                    : 'text-white/50 hover:text-white/90'
                }`}
                title="Port forwarding"
                onClick={() => activePaneId && toggleForwards(activePaneId)}
              >
                <ArrowLeftRight size={15} strokeWidth={2} />
              </button>
            )}
            {activeIsSsh && activeSessionId && (
              <button
                className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-white/10 ${
                  activePaneId && filesOpenByPane[activePaneId]
                    ? 'text-white/90'
                    : 'text-white/50 hover:text-white/90'
                }`}
                title="Remote files"
                onClick={() => activePaneId && toggleFiles(activePaneId)}
              >
                <Folder size={15} strokeWidth={2} />
              </button>
            )}
            <button
              className="flex items-center justify-center rounded p-1.5 text-white/50 transition-colors duration-150 hover:bg-white/10 hover:text-white/90"
              title="Split right"
              onClick={() => activeTab && activePaneId && splitPane(activeTab.id, activePaneId, 'horizontal')}
            >
              <SplitSquareHorizontal size={15} strokeWidth={2} />
            </button>
            <button
              className="flex items-center justify-center rounded p-1.5 text-white/50 transition-colors duration-150 hover:bg-white/10 hover:text-white/90"
              title="Split down"
              onClick={() => activeTab && activePaneId && splitPane(activeTab.id, activePaneId, 'vertical')}
            >
              <SplitSquareVertical size={15} strokeWidth={2} />
            </button>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-0.5 border-l border-white/10 px-1.5">
          <WorkspaceMenu
            tabs={tabs}
            saved={savedWorkspaces}
            onOpen={openWorkspace}
            onChanged={() => setWorkspacesVersion((v) => v + 1)}
          />
          <VaultMenu status={vaultStatus} onStatusChange={refreshVaultStatus} />
          <SettingsMenu settings={terminalSettings} onChange={updateSettings} />
        </div>
        <WindowControls maximized={maximized} />
      </div>
      <div className="relative flex min-h-0 flex-1">
        <main className="relative min-h-0 flex-1">
          {tabs.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-white/30">
              <TerminalSquare size={28} strokeWidth={1.5} />
              No open sessions
            </div>
          )}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              // No margin/padding here on purpose — the terminal itself
              // owns its own theme-matched inset now (see Terminal.tsx),
              // which is the only place that can never drift out of sync
              // with whatever color it actually paints.
              className="absolute inset-0"
              style={{ display: tab.id === activeTabId ? undefined : 'none' }}
            >
              <Pane
                node={tab.root}
                tabId={tab.id}
                tabHasSplit={allLeaves(tab.root).length > 1}
                activePaneId={tab.activePaneId}
                onClosePane={(paneId) => closePane(tab.id, paneId)}
                vaultUnlocked={vaultStatus === 'unlocked'}
                forwardsOpenByPane={forwardsOpenByPane}
                filesOpenByPane={filesOpenByPane}
                sessionIdByPane={sessionIdByPane}
                sessions={sessions}
                workspaces={savedWorkspaces}
                onOpenWorkspace={(w) => openWorkspace(w, tab.id)}
                onFocusPane={(paneId) => focusPane(tab.id, paneId)}
                onConnect={(paneId, config, logSession) => connectPane(tab.id, paneId, config, logSession)}
                onSelectSession={(paneId, profile) => connectPaneFromProfile(tab.id, paneId, profile)}
                onEditSession={(paneId, profile) => editPaneFromProfile(tab.id, paneId, profile)}
                onDeleteSession={deleteSessionProfile}
                onUnlockAndSelectSession={(paneId, profile, password) =>
                  unlockVaultAndConnectProfile(tab.id, paneId, profile, password)
                }
                osUnlockAvailable={osUnlockAvailable}
                onUnlockWithOsAndSelectSession={(paneId, profile) =>
                  unlockWithOsAndConnectProfile(tab.id, paneId, profile)
                }
                onSaveProfile={saveProfile}
                onSaveCredential={saveCredential}
                onImportKeyToVault={importKeyToVault}
                onDeleteCredential={deleteCredentialFromVault}
                onReorderSessions={reorderSessions}
                onCloseForwards={closeForwards}
                onCloseFiles={closeFiles}
                onSlotRef={registerSlot}
                onDropTab={attachTabToPane}
              />
            </div>
          ))}
          {connectedEntries.map(({ tab, leaf }) => {
            if (!leaf.source) return null
            // Always the same element for this leaf's whole connected
            // lifetime — see the useLayoutEffect above for why.
            const slot = getHomeContainer(leaf.id)
            return createPortal(
              // React portals bubble events according to the *React* tree,
              // not the DOM tree — this content's React parent is wherever
              // createPortal was called (here, inside App), not
              // PaneLeafView, so PaneLeafView's own onMouseDown/
              // onFocusCapture never actually fire for clicks inside a
              // connected terminal. That silently broke pane-focus tracking
              // the moment a pane had a live connection (still worked for
              // an unconnected ConnectDialog pane, which isn't portaled),
              // which is why "move to new tab" looked broken — it was
              // acting on a stale activePaneId. Re-declaring the focus
              // handlers here, actually inside the portal's real React
              // ancestry, fixes it.
              <div
                className="relative h-full w-full"
                onFocusCapture={() => focusPane(tab.id, leaf.id)}
                onMouseDown={() => focusPane(tab.id, leaf.id)}
              >
                <Terminal
                  key={`${leaf.id}-${leaf.generation}`}
                  source={leaf.source}
                  label={leafTitle(leaf, sourceLabel(leaf.source))}
                  settings={terminalSettings}
                  backspaceSendsCtrlH={leaf.backspaceSendsCtrlH}
                  logging={loggingByPane[leaf.id] ?? false}
                  active={leaf.id === tab.activePaneId}
                  paneId={leaf.id}
                  searchRequest={searchRequest}
                  onStatus={(s) => {
                    setStatusByPane((prev) => ({ ...prev, [leaf.id]: s }))
                    // Stamp the connect time once per connected run; drop it on
                    // anything else so the uptime clock resets on reconnect and
                    // disappears while disconnected/failed.
                    setConnectedAtByPane((prev) => {
                      if (s === 'connected') {
                        return leaf.id in prev ? prev : { ...prev, [leaf.id]: Date.now() }
                      }
                      if (!(leaf.id in prev)) return prev
                      const next = { ...prev }
                      delete next[leaf.id]
                      return next
                    })
                    // Surfaced even for background tabs — otherwise a
                    // failed connection in a tab you're not looking at is
                    // silent.
                    if (s.startsWith('failed')) toast.error(s.replace(/^failed: /, ''))
                    // A clean remote-initiated disconnect (the shell
                    // exited, the server hung up) closes the pane on its
                    // own rather than leaving a dead terminal sitting open
                    // — but only a clean disconnect, not a failure, since
                    // the error should stay visible until the user
                    // dismisses it themselves.
                    if (s === 'disconnected' && terminalSettings.closeOnDisconnect) {
                      setTimeout(() => closePane(tab.id, leaf.id), 800)
                    }
                  }}
                  onSessionId={(id) => setSessionIdByPane((prev) => ({ ...prev, [leaf.id]: id }))}
                  onBackToConnect={() => disconnectPane(tab.id, leaf.id)}
                  onReconnect={() => reconnectPane(tab.id, leaf.id)}
                />
              </div>,
              slot,
              leaf.id,
            )
          })}
        </main>
        {paletteOpen && (
          <QuickConnectPalette
            sessions={sessions}
            onClose={() => setPaletteOpen(false)}
            onSelect={(profile) => {
              openSavedSession(profile)
              setPaletteOpen(false)
            }}
          />
        )}
      </div>
      {tabs.length > 0 && (
        <StatusBar
          protocol={statusBarConn?.protocol ?? null}
          target={statusBarConn?.target ?? null}
          status={activePaneId ? statusByPane[activePaneId] : undefined}
          connectedAt={activePaneId ? (connectedAtByPane[activePaneId] ?? null) : null}
          logging={activePaneId ? (loggingByPane[activePaneId] ?? false) : false}
          paneIndex={activePaneIndex}
          paneCount={activePaneLeaves.length}
          tabCount={tabs.length}
          serialSessionId={
            statusBarConn?.protocol === 'SERIAL' &&
            activePaneId &&
            statusByPane[activePaneId] === 'connected'
              ? activeSessionId
              : null
          }
        />
      )}
      <ToastHost />
      {pendingRestore && (
        <RestoreSessionsPrompt
          count={sessionSnapshot.countSessions(pendingRestore.tabs)}
          needsVaultUnlock={
            sessionSnapshot.needsVaultUnlock(pendingRestore.tabs) && vaultStatus !== 'unlocked'
          }
          osUnlockAvailable={osUnlockAvailable}
          onRestore={restoreSessions}
          onUnlockAndRestore={unlockAndRestoreSessions}
          onUnlockWithOsAndRestore={unlockWithOsAndRestoreSessions}
          onDiscard={discardRestore}
        />
      )}
      {pendingWorkspace && (
        <RestoreSessionsPrompt
          count={sessionSnapshot.countSessions(pendingWorkspace.workspace.tabs)}
          // Always true here — openWorkspace only sets this state when the
          // vault is locked and the workspace needs it.
          needsVaultUnlock
          osUnlockAvailable={osUnlockAvailable}
          title={`Open "${pendingWorkspace.workspace.name}"?`}
          body="Some of its sessions need the vault unlocked. You can open it locked — those panes will come up on their connect form instead."
          cancelLabel="Open anyway — without unlocking"
          onRestore={openPendingWorkspace}
          onUnlockAndRestore={unlockAndOpenWorkspace}
          onUnlockWithOsAndRestore={unlockWithOsAndOpenWorkspace}
          onDiscard={openPendingWorkspace}
        />
      )}
    </div>
  )
}

export default App
