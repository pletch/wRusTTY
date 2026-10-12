import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pane } from './components/Pane'
import { Terminal } from './components/Terminal'
import { TabBar } from './components/TabBar'
import { QuickConnectPalette } from './components/QuickConnectPalette'
import { SettingsDialog } from './components/SettingsDialog'
import { VaultMenu } from './components/VaultMenu'
import { WorkspaceMenu } from './components/WorkspaceMenu'
import type { Workspace } from './lib/workspaces'
import * as workspaceApi from './lib/workspaces'
import { ToastHost } from './components/ToastHost'
import { WindowControls } from './components/WindowControls'
import { RestoreSessionsPrompt } from './components/RestoreSessionsPrompt'
import { ConfirmDialog } from './components/ConfirmDialog'
import { playBell } from './lib/bellSound'
import { StatusBar } from './components/StatusBar'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import {
  TerminalSquare,
  SplitSquareHorizontal,
  SplitSquareVertical,
  ScrollText,
  Radio,
  ArrowLeftRight,
  Folder,
  Search,
} from 'lucide-react'
import { toast } from './lib/toast'
import type { FilesReveal } from './components/FilesPanel'
import * as sftp from './lib/sftp'
import { startDirFor } from './lib/fileActions'
import { resolveRemotePath, splitRemotePath } from './lib/pathDetect'
import { openLocalPath } from './lib/localOpen'
import { notifyInBackground, flashWindow } from './lib/notify'
import * as profiles from './lib/profiles'
import type { SessionProfile } from './lib/profiles'
import * as vault from './lib/vault'
import type { VaultStatus, VaultSecret } from './lib/vault'
import { transportOf, type ConnectionSource } from './lib/connection'
import { parseReconnecting, shouldAutoClosePane, sourceLabel } from './lib/connection'
import {
  loadSettings,
  saveSettings,
  effectiveBackgroundLayers,
  unfocusedAppearance,
  DEFAULT_FONT_SIZE,
  FONT_SIZE_RANGE,
  proxyConfigFrom,
} from './lib/settings'
import { actionForEvent, isRecordingShortcut, withShortcut } from './lib/keybindings'
import { canElevate } from './lib/local'
import { formatCommandDuration } from './lib/shellIntegration'
import type { CommandResult } from './lib/shellIntegration'
import {
  backgroundWithOpacity,
  backgroundTint,
  findTheme,
  stripColor,
  stripOverlay,
  tabHoverWash,
  chromeRgb,
  surfaceRgb,
  themeColorScheme,
} from './lib/theme'
import { setWindowVibrancy } from './lib/windowEffects'
import { DRAG_PANE_MIME } from './lib/dragTypes'
import {
  allLeaves,
  blankLeaf,
  closeLeaf,
  findLeaf,
  firstLeaf,
  reidentify,
  splitBlocker,
} from './lib/paneTree'
import type { SplitLimit } from './lib/paneTree'
import * as sessionSnapshot from './lib/sessionSnapshot'
import type { SessionSnapshot } from './lib/sessionSnapshot'
import { keepWindowOnScreen } from './lib/windowFit'
import type { PaneLeaf, PaneNode, Tab } from './types'
import { runVaultGatedAction } from './state/vaultGate'
import type { VaultGatedAction, VaultGateEffects } from './state/vaultGate'
import {
  splitLimitHint,
  profileToInitial,
  refreshTabs,
  newTabId,
  leafTitle,
  dataBitsDigit,
  blankTab,
} from './state/tabOps'
import {
  paneRuntimeReducer,
  statusByPaneOf,
  connectedAtByPaneOf,
  loggingByPaneOf,
  forwardsOpenByPaneOf,
  filesOpenByPaneOf,
  sessionIdByPaneOf,
  activityByPaneOf,
  progressByPaneOf,
  titleByPaneOf,
  cwdByPaneOf,
  attentionPanesOf,
  dimensionsByPaneOf,
  scrollbackBudgetByPaneOf,
} from './state/paneRuntime'
import { tabsReducer, layoutSignature } from './state/tabs'
import { usePanePortals } from './hooks/usePanePortals'
import { useDragRegionDoubleClickGuard } from './hooks/useDragRegionDoubleClickGuard'

function refit() {
  // Nudge Terminal's resize listener after a tab or pane becomes visible.
  // Double rAF waits for WebView2 to finish layout; a setTimeout(0) could fire
  // against a transitional size.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
  })
}

/** Commands quicker than this never notify; with shell integration every
 * command reports, and constant toasts would get ignored. */
const COMMAND_NOTIFY_THRESHOLD_MS = 10_000

/** Progress shorter than this leaves no marker when it clears; rules out tools
 * that flash progress briefly on startup. */
const PROGRESS_NOTIFY_THRESHOLD_MS = 5_000

/** The command result for an OS notification, which may appear on the lock
 * screen of an unattended machine. Omits the command line (OSC 633 includes
 * its arguments); the in-app toast has the detail. */
function describeCommandResultBriefly(result: CommandResult, tabTitle: string): string {
  const took = formatCommandDuration(result.durationMs)
  if (result.exitCode === null || result.exitCode === 0) {
    return `Finished in ${took} — ${tabTitle}`
  }
  return `Exited ${result.exitCode} after ${took} — ${tabTitle}`
}

function describeCommandResult(result: CommandResult, tabTitle: string): string {
  // Plain OSC 133 has no command text; only OSC 633 reports it.
  const what = result.command ? `\`${result.command}\`` : 'Command'
  const took = formatCommandDuration(result.durationMs)
  // A null exit code means completion without a status; not a failure.
  if (result.exitCode === null || result.exitCode === 0) {
    return `${what} finished in ${took} — ${tabTitle}`
  }
  return `${what} exited ${result.exitCode} after ${took} — ${tabTitle}`
}

/** Every dialog, prompt or palette App can show, as one value so two can't be
 * open at once. */
type Modal =
  | { kind: 'none' }
  | { kind: 'palette' }
  | { kind: 'confirmClosePane'; tabId: string; paneId: string }
  | { kind: 'confirmCloseTab'; tabId: string; count: number }
  | { kind: 'confirmCloseWindow'; count: number }
  | { kind: 'restorePrompt'; snapshot: SessionSnapshot }
  | { kind: 'workspacePrompt'; workspace: Workspace; originTabId: string | null }
  | { kind: 'reconnectPrompt'; tabId: string; paneId: string }

function App() {
  // Tree surgery lives in one reducer; see state/tabs.ts.
  const [{ tabs, activeTabId }, dispatchTabs] = useReducer(tabsReducer, null, () => {
    const initial = blankTab()
    return { tabs: [initial], activeTabId: initial.id }
  })
  // Refit whenever the active tab's visible layout changes. Keyed on
  // layoutSignature so dragging a divider doesn't refire it.
  useLayoutEffect(() => {
    refit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSignature(tabs, activeTabId)])
  const [paneDragOverSpacer, setPaneDragOverSpacer] = useState(false)
  // Live per-pane state (status, logging, panels, activity, attention); see
  // state/paneRuntime.ts. The views are memoized because the reducer returns
  // the same object when nothing changed.
  const [paneRuntime, dispatchPaneRuntime] = useReducer(paneRuntimeReducer, {})
  const statusByPane = useMemo(() => statusByPaneOf(paneRuntime), [paneRuntime])
  const connectedAtByPane = useMemo(() => connectedAtByPaneOf(paneRuntime), [paneRuntime])
  const loggingByPane = useMemo(() => loggingByPaneOf(paneRuntime), [paneRuntime])
  const forwardsOpenByPane = useMemo(() => forwardsOpenByPaneOf(paneRuntime), [paneRuntime])
  const filesOpenByPane = useMemo(() => filesOpenByPaneOf(paneRuntime), [paneRuntime])
  const sessionIdByPane = useMemo(() => sessionIdByPaneOf(paneRuntime), [paneRuntime])
  const activityByPane = useMemo(() => activityByPaneOf(paneRuntime), [paneRuntime])
  const progressByPane = useMemo(() => progressByPaneOf(paneRuntime), [paneRuntime])
  const titleByPane = useMemo(() => titleByPaneOf(paneRuntime), [paneRuntime])
  const cwdByPane = useMemo(() => cwdByPaneOf(paneRuntime), [paneRuntime])
  const attentionPanes = useMemo(() => attentionPanesOf(paneRuntime), [paneRuntime])
  const dimensionsByPane = useMemo(() => dimensionsByPaneOf(paneRuntime), [paneRuntime])
  const scrollbackBudgetByPane = useMemo(() => scrollbackBudgetByPaneOf(paneRuntime), [paneRuntime])
  // Where a Ctrl+clicked path sent each pane's files panel; dropped when the
  // panel closes.
  const [filesRevealByPane, setFilesRevealByPane] = useState<Record<string, FilesReveal>>({})
  const revealNonce = useRef(0)
  useEffect(() => {
    setFilesRevealByPane((prev) => {
      const stale = Object.keys(prev).filter((id) => !filesOpenByPane[id])
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const id of stale) delete next[id]
      return next
    })
  }, [filesOpenByPane])
  // Asks one pane to open its search box. Targeted by pane id so background
  // tabs aren't affected; the nonce lets a repeat click re-fire.
  const [searchRequest, setSearchRequest] = useState<{ nonce: number; paneId: string } | null>(null)

  // Tabs broadcasting input to all their panes. Per-tab, and not persisted
  // into workspaces since it changes what typing does.
  const [broadcastTabs, setBroadcastTabs] = useState<Set<string>>(new Set())
  const toggleBroadcast = useCallback((tabId: string) => {
    setBroadcastTabs((prev) => {
      const next = new Set(prev)
      if (!next.delete(tabId)) next.add(tabId)
      return next
    })
  }, [])

  // The pane you're looking at: the focused pane of the active tab.
  const focusedPaneId = tabs.find((t) => t.id === activeTabId)?.activePaneId ?? null

  // Focusing a pane acknowledges its attention marker, whatever route got
  // there. The window focus listener covers a marker set while the window
  // was in the background.
  useEffect(() => {
    if (!focusedPaneId) return
    const clear = () => dispatchPaneRuntime({ type: 'attentionCleared', paneId: focusedPaneId })
    clear()
    window.addEventListener('focus', clear)
    return () => window.removeEventListener('focus', clear)
  }, [focusedPaneId])
  const [profilesVersion, setProfilesVersion] = useState(0)
  // Backs the quick-connect palette and every connect dialog's sidebar.
  const [sessions, setSessions] = useState<SessionProfile[]>([])
  // Whether the first load finished. The restore prompt waits for it, since
  // which panes need the vault depends on their profiles.
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  useEffect(() => {
    profiles
      .listSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setSessionsLoaded(true))
  }, [profilesVersion])
  // Shared by the connect dialog sidebar and the toolbar menu.
  const [workspacesVersion, setWorkspacesVersion] = useState(0)
  const [savedWorkspaces, setSavedWorkspaces] = useState<Workspace[]>([])
  useEffect(() => {
    workspaceApi
      .listWorkspaces()
      .then(setSavedWorkspaces)
      .catch(() => setSavedWorkspaces([]))
  }, [workspacesVersion])
  const [terminalSettings, setTerminalSettings] = useState(() => loadSettings())
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>('uninitialized')
  const [osUnlockAvailable, setOsUnlockAvailable] = useState(false)
  const [maximized, setMaximized] = useState(false)
  // Starts true so the window doesn't flash dim on launch.
  const [windowFocused, setWindowFocused] = useState(true)
  // The settings as currently applied: 'glass' mode swaps in its unfocused
  // appearance. Everything that paints the window reads this.
  const appearance = unfocusedAppearance(terminalSettings, windowFocused)
  // Mirror the effect and tint to the native window ('off' clears both).
  useEffect(() => {
    const tint = backgroundTint(findTheme(appearance.themeName), appearance.backgroundOpacity)
    setWindowVibrancy(appearance.vibrancyMode, tint).catch(() => {})
  }, [appearance.backgroundOpacity, appearance.themeName, appearance.vibrancyMode])
  // One modal at a time. The restore decision is made in the initializer
  // since loading the snapshot is synchronous.
  const [modal, setModal] = useState<Modal>(() => {
    if (!terminalSettings.restoreSessionsOnLaunch) return { kind: 'none' }
    const snapshot = sessionSnapshot.loadSnapshot()
    if (snapshot && sessionSnapshot.countSessions(snapshot.tabs) > 0) {
      return { kind: 'restorePrompt', snapshot }
    }
    return { kind: 'none' }
  })
  const closeModal = () => setModal({ kind: 'none' })
  // True unless the restore prompt is still up.
  const restoreDecided = modal.kind !== 'restorePrompt'
  // Every pane with a source, across all tabs: the pool Terminals are
  // portaled from. See usePanePortals.ts.
  const connectedEntries = tabs.flatMap((tab) =>
    allLeaves(tab.root)
      .filter((leaf) => leaf.source)
      .map((leaf) => ({ tab, leaf })),
  )
  const { registerSlot, getHomeContainer } = usePanePortals(connectedEntries.map(({ leaf }) => leaf.id))

  // The window starts hidden (tauri.conf.json) and is shown after the first
  // paint, so it never flashes at the default size before window-state
  // restores its geometry. Fitted to the screen first (keepWindowOnScreen).
  useEffect(() => {
    keepWindowOnScreen()
      .catch(() => {})
      .then(() => getCurrentWindow().show())
      .catch(() => {})
  }, [])

  // Chrome text tone and surface color, set on the document element because
  // dialogs are portaled to the body. Set together: the text tone flips on a
  // light theme, so the surface must too.
  useEffect(() => {
    const theme = findTheme(terminalSettings.themeName)
    document.documentElement.style.setProperty('--chrome-rgb', chromeRgb(theme))
    document.documentElement.style.setProperty('--surface-rgb', surfaceRgb(theme))
    // Also the browser-painted widgets; see themeColorScheme.
    document.documentElement.style.colorScheme = themeColorScheme(theme)
  }, [terminalSettings.themeName])

  // Panes in an auto-reconnect run, so per-attempt failures don't toast. A
  // ref because the onStatus callback would otherwise read stale state.
  const reconnectingPanes = useRef(new Set<string>())

  // Read by the once-mounted window-close hook below.
  const closeGuardRef = useRef({ connected: 0, enabled: true })
  closeGuardRef.current = {
    connected: tabs.reduce((n, t) => n + connectedPanes(t.root), 0),
    enabled: terminalSettings.confirmCloseWithConnection,
  }
  // With this listener registered, the JS API closes via destroy(), which
  // needs core:window:allow-destroy in capabilities/default.json (otherwise
  // the close button silently does nothing). Window-state saves geometry on
  // CloseRequested, before this runs.
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested((event) => {
      const { connected, enabled } = closeGuardRef.current
      if (!enabled || connected === 0) return
      event.preventDefault()
      setModal({ kind: 'confirmCloseWindow', count: connected })
    })
    return () => {
      unlisten.then((f) => f()).catch(() => {})
    }
  }, [])

  // Stops a double-click on the last tab's ✕ from maximizing the window.
  useDragRegionDoubleClickGuard()

  // Window focus, for the unfocused appearance. Terminal.tsx has its own
  // per-pane listener for refocusing.
  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(({ payload }) =>
      setWindowFocused(payload),
    )
    return () => {
      unlisten.then((f) => f())
    }
  }, [])

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
    // Also lets the connect dialog's unlock prompt offer Windows sign-in.
    vault
      .osUnlockAvailable()
      .then(setOsUnlockAvailable)
      .catch(() => setOsUnlockAvailable(false))
    // A vault import also replaces sessions and workspaces.
    setProfilesVersion((v) => v + 1)
    setWorkspacesVersion((v) => v + 1)
  }

  useEffect(() => {
    refreshVaultStatus()
  }, [])

  // The vault can lock from the Rust side (Windows session-lock auto-lock).
  useEffect(() => {
    const unlisten = listen('vault-locked', () => refreshVaultStatus())
    return () => {
      unlisten.then((fn) => fn())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Save the snapshot as tabs change, not only on clean exit. Waits for the
  // restore prompt so it can't overwrite the snapshot being offered.
  useEffect(() => {
    if (!restoreDecided) return
    sessionSnapshot.saveSnapshot(tabs, activeTabId)
  }, [tabs, activeTabId, restoreDecided])

  /** Restores a snapshot, re-resolving each pane against current profiles.
   * Pane ids are kept. `vaultUsable` is passed in because the unlock paths call
   * this before the vault status state has updated. */
  function applyRestore(snapshot: SessionSnapshot, vaultUsable: boolean) {
    dispatchTabs({
      type: 'restored',
      tabs: refreshTabs(snapshot.tabs, sessions, vaultUsable),
      activeTabId: snapshot.activeTabId,
    })
    closeModal()
  }

  function discardRestore() {
    sessionSnapshot.clearSnapshot()
    closeModal()
  }

  function restoreSessions() {
    if (modal.kind === 'restorePrompt') applyRestore(modal.snapshot, vaultStatus === 'unlocked')
  }

  /** The effects half of the vault-gated action dispatcher; the routing lives in
   * state/vaultGate.ts. */
  const vaultGateEffects: VaultGateEffects = {
    applyRestore,
    materializeWorkspace,
    closeModal,
    hasCredential: (profileId) => vault.hasCredential(profileId),
    applyProfileToPane: (tabId, paneId, source, profile) =>
      applyProfileToPane(tabId, paneId, source, profileToInitial(profile)),
    reconnectPane: reconnectPaneNow,
  }

  /** Unlocks the vault with a freshly-typed master password, then runs
   * whatever vault-gated action was waiting on it. */
  async function unlockAndRun(password: string, action: VaultGatedAction) {
    await vault.unlock(password)
    refreshVaultStatus()
    await runVaultGatedAction(action, vaultGateEffects)
  }

  /** Same as unlockAndRun, via OS unlock (Windows Hello/PIN). */
  async function unlockWithOsAndRun(action: VaultGatedAction) {
    await vault.unlockWithOs()
    // The native Hello dialog doesn't return focus to our window.
    getCurrentWindow()
      .setFocus()
      .catch(() => {})
    refreshVaultStatus()
    await runVaultGatedAction(action, vaultGateEffects)
  }

  function newTab() {
    dispatchTabs({ type: 'tabOpened', tab: blankTab() })
  }

  /** Panes in this subtree with a live connection, i.e. what closing would drop. */
  function connectedPanes(root: PaneNode): number {
    return allLeaves(root).filter((l) => statusByPane[l.id] === 'connected').length
  }

  function closeTab(id: string) {
    const tab = tabs.find((t) => t.id === id)
    const count = tab ? connectedPanes(tab.root) : 0
    if (count > 0 && terminalSettings.confirmCloseWithConnection) {
      setModal({ kind: 'confirmCloseTab', tabId: id, count })
      return
    }
    closeTabNow(id)
  }

  function closeTabNow(id: string) {
    // Clean up runtime state for every pane in the tab.
    const closing = tabs.find((t) => t.id === id)
    if (closing) {
      for (const leaf of allLeaves(closing.root)) {
        dispatchPaneRuntime({ type: 'paneClosed', paneId: leaf.id })
      }
    }
    dispatchTabs({ type: 'tabClosed', tabId: id })
    // Tab ids aren't reused; just don't accumulate dead ones.
    setBroadcastTabs((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    // The refit for a newly revealed tab happens in the layoutSignature effect.
  }

  function selectTab(id: string) {
    dispatchTabs({ type: 'tabSelected', tabId: id })
  }

  function reorderTabs(draggedId: string, targetId: string) {
    dispatchTabs({ type: 'tabsReordered', draggedId, targetId })
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
    dispatchTabs({ type: 'tabOpened', tab })
  }

  /** Reconnects one pane in place (a generation bump remounts its Terminal). */
  function reconnectPaneNow(tabId: string, paneId: string) {
    dispatchTabs({ type: 'paneReconnected', tabId, paneId })
  }

  /** The Reconnect action, gated on the vault: after sleep the idle timer may
   * have locked it, and a vault-bound pane would just fail again. Panes that
   * don't need the vault reconnect directly. */
  function reconnectPane(tabId: string, paneId: string) {
    const tab = tabs.find((t) => t.id === tabId)
    const leaf = tab && allLeaves(tab.root).find((l) => l.id === paneId)
    if (leaf && vaultStatus === 'locked' && sessionSnapshot.isVaultBound(leaf.source, sessions)) {
      setModal({ kind: 'reconnectPrompt', tabId, paneId })
      return
    }
    reconnectPaneNow(tabId, paneId)
  }

  /** Reconnects the tab's active pane in place (the tab-context-menu action). */
  function reconnectTab(id: string) {
    const tab = tabs.find((t) => t.id === id)
    if (tab) reconnectPane(id, tab.activePaneId)
  }

  /** Adds a saved workspace's tabs to the window and focuses the first. Additive,
   * so live sessions are never closed. With `vaultUsable` false, vault-bound
   * panes open on their prefilled connect form. `refreshTabs` re-reads each
   * pane's profile. */
  function materializeWorkspace(
    workspace: Workspace,
    vaultUsable: boolean,
    originTabId?: string | null,
  ) {
    const restored: Tab[] = refreshTabs(workspace.tabs, sessions, vaultUsable).map((t) => {
      // reidentify() invalidates activePaneId; use the first pane, and title it
      // from that pane.
      const root = reidentify(t.root)
      const active = firstLeaf(root)
      return { ...t, id: newTabId(), root, activePaneId: active.id, title: leafTitle(active, t.title) }
    })
    dispatchTabs({ type: 'workspaceMaterialized', restored, originTabId: originTabId ?? null })
  }

  /** Opens a workspace, prompting for the vault first if it's locked.
   * `originTabId` is the tab whose connect dialog launched it, which is replaced
   * rather than left blank (defaults to the active tab). */
  function openWorkspace(workspace: Workspace, originTabId?: string) {
    // Only prompt when locked; with no vault there's nothing to unlock.
    if (sessionSnapshot.needsVaultUnlock(workspace.tabs, sessions) && vaultStatus === 'locked') {
      // Keep the origin through the prompt.
      setModal({ kind: 'workspacePrompt', workspace, originTabId: originTabId ?? activeTabId })
      return
    }
    materializeWorkspace(workspace, vaultStatus === 'unlocked', originTabId)
  }

  function openPendingWorkspace() {
    if (modal.kind !== 'workspacePrompt') return
    const { workspace, originTabId } = modal
    materializeWorkspace(workspace, vaultStatus === 'unlocked', originTabId)
    closeModal()
  }

  function connectPane(
    tabId: string,
    paneId: string,
    source: ConnectionSource,
    logSession = false,
    paneOptions?: {
      backspaceSendsCtrlH: boolean | null
      autoReconnect: boolean | null
      label?: string | null
      form?: PaneLeaf['initial'] | null
    },
  ) {
    // Arm logging before the source so the log captures the first byte.
    dispatchPaneRuntime({ type: 'loggingSet', paneId, logging: logSession })
    dispatchTabs({
      type: 'paneConnected',
      tabId,
      paneId,
      source,
      backspaceSendsCtrlH: paneOptions?.backspaceSendsCtrlH ?? null,
      autoReconnect: paneOptions?.autoReconnect ?? null,
      // Only from the connect dialog's save-and-connect path.
      initialLabel: paneOptions?.label ?? null,
      initialForm: paneOptions?.form ?? null,
    })
  }

  /** Returns a pane to its (prefilled) connect dialog without touching the rest
   * of the tab; the way back from a failed connection. */
  function disconnectPane(tabId: string, paneId: string) {
    dispatchTabs({ type: 'paneDisconnected', tabId, paneId })
  }

  function focusPane(tabId: string, paneId: string) {
    dispatchTabs({ type: 'paneFocused', tabId, paneId })
  }

  function splitPane(tabId: string, paneId: string, direction: 'horizontal' | 'vertical') {
    // Toolbar buttons check the limit first; the reducer also caps it.
    dispatchTabs({ type: 'paneSplit', tabId, paneId, direction })
  }

  function toggleLogging(paneId: string) {
    dispatchPaneRuntime({ type: 'loggingToggled', paneId })
  }

  function toggleForwards(paneId: string) {
    dispatchPaneRuntime({ type: 'panelToggled', paneId, panel: 'forwards' })
    // The panels share a corner, so only one is open.
    dispatchPaneRuntime({ type: 'panelSet', paneId, panel: 'files', open: false })
  }

  function closeForwards(paneId: string) {
    dispatchPaneRuntime({ type: 'panelSet', paneId, panel: 'forwards', open: false })
  }

  function toggleFiles(paneId: string) {
    dispatchPaneRuntime({ type: 'panelToggled', paneId, panel: 'files' })
    dispatchPaneRuntime({ type: 'panelSet', paneId, panel: 'forwards', open: false })
  }

  /**
   * A path in a pane's output was clicked: look it up on that pane's host and
   * show it in the files panel (the directory, or the file in its parent).
   * Looked up first, since detection only knows it looks like a path.
   */
  async function openPathInFiles(paneId: string, path: string) {
    const sessionId = sessionIdByPane[paneId]
    if (!sessionId) return
    try {
      const home = await sftp.canonicalize(sessionId, '.')
      const abs = resolveRemotePath(path, startDirFor(cwdByPane[paneId], titleByPane[paneId]), home)
      if (!abs) {
        toast.error(`Can't tell what ${path} is relative to — this host hasn't reported its directory.`)
        return
      }
      const { dir, name } = splitRemotePath(abs)
      let target: Omit<FilesReveal, 'nonce'> = { dir: '/', select: null }
      if (name !== null) {
        const entry = (await sftp.listDir(sessionId, dir)).find((e) => e.name === name)
        if (!entry) {
          toast.error(`Not found on the host: ${abs}`)
          return
        }
        // A listing describes a symlink itself; ask whether it's a directory.
        const isDir =
          entry.isDir ||
          (entry.isSymlink &&
            (await sftp.listDir(sessionId, abs).then(
              () => true,
              () => false,
            )))
        target = isDir ? { dir: abs, select: null } : { dir, select: name }
      }
      setFilesRevealByPane((prev) => ({ ...prev, [paneId]: { ...target, nonce: ++revealNonce.current } }))
      dispatchPaneRuntime({ type: 'panelSet', paneId, panel: 'files', open: true })
      dispatchPaneRuntime({ type: 'panelSet', paneId, panel: 'forwards', open: false })
    } catch (err) {
      toast.error(`Could not look up ${path}: ${String(err)}`)
    }
  }

  /**
   * A path in a local pane's output was clicked: open it on this machine. A
   * relative path is tried against the last reported directory, then the
   * pane's start directory; the backend adds home.
   */
  async function openLocalPathFor(paneId: string, source: ConnectionSource, path: string) {
    const launched =
      source.protocol === 'local'
        ? source.config.cwd
        : source.protocol === 'localProfile'
          ? (sessions.find((s) => s.id === source.profileId)?.local?.cwd ?? null)
          : null
    const cwds = [cwdByPane[paneId], launched].filter((c): c is string => !!c)
    try {
      const outcome = await openLocalPath(path, cwds)
      switch (outcome.kind) {
        case 'notFound':
          toast.error(`Not found: ${path}`)
          break
        case 'revealed':
          // Explain why Explorer opened instead of the file.
          toast.info(`${outcome.path} is a program or script, so it was shown in Explorer rather than run.`)
          break
        default:
          break
      }
    } catch (err) {
      toast.error(`Could not open ${path}: ${String(err)}`)
    }
  }

  function closeFiles(paneId: string) {
    dispatchPaneRuntime({ type: 'panelSet', paneId, panel: 'files', open: false })
  }

  function closePane(tabId: string, paneId: string) {
    if (statusByPane[paneId] === 'connected' && terminalSettings.confirmCloseWithConnection) {
      setModal({ kind: 'confirmClosePane', tabId, paneId })
      return
    }
    closePaneNow(tabId, paneId)
  }

  function closePaneNow(tabId: string, paneId: string) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    if (!closeLeaf(tab.root, paneId)) {
      // Already confirmed as a pane close; closeTabNow cleans up this leaf.
      closeTabNow(tabId)
      return
    }
    dispatchPaneRuntime({ type: 'paneClosed', paneId })
    dispatchTabs({ type: 'paneClosed', tabId, paneId })
  }

  /** Moves a pane out of its split into a new tab. The leaf, and its pooled
   * Terminal and session, carry over untouched. */
  function popPaneToNewTab(tabId: string, paneId: string) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    const leaf = findLeaf(tab.root, paneId)
    if (!leaf || !closeLeaf(tab.root, paneId)) return // only offered when the tab actually has a split
    const poppedTab: Tab = {
      id: newTabId(),
      title: leafTitle(leaf, 'New Connection'),
      root: leaf,
      activePaneId: leaf.id,
    }
    dispatchTabs({ type: 'panePoppedToNewTab', tabId, paneId, poppedTab })
  }

  /** Attaches a dragged tab's connection into an empty pane elsewhere, closing
   * the source tab. The leaf keeps its id, so the session is untouched. */
  function attachTabToPane(targetPaneId: string, draggedTabId: string) {
    const draggedTab = tabs.find((t) => t.id === draggedTabId)
    if (!draggedTab || draggedTab.root.type !== 'leaf' || !draggedTab.root.source) return
    const draggedLeaf: PaneLeaf = draggedTab.root
    // The pane being replaced leaves the tree, so drop its runtime state.
    const replacedExisting = tabs.some((t) => t.id !== draggedTabId && findLeaf(t.root, targetPaneId))
    if (replacedExisting) dispatchPaneRuntime({ type: 'paneClosed', paneId: targetPaneId })
    dispatchTabs({ type: 'tabAttachedToPane', targetPaneId, draggedTabId })
    toast.success(`Attached ${leafTitle(draggedLeaf, sourceLabel(draggedLeaf.source!))}`)
  }

  // Shared by openSavedSession and connectPaneFromProfile: decides whether to
  // connect directly (secrets resolve on the Rust side) and returns the form
  // prefill either way. Password auth goes direct only with a saved secret;
  // public-key auth goes direct once the vault is unlocked (whether the key is
  // encrypted is unknown here); agent auth always goes direct.
  async function resolveProfileSource(profile: SessionProfile) {
    // Telnet has no credential and connects straight from the profile.
    if (profile.protocol === 'telnet') {
      return {
        source: {
          protocol: 'telnet' as const,
          config: { host: profile.host, port: profile.port, term_type: profile.termType },
        },
        initial: profileToInitial(profile),
      }
    }

    // Serial needs a backend round trip to map the adapter's USB identity to
    // its current COM number.
    if (profile.protocol === 'serial') {
      return {
        source: { protocol: 'serialProfile' as const, profileId: profile.id },
        initial: profileToInitial(profile),
      }
    }

    // Local shells re-resolve `shellId` on the backend (paths change on
    // upgrade). The id also tells `historyKeyForSource` what to record.
    if (profile.protocol === 'local') {
      // Administrator sessions open by detected shell id only; without one, open
      // the form rather than running unelevated.
      if (profile.local?.elevated) {
        const shellId = profile.local.shellId
        return {
          source: canElevate(shellId)
            ? { protocol: 'elevated' as const, shellId, profileId: profile.id }
            : null,
          initial: profileToInitial(profile),
        }
      }
      return {
        source: {
          protocol: 'localProfile' as const,
          profileId: profile.id,
          shellId: profile.local?.shellId ?? '',
        },
        initial: profileToInitial(profile),
      }
    }

    const canConnectDirect =
      !profiles.authNeedsVault(profile.authType) ||
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
    dispatchTabs({ type: 'tabOpened', tab })
  }

  /** Whether the saved session behind this source asks to be logged, read from
   * the live profile list so every route agrees and edits apply next connect. */
  function profileLogsSession(source: ConnectionSource): boolean {
    const id = 'profileId' in source ? source.profileId : null
    return !!id && sessions.some((p) => p.id === id && p.logSession === true)
  }

  /** Applies a source/initial pair to an already-open pane, in place. */
  function applyProfileToPane(
    tabId: string,
    paneId: string,
    source: ConnectionSource | null,
    initial: PaneLeaf['initial'],
  ) {
    dispatchTabs({ type: 'paneProfileApplied', tabId, paneId, source, initial })
  }

  /** Loads a saved session into an already-open (blank) pane, from that pane's
   * connect dialog sidebar. */
  async function connectPaneFromProfile(tabId: string, paneId: string, profile: SessionProfile) {
    const { source, initial } = await resolveProfileSource(profile)
    applyProfileToPane(tabId, paneId, source, initial)
  }

  /** Fills the form from this profile without auto-connecting, for editing. */
  function editPaneFromProfile(tabId: string, paneId: string, profile: SessionProfile) {
    applyProfileToPane(tabId, paneId, null, profileToInitial(profile))
  }

  function deleteSessionProfile(profile: SessionProfile) {
    // Remove the profile's vault credential too. Best-effort: if the vault is
    // locked, `prune_orphaned_credentials` sweeps it on the next unlock.
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

  // A magic packet is unacknowledged UDP, so "sent" is all we can report.
  function wakeSessionProfile(profile: SessionProfile) {
    profiles
      .wakeSession(profile.id)
      .then(() => toast.success(`Sent a magic packet to "${profile.label}"`))
      .catch((err) => toast.error(`Couldn't wake session: ${err}`))
  }

  // Returns the promise so ConnectDialog can await the write before
  // connecting through the saved profile.
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
    setModal({ kind: 'palette' })
  }

  /**
   * A step up or down the font size, or back to the default. Writes the setting
   * itself, so zoom persists and Settings agrees.
   */
  function zoomFont(step: number | 'reset') {
    const current = terminalSettings.fontSize
    const next =
      step === 'reset'
        ? DEFAULT_FONT_SIZE
        : Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, current + step))
    if (next === current) return
    updateSettings({ ...terminalSettings, fontSize: next })
  }

  // Mount the keydown listener once and read the latest callbacks from a ref.
  const shortcutsRef = useRef({
    newTab,
    closeTab,
    stepTab,
    openPalette,
    zoomFont,
    activeTabId,
    keybindings: terminalSettings.keybindings,
  })
  shortcutsRef.current = {
    newTab,
    closeTab,
    stepTab,
    openPalette,
    zoomFont,
    activeTabId,
    keybindings: terminalSettings.keybindings,
  }

  useEffect(() => {
    // Capture phase so these fire before the engine sees them. The chords are
    // configurable; see lib/keybindings.ts.
    function onKeyDown(e: KeyboardEvent) {
      // Settings is recording a chord.
      if (isRecordingShortcut()) return
      const s = shortcutsRef.current
      const action = actionForEvent(e, s.keybindings, 'window')
      if (!action) return
      // The engine's input handler skips consumed events.
      e.preventDefault()
      switch (action) {
        case 'zoomIn':
          s.zoomFont(1)
          break
        case 'zoomOut':
          s.zoomFont(-1)
          break
        case 'zoomReset':
          s.zoomFont('reset')
          break
        case 'nextTab':
          s.stepTab(1)
          break
        case 'prevTab':
          s.stepTab(-1)
          break
        case 'newTab':
          s.newTab()
          break
        case 'closeTab':
          if (s.activeTabId) s.closeTab(s.activeTabId)
          break
        case 'quickConnect':
          s.openPalette()
          break
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // Toolbar controls act on the focused pane.
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeLeaf = activeTab && allLeaves(activeTab.root).find((l) => l.id === activeTab.activePaneId)
  const activePaneId = activeTab?.activePaneId
  const activeIsSsh =
    activeLeaf?.source?.protocol === 'ssh' || activeLeaf?.source?.protocol === 'sshProfile'
  const activeSessionId = activePaneId ? (sessionIdByPane[activePaneId] ?? null) : null
  // Per direction: split limits are per axis.
  const splitBlocked = (direction: 'horizontal' | 'vertical'): SplitLimit | null =>
    activeTab && activePaneId ? splitBlocker(activeTab.root, activePaneId, direction) : null
  const rightBlocked = splitBlocked('horizontal')
  const downBlocked = splitBlocked('vertical')

  // Status-bar readout for the active pane: protocol tag plus target.
  const activePaneLeaves = activeTab ? allLeaves(activeTab.root) : []
  const statusBarConn = ((): { protocol: string; target: string } | null => {
    const src = activeLeaf?.source
    if (!src) return null
    switch (src.protocol) {
      case 'ssh':
        // Include the port.
        return { protocol: 'SSH', target: `${sourceLabel(src)}:${src.config.port}` }
      case 'sshProfile': {
        const p = sessions.find((s) => s.id === src.profileId)
        // The resolved endpoint, falling back to the id if the profile is gone.
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
      case 'serialProfile': {
        const p = sessions.find((s) => s.id === src.profileId)?.serial
        if (!p) return { protocol: 'SERIAL', target: src.profileId }
        const framing = `${dataBitsDigit(p.dataBits)}${p.parity[0]}${p.stopBits === 'Two' ? 2 : 1}`
        // The adapter, not the stored COM number, which may not be current.
        const adapter = p.identity.usb?.serialNumber ?? p.identity.portName
        return { protocol: 'SERIAL', target: `${adapter} · ${p.baudRate} ${framing}` }
      }
      // The shell and its arguments (e.g. `wsl -d Ubuntu`).
      case 'local': {
        const args = src.config.args.join(' ')
        const label = sourceLabel(src)
        return { protocol: 'LOCAL', target: args ? `${label} ${args}` : label }
      }
      // The profile's label.
      case 'localProfile': {
        const p = sessions.find((s) => s.id === src.profileId)
        return { protocol: 'LOCAL', target: p?.label ?? src.profileId }
      }
      // Always labeled Administrator, with an ADMIN tag.
      case 'elevated': {
        const p = src.profileId ? sessions.find((s) => s.id === src.profileId) : undefined
        return { protocol: 'ADMIN', target: `${p?.label ?? src.shellId} · Administrator` }
      }
    }
  })()
  const activePaneIndex = activePaneId
    ? activePaneLeaves.findIndex((l) => l.id === activePaneId) + 1
    : 0

  // Background opacity per surface. Equal while focused; while unfocused they
  // differ because the surfaces are stacked to different depths (see
  // `effectiveBackgroundLayers`). The terminal's value reaches the engine via
  // settings, a uniform update rather than CSS opacity.
  const backgroundLayers = effectiveBackgroundLayers(appearance, windowFocused)
  const configuredTheme = findTheme(terminalSettings.themeName)
  // Unfocused, every surface also takes the tab strip's color: thinning alone
  // is invisible under Mica's flat gray backdrop.
  const faded = !windowFocused && appearance.unfocusedDimPercent > 0
  const backgroundOverride = faded ? stripColor(configuredTheme) : null
  const paneSettings =
    backgroundLayers.terminal === terminalSettings.backgroundOpacity && !backgroundOverride
      ? terminalSettings
      : { ...appearance, backgroundOpacity: backgroundLayers.terminal, backgroundOverride }
  const backgroundTheme = backgroundOverride
    ? { ...configuredTheme, background: backgroundOverride }
    : configuredTheme
  const rootBackground = backgroundWithOpacity(backgroundTheme, backgroundLayers.root)
  const paneBackground = backgroundWithOpacity(backgroundTheme, backgroundLayers.overRoot)

  return (
    <div
      className={`flex h-screen w-screen flex-col overflow-hidden ${
        maximized ? '' : 'rounded-lg border border-chrome/10'
      }`}
      style={{ background: rootBackground }}
    >
      {/* No bottom hairline: the active tab runs straight down into the
          terminal, and the strip's wash separates it by tone. */}
      <div
        className="flex h-10 shrink-0 items-stretch"
        // Away from the theme background (see stripOverlay). Dropped while faded:
        // the translucent active tab would otherwise show the wash through it and
        // look lighter than its terminal.
        style={{
          background:
            windowFocused || appearance.unfocusedDimPercent <= 0
              ? stripOverlay(findTheme(terminalSettings.themeName))
              : 'transparent',
        }}
      >
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          statusByPane={statusByPane}
          activityByPane={activityByPane}
          progressByPane={progressByPane}
          attentionPanes={attentionPanes}
          titleByPane={titleByPane}
          paneBackground={paneBackground}
          tabHoverWash={tabHoverWash(findTheme(terminalSettings.themeName))}
          onSelect={selectTab}
          onClose={closeTab}
          onNew={newTab}
          newTabTitle={withShortcut('New connection', terminalSettings.keybindings, 'newTab')}
          onDuplicate={duplicateTab}
          onReconnect={reconnectTab}
          onReorder={reorderTabs}
          onDropPaneAsNewTab={popPaneToNewTab}
        />
        <div
          data-tauri-drag-region
          // Keeps a minimum width as a window drag handle.
          className={`min-w-12 flex-1 transition-colors duration-100 ${
            paneDragOverSpacer ? 'bg-sky-400/10' : ''
          }`}
          onDoubleClick={() => getCurrentWindow().toggleMaximize()}
          // Accepts a pane dragged out of a split (see the grip in Pane.tsx).
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
          <div className="flex shrink-0 items-center gap-0.5 border-l border-chrome/10 px-1.5">
            {activeLeaf?.source && (
              <button
                className="flex items-center justify-center rounded p-1.5 text-chrome/50 transition-colors duration-fast ease-swift hover:bg-chrome/10 hover:text-chrome/90"
                title={withShortcut('Find in terminal', terminalSettings.keybindings, 'find')}
                onClick={() =>
                  activePaneId &&
                  setSearchRequest((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, paneId: activePaneId }))
                }
              >
                <Search size={15} strokeWidth={2} />
              </button>
            )}
            {/* Only on a tab with more than one pane, where broadcasting means
                something. */}
            {activeTab && allLeaves(activeTab.root).length > 1 && (
              <button
                className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-chrome/10 ${
                  broadcastTabs.has(activeTab.id)
                    ? 'bg-amber-400/20 text-amber-300 hover:text-amber-200'
                    : 'text-chrome/50 hover:text-chrome/90'
                }`}
                title={
                  broadcastTabs.has(activeTab.id)
                    ? `Broadcasting to all ${allLeaves(activeTab.root).length} panes in this tab — click to stop`
                    : 'Send input to every pane in this tab'
                }
                onClick={() => toggleBroadcast(activeTab.id)}
              >
                <Radio size={15} strokeWidth={2} />
              </button>
            )}
            {activeLeaf?.source && (
              <button
                className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-chrome/10 ${
                  activePaneId && loggingByPane[activePaneId]
                    ? 'text-red-400 hover:text-red-300'
                    : 'text-chrome/50 hover:text-chrome/90'
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
                className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-chrome/10 ${
                  activePaneId && forwardsOpenByPane[activePaneId]
                    ? 'text-chrome/90'
                    : 'text-chrome/50 hover:text-chrome/90'
                }`}
                // Part of the panel's interaction scope, so opening it isn't a click-away.
                data-forward-toggle
                title="Port forwarding"
                onClick={() => activePaneId && toggleForwards(activePaneId)}
              >
                <ArrowLeftRight size={15} strokeWidth={2} />
              </button>
            )}
            {activeIsSsh && activeSessionId && (
              <button
                className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-chrome/10 ${
                  activePaneId && filesOpenByPane[activePaneId]
                    ? 'text-chrome/90'
                    : 'text-chrome/50 hover:text-chrome/90'
                }`}
                data-files-toggle
                title="Remote files"
                onClick={() => activePaneId && toggleFiles(activePaneId)}
              >
                <Folder size={15} strokeWidth={2} />
              </button>
            )}
            {/* Disabled rather than hidden at the split limit, with a tooltip. */}
            <button
              disabled={!!rightBlocked}
              className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 ${
                rightBlocked
                  ? 'cursor-default text-chrome/15'
                  : 'text-chrome/50 hover:bg-chrome/10 hover:text-chrome/90'
              }`}
              title={rightBlocked ? splitLimitHint(rightBlocked) : 'Split right'}
              onClick={() => activeTab && activePaneId && splitPane(activeTab.id, activePaneId, 'horizontal')}
            >
              <SplitSquareHorizontal size={15} strokeWidth={2} />
            </button>
            <button
              disabled={!!downBlocked}
              className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 ${
                downBlocked
                  ? 'cursor-default text-chrome/15'
                  : 'text-chrome/50 hover:bg-chrome/10 hover:text-chrome/90'
              }`}
              title={downBlocked ? splitLimitHint(downBlocked) : 'Split down'}
              onClick={() => activeTab && activePaneId && splitPane(activeTab.id, activePaneId, 'vertical')}
            >
              <SplitSquareVertical size={15} strokeWidth={2} />
            </button>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-0.5 border-l border-chrome/10 px-1.5">
          <WorkspaceMenu
            tabs={tabs}
            saved={savedWorkspaces}
            onOpen={openWorkspace}
            onChanged={() => setWorkspacesVersion((v) => v + 1)}
          />
          <VaultMenu status={vaultStatus} onStatusChange={refreshVaultStatus} />
          <SettingsDialog
            settings={terminalSettings}
            onChange={updateSettings}
            referenceCols={activePaneId ? dimensionsByPane[activePaneId]?.cols : undefined}
            onSessionsImported={() => setProfilesVersion((v) => v + 1)}
            vaultStatus={vaultStatus}
            onVaultChanged={refreshVaultStatus}
          />
        </div>
        <WindowControls maximized={maximized} />
      </div>
      <div className="relative flex min-h-0 flex-1">
        <main className="relative min-h-0 flex-1">
          {tabs.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-chrome/30">
              <TerminalSquare size={28} strokeWidth={1.5} />
              No open sessions
            </div>
          )}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              // No padding; Terminal paints its own theme-matched inset.
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
                statusByPane={statusByPane}
                filesOpenByPane={filesOpenByPane}
                filesRevealByPane={filesRevealByPane}
                cwdByPane={cwdByPane}
                titleByPane={titleByPane}
                editorCommand={terminalSettings.externalEditor}
                proxyAvailable={proxyConfigFrom(terminalSettings) !== null}
                paneBackground={paneBackground}
                sessionIdByPane={sessionIdByPane}
                sessions={sessions}
                workspaces={savedWorkspaces}
                onOpenWorkspace={(w) => openWorkspace(w, tab.id)}
                onFocusPane={(paneId) => focusPane(tab.id, paneId)}
                // `paneOptions` carries the dialog's Backspace setting.
                onConnect={(paneId, config, logSession, paneOptions) =>
                  connectPane(tab.id, paneId, config, logSession, paneOptions)
                }
                onSelectSession={(paneId, profile) => connectPaneFromProfile(tab.id, paneId, profile)}
                onEditSession={(paneId, profile) => editPaneFromProfile(tab.id, paneId, profile)}
                onDeleteSession={deleteSessionProfile}
                onWakeSession={wakeSessionProfile}
                onUnlockAndSelectSession={(paneId, profile, password) =>
                  unlockAndRun(password, { kind: 'connectProfile', tabId: tab.id, paneId, profile })
                }
                osUnlockAvailable={osUnlockAvailable}
                onUnlockWithOsAndSelectSession={(paneId, profile) =>
                  unlockWithOsAndRun({ kind: 'connectProfile', tabId: tab.id, paneId, profile })
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
            // The same element for this leaf's whole connected lifetime.
            const slot = getHomeContainer(leaf.id)
            return createPortal(
              // Portals bubble events through the React tree, so PaneLeafView's focus
              // handlers never see clicks in a connected terminal; declare them here.
              <div
                className="relative h-full w-full"
                onFocusCapture={() => focusPane(tab.id, leaf.id)}
                onMouseDown={() => focusPane(tab.id, leaf.id)}
              >
                <Terminal
                  key={`${leaf.id}-${leaf.generation}`}
                  source={leaf.source}
                  savedProfile={
                    leaf.initial?.id ? (sessions.find((p) => p.id === leaf.initial?.id) ?? null) : null
                  }
                  label={leafTitle(leaf, sourceLabel(leaf.source))}
                  settings={paneSettings}
                  backspaceSendsCtrlH={leaf.backspaceSendsCtrlH}
                  autoReconnect={leaf.autoReconnect}
                  logging={loggingByPane[leaf.id] ?? false}
                  autoLog={terminalSettings.autoLogSessions || profileLogsSession(leaf.source)}
                  onAutoLog={() =>
                    dispatchPaneRuntime({ type: 'loggingSet', paneId: leaf.id, logging: true })
                  }
                  active={leaf.id === tab.activePaneId}
                  paneId={leaf.id}
                  broadcastGroupId={tab.id}
                  broadcasting={broadcastTabs.has(tab.id)}
                  searchRequest={searchRequest}
                  onStatus={(s) => {
                    // The reducer manages connectedAt; see paneRuntime.ts.
                    dispatchPaneRuntime({ type: 'statusChanged', paneId: leaf.id, status: s, now: Date.now() })
                    // Toast failures even in background tabs, but not per attempt during an
                    // auto-reconnect run; giving up arrives as a final `failed`.
                    if (s.startsWith('failed') && !reconnectingPanes.current.has(leaf.id)) {
                      toast.error(s.replace(/^failed: /, ''))
                    }
                    // A ref, since this callback's closure sees stale state.
                    if (parseReconnecting(s)) reconnectingPanes.current.add(leaf.id)
                    else if (s === 'connected' || s.startsWith('failed')) {
                      reconnectingPanes.current.delete(leaf.id)
                    }
                    // A clean remote disconnect (e.g. `exit`) closes the pane, without
                    // confirmation since the session already ended. Never on `lost`, which
                    // would stop auto-reconnect; see `shouldAutoClosePane`.
                    if (shouldAutoClosePane(s, terminalSettings.closeOnDisconnect)) {
                      setTimeout(() => closePaneNow(tab.id, leaf.id), 800)
                    }
                  }}
                  onSessionId={(id) => dispatchPaneRuntime({ type: 'sessionIdSet', paneId: leaf.id, sessionId: id })}
                  onDimensions={(cols, rows) =>
                    dispatchPaneRuntime({ type: 'dimensionsChanged', paneId: leaf.id, cols, rows })
                  }
                  onScrollbackBudget={(budgetBytes) =>
                    dispatchPaneRuntime({ type: 'scrollbackBudgetSet', paneId: leaf.id, budgetBytes })
                  }
                  onActivity={(activity) =>
                    dispatchPaneRuntime({ type: 'activityChanged', paneId: leaf.id, activity })
                  }
                  onProgress={(progress) =>
                    dispatchPaneRuntime({ type: 'progressChanged', paneId: leaf.id, progress })
                  }
                  onProgressComplete={(durationMs) => {
                    // A full-screen program finished; leave a marker so the tab doesn't look
                    // idle.
                    if (durationMs < PROGRESS_NOTIFY_THRESHOLD_MS) return
                    // Same in-view test as a bell.
                    if (leaf.id === focusedPaneId && document.hasFocus()) return
                    dispatchPaneRuntime({ type: 'attentionRaised', paneId: leaf.id })
                    // Marker and flash only: there's nothing to say in a notification.
                    if (!document.hasFocus()) void flashWindow()
                  }}
                  onRemoteTitle={(title) =>
                    dispatchPaneRuntime({ type: 'titleChanged', paneId: leaf.id, title })
                  }
                  onRemoteCwd={(cwd) =>
                    dispatchPaneRuntime({ type: 'cwdChanged', paneId: leaf.id, cwd })
                  }
                  onOpenPath={(path) => {
                    const source = leaf.source
                    if (!source) return
                    void (transportOf(source) === 'ssh'
                      ? openPathInFiles(leaf.id, path)
                      : openLocalPathFor(leaf.id, source, path))
                  }}
                  onRemoteNotify={(notification) => {
                    if (!terminalSettings.remoteNotifications) return
                    // Prefix with the pane name so remote text never looks like the app.
                    const from = notification.title
                      ? `${tab.title}: ${notification.title}`
                      : tab.title
                    // Same in-view test as a bell.
                    if (!(leaf.id === focusedPaneId && document.hasFocus())) {
                      dispatchPaneRuntime({ type: 'attentionRaised', paneId: leaf.id })
                    }
                    // Shown even for the watched pane: it was asked for explicitly.
                    if (document.hasFocus()) {
                      toast.info(`${from} — ${notification.body}`)
                      return
                    }
                    // The body is dropped on the native path (it may show on the lock screen;
                    // see `describeCommandResultBriefly`).
                    void notifyInBackground(tab.title, 'sent a notification')
                  }}
                  onCommandComplete={(result) => {
                    if (!terminalSettings.notifyOnCommandComplete) return
                    // Not for full-screen programs.
                    if (result.interactive) return
                    if (result.durationMs < COMMAND_NOTIFY_THRESHOLD_MS) return
                    // The passive marker needs only this pane out of view; the toast waits
                    // until the whole tab is.
                    const paneInView = leaf.id === focusedPaneId && document.hasFocus()
                    const tabInView = tab.id === activeTabId && document.hasFocus()
                    if (!paneInView) {
                      dispatchPaneRuntime({ type: 'attentionRaised', paneId: leaf.id })
                    }
                    if (tabInView) return
                    if (document.hasFocus()) {
                      // Window up, different tab: an in-app toast with the full command.
                      const message = describeCommandResult(result, tab.title)
                      if (result.exitCode) toast.error(message)
                      else toast.success(message)
                      return
                    }
                    // Window in the background: a native notification, briefly worded.
                    void notifyInBackground(
                      result.exitCode ? 'Command failed' : 'Command finished',
                      describeCommandResultBriefly(result, tab.title),
                    )
                  }}
                  onBell={() => {
                    // Sound for every bell, including the watched pane.
                    if (terminalSettings.bellSound) playBell()
                    if (!terminalSettings.bellMarksTab) return
                    // Same in-view test as a completion.
                    if (leaf.id === focusedPaneId && document.hasFocus()) return
                    dispatchPaneRuntime({ type: 'attentionRaised', paneId: leaf.id })
                    // Flash the taskbar when away; no notification, since a bell has no text.
                    if (!document.hasFocus()) void flashWindow()
                  }}
                  onBackToConnect={() => disconnectPane(tab.id, leaf.id)}
                  onReconnect={() => reconnectPane(tab.id, leaf.id)}
                />
              </div>,
              slot,
              leaf.id,
            )
          })}
        </main>
        {modal.kind === 'palette' && (
          <QuickConnectPalette
            sessions={sessions}
            onClose={closeModal}
            onSelect={(profile) => {
              openSavedSession(profile)
              closeModal()
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
          remoteTitle={activePaneId ? (titleByPane[activePaneId] ?? null) : null}
          remoteCwd={activePaneId ? (cwdByPane[activePaneId] ?? null) : null}
          dimensions={activePaneId ? (dimensionsByPane[activePaneId] ?? null) : null}
          scrollbackBudgetBytes={activePaneId ? (scrollbackBudgetByPane[activePaneId] ?? null) : null}
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
      {(() => {
        const plural = (n: number) => `${n} connection${n === 1 ? '' : 's'}`
        const ends = (n: number) => `Closing ends ${n === 1 ? 'it' : 'them'} immediately.`
        switch (modal.kind) {
          case 'confirmClosePane':
            return (
              <ConfirmDialog
                title="Close this pane?"
                body={`Its connection is still open. ${ends(1)}`}
                confirmLabel="Close pane"
                onConfirm={() => {
                  closePaneNow(modal.tabId, modal.paneId)
                  closeModal()
                }}
                onCancel={closeModal}
              />
            )
          case 'confirmCloseTab':
            return (
              <ConfirmDialog
                title="Close this tab?"
                body={`${plural(modal.count)} still open in it. ${ends(modal.count)}`}
                confirmLabel="Close tab"
                onConfirm={() => {
                  closeTabNow(modal.tabId)
                  closeModal()
                }}
                onCancel={closeModal}
              />
            )
          case 'confirmCloseWindow':
            return (
              <ConfirmDialog
                title="Quit wRusTTY?"
                body={
                  `${plural(modal.count)} still open. ${ends(modal.count)}` +
                  // Only mentioned when true.
                  (terminalSettings.restoreSessionsOnLaunch ? ' They can be reopened next launch.' : '')
                }
                confirmLabel="Quit"
                onConfirm={() => {
                  closeModal()
                  // destroy(): close() would re-enter the close hook.
                  getCurrentWindow()
                    .destroy()
                    .catch((e) => toast.error(`Couldn't close the window: ${e}`))
                }}
                onCancel={closeModal}
              />
            )
          case 'restorePrompt':
            return (
              sessionsLoaded && (
                <RestoreSessionsPrompt
                  // Administrator tabs count, though they return awaiting approval.
                  count={
                    sessionSnapshot.countSessions(modal.snapshot.tabs) +
                    sessionSnapshot.countAwaitingElevation(modal.snapshot.tabs)
                  }
                  awaitingElevation={sessionSnapshot.countAwaitingElevation(modal.snapshot.tabs)}
                  needsVaultUnlock={
                    sessionSnapshot.needsVaultUnlock(modal.snapshot.tabs, sessions) && vaultStatus !== 'unlocked'
                  }
                  osUnlockAvailable={osUnlockAvailable}
                  onRestore={restoreSessions}
                  onUnlockAndRestore={(password) =>
                    unlockAndRun(password, { kind: 'restoreSessions', snapshot: modal.snapshot })
                  }
                  onUnlockWithOsAndRestore={() =>
                    unlockWithOsAndRun({ kind: 'restoreSessions', snapshot: modal.snapshot })
                  }
                  onDiscard={discardRestore}
                />
              )
            )
          case 'workspacePrompt':
            return (
              <RestoreSessionsPrompt
                count={sessionSnapshot.countSessions(modal.workspace.tabs)}
                // Always true in this state.
                needsVaultUnlock
                osUnlockAvailable={osUnlockAvailable}
                title={`Open "${modal.workspace.name}"?`}
                body="Some of its sessions need the vault unlocked. You can open it locked — those panes will come up on their connect form instead."
                cancelLabel="Open anyway — without unlocking"
                onRestore={openPendingWorkspace}
                onUnlockAndRestore={(password) =>
                  unlockAndRun(password, {
                    kind: 'openWorkspace',
                    workspace: modal.workspace,
                    originTabId: modal.originTabId,
                  })
                }
                onUnlockWithOsAndRestore={() =>
                  unlockWithOsAndRun({
                    kind: 'openWorkspace',
                    workspace: modal.workspace,
                    originTabId: modal.originTabId,
                  })
                }
                onDiscard={openPendingWorkspace}
              />
            )
          case 'reconnectPrompt':
            return (
              <RestoreSessionsPrompt
                count={1}
                // Always true in this state.
                needsVaultUnlock
                osUnlockAvailable={osUnlockAvailable}
                title="Unlock the vault to reconnect?"
                body="This session signs in with a credential from the vault, and the vault is locked."
                submitLabel="Unlock & Reconnect"
                cancelLabel="Cancel"
                // Unreachable while needsVaultUnlock is true; cancels.
                onRestore={closeModal}
                onUnlockAndRestore={(password) =>
                  unlockAndRun(password, {
                    kind: 'reconnectPane',
                    tabId: modal.tabId,
                    paneId: modal.paneId,
                  })
                }
                onUnlockWithOsAndRestore={() =>
                  unlockWithOsAndRun({
                    kind: 'reconnectPane',
                    tabId: modal.tabId,
                    paneId: modal.paneId,
                  })
                }
                onDiscard={closeModal}
              />
            )
          default:
            return null
        }
      })()}
    </div>
  )
}

export default App
