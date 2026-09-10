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
import { notifyInBackground, flashWindow } from './lib/notify'
import * as profiles from './lib/profiles'
import type { SessionProfile } from './lib/profiles'
import * as vault from './lib/vault'
import type { VaultStatus, VaultSecret } from './lib/vault'
import type { ConnectionSource } from './lib/connection'
import { parseReconnecting, shouldAutoClosePane, sourceLabel } from './lib/connection'
import { loadSettings, saveSettings, DEFAULT_FONT_SIZE, FONT_SIZE_RANGE } from './lib/settings'
import { formatCommandDuration } from './lib/shellIntegration'
import type { CommandResult } from './lib/shellIntegration'
import {
  backgroundWithOpacity,
  backgroundTint,
  findTheme,
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
  // Terminal listens for window resize to re-fit; nudge it after a tab or
  // pane becomes visible/resized (it may have been sized while hidden).
  // A plain setTimeout(0) only guarantees "after this task," not "after the
  // browser has actually flushed layout for the newly-visible container" —
  // WebView2/Chromium schedules its layout/paint pipeline differently than
  // WebKitGTK, so the synthetic resize could fire before the container's
  // real size was settled, leaving the engine's fit computed against a
  // transitional size (visible as the cursor rendering a few columns off
  // right after a tab switch, self-correcting on the next full redraw).
  // Double rAF reliably waits for a completed paint first.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
  })
}

/** Commands quicker than this never notify. Without a floor, a shell with
 * integration enabled reports *every* command, so switching tabs mid-`ls`
 * would fire a toast — which trains you to ignore them, defeating the point.
 * Ten seconds is roughly "long enough that you went and did something else". */
const COMMAND_NOTIFY_THRESHOLD_MS = 10_000

/** Progress shorter than this leaves no marker behind when it clears.
 *
 * Lower than the command threshold above because it buys less and costs less.
 * It raises a passive marker rather than a toast, and a program only reports
 * progress at all when it deliberately chose to — there is no equivalent of a
 * shell reporting every `ls`. Five seconds is enough to rule out the one real
 * false positive: a tool that flashes progress for a moment on startup. */
const PROGRESS_NOTIFY_THRESHOLD_MS = 5_000

/** The same event, for a notification the OS renders — which on Windows means
 * the lock screen, by default, for a machine the user has walked away from.
 *
 * Deliberately drops `result.command`: under OSC 633 that is the whole command
 * line, arguments included, and the native branch fires precisely when nobody
 * is at the screen to see it appear. `session_lock.rs` exists to auto-lock the
 * vault for the person who walks up to an unattended machine; putting a remote
 * command line on that machine's lock screen routes around the same reasoning.
 *
 * The session label stays, because a notification whose job is to bring you
 * back to the window has to say which pane to come back to. The detail is one
 * alt-tab away, in the in-app toast path, which only fires with the window up. */
function describeCommandResultBriefly(result: CommandResult, tabTitle: string): string {
  const took = formatCommandDuration(result.durationMs)
  if (result.exitCode === null || result.exitCode === 0) {
    return `Finished in ${took} — ${tabTitle}`
  }
  return `Exited ${result.exitCode} after ${took} — ${tabTitle}`
}

function describeCommandResult(result: CommandResult, tabTitle: string): string {
  // Falls back to a generic noun under plain OSC 133, which has no field for
  // the command line — only VS Code's OSC 633 superset reports it.
  const what = result.command ? `\`${result.command}\`` : 'Command'
  const took = formatCommandDuration(result.durationMs)
  // A null exit code means the shell reported completion without a status
  // (a bare OSC 133;D, or a prompt arriving with no D at all) — no basis to
  // call it a failure, so it reads the same as success minus the claim.
  if (result.exitCode === null || result.exitCode === 0) {
    return `${what} finished in ${took} — ${tabTitle}`
  }
  return `${what} exited ${result.exitCode} after ${took} — ${tabTitle}`
}

/** Every dialog/prompt/palette App.tsx can show, as one value instead of
 * five independently-toggled booleans/nullables — see the `modal` state
 * below for why. */
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
  // tabs/activeTabId used to be two separately-updated useState hooks; see
  // state/tabs.ts for why moving the tree surgery (split/close/pop/attach)
  // into one reducer both fixes a class of cross-hook staleness and makes
  // every mutating operation on it unit-testable with no React.
  const [{ tabs, activeTabId }, dispatchTabs] = useReducer(tabsReducer, null, () => {
    const initial = blankTab()
    return { tabs: [initial], activeTabId: initial.id }
  })
  // Replaces a `refit()` call manually appended to every function that could
  // change what's on screen (closing a pane/tab, splitting, popping,
  // attaching, switching tabs) — easy to add a new such function and forget
  // it, which is exactly why the eight pane-runtime tables leaked. Keyed on
  // the active tab's visible split geometry rather than on `tabs` itself, so
  // dragging a divider (which changes `sizes`, not which pane is where)
  // doesn't refire it — see layoutSignature.
  useLayoutEffect(() => {
    refit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSignature(tabs, activeTabId)])
  const [paneDragOverSpacer, setPaneDragOverSpacer] = useState(false)
  // Live, ephemeral per-pane state (connection status, logging, forwarded
  // panels, activity, attention) — see state/paneRuntime.ts for why this is
  // one reducer instead of eight separately-managed Records keyed by pane
  // id. The *ByPane/attentionPanes names below are kept as the read-side
  // views so the rest of this component (and the child components they're
  // passed to) didn't need to change.
  //
  // Memoized on `paneRuntime` because the reducer already returns the *same*
  // object when nothing changed (see its no-op cases), so these eight views
  // only need rebuilding when it genuinely does. Unmemoized they were eight
  // fresh Records per App render — not on the output path, since terminal
  // output bypasses React entirely, but it also means no child prop identity
  // ever survives a render, which is what makes React.memo on TabBar /
  // StatusBar / Pane worth nothing today.
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
  // Set by the toolbar search button to ask one specific pane's terminal to
  // open its search box (the box itself is per-Terminal local state, so this
  // is how an App-level control reaches into it). Targeted by pane id — not a
  // broadcast — because every tab has its own focused pane, so a plain signal
  // would open search in background tabs too. The nonce lets a repeat click on
  // the same pane re-fire.
  const [searchRequest, setSearchRequest] = useState<{ nonce: number; paneId: string } | null>(null)

  // Tabs currently broadcasting input to all their panes — SuperPuTTY's "send
  // commands to all sessions", which is the main thing keeping people on it.
  //
  // Per-tab rather than global: a tab is already the unit users group related
  // hosts into, and a global mode would mean a keystroke reaching panes in
  // tabs they can't see. Deliberately *not* persisted into workspaces either —
  // it changes what typing does, so it should not come back silently on
  // restore hours later.
  const [broadcastTabs, setBroadcastTabs] = useState<Set<string>>(new Set())
  const toggleBroadcast = useCallback((tabId: string) => {
    setBroadcastTabs((prev) => {
      const next = new Set(prev)
      if (!next.delete(tabId)) next.add(tabId)
      return next
    })
  }, [])

  // The single pane you are actually looking at: the focused pane of the
  // active tab. Everything else is out of view as far as the marker is
  // concerned — including the other half of a split, which is visible but
  // isn't where your attention is.
  const focusedPaneId = tabs.find((t) => t.id === activeTabId)?.activePaneId ?? null

  // Focusing a pane acknowledges that pane's marker, and only that one.
  // Driven off the focused pane id rather than any click handler so every
  // route in counts — clicking into the pane, Ctrl+Tab to its tab, the
  // quick-connect palette, closing the tab in front of it. The window focus
  // listener covers the case with no id change to hang it off: a marker set
  // while the whole window was in the background, where alt-tabbing back is
  // itself the acknowledgement.
  useEffect(() => {
    if (!focusedPaneId) return
    const clear = () => dispatchPaneRuntime({ type: 'attentionCleared', paneId: focusedPaneId })
    clear()
    window.addEventListener('focus', clear)
    return () => window.removeEventListener('focus', clear)
  }, [focusedPaneId])
  const [profilesVersion, setProfilesVersion] = useState(0)
  // Kept fresh here (rather than fetched lazily wherever it's needed) since
  // it now backs both the quick-connect palette and the saved-sessions
  // sidebar inside every blank pane's connect dialog.
  const [sessions, setSessions] = useState<SessionProfile[]>([])
  // Whether the first load has finished, as distinct from "the list is
  // empty". The launch-restore prompt has to wait for it: which panes are
  // vault-bound depends on their profiles' auth types, and an empty list
  // reads as "every profile is unknown, so assume all of them are" — right
  // as a default, but it would show the password form for a beat and then
  // swap it for the plain Restore buttons once the profiles arrived.
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  useEffect(() => {
    profiles
      .listSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setSessionsLoaded(true))
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
  // The quick-connect palette, a close confirmation, the launch-restore
  // prompt and the open-workspace-needs-vault prompt used to be five
  // separately-updated pieces of state (paletteOpen, pendingRestore,
  // pendingClose, pendingWorkspace, restoreDecided) — nothing stopped two
  // of them from being true at once, which is a real class of bug in an app
  // with this many prompts. One value that can only ever be one thing at a
  // time makes "two dialogs open simultaneously" unrepresentable instead of
  // just unlikely.
  //
  // The restore-prompt decision itself used to run in a post-mount effect;
  // it's a lazy initializer here instead; sessionSnapshot.loadSnapshot() is
  // synchronous and local, same as terminalSettings just above, so there's
  // nothing to wait for the DOM to exist for. That's also what lets
  // `restoreDecided` disappear entirely below — the very first render
  // already reflects the decision, rather than needing a moment before an
  // effect resolves it.
  const [modal, setModal] = useState<Modal>(() => {
    if (!terminalSettings.restoreSessionsOnLaunch) return { kind: 'none' }
    const snapshot = sessionSnapshot.loadSnapshot()
    if (snapshot && sessionSnapshot.countSessions(snapshot.tabs) > 0) {
      return { kind: 'restorePrompt', snapshot }
    }
    return { kind: 'none' }
  })
  const closeModal = () => setModal({ kind: 'none' })
  // Derived, not stored: true from the first render onward once there was
  // never a restore prompt to begin with, and forever after the one time
  // the modal actually does leave 'restorePrompt'.
  const restoreDecided = modal.kind !== 'restorePrompt'
  // Flat list of every live (source-holding) pane across every tab — the
  // pool that Terminal instances are portaled from, and what usePanePortals
  // prunes its home containers against. See usePanePortals.ts for why
  // Terminal isn't just rendered inline per tab.
  const connectedEntries = tabs.flatMap((tab) =>
    allLeaves(tab.root)
      .filter((leaf) => leaf.source)
      .map((leaf) => ({ tab, leaf })),
  )
  const { registerSlot, getHomeContainer } = usePanePortals(connectedEntries.map(({ leaf }) => leaf.id))

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

  // The tone every label, hairline and hover wash outside the terminal is
  // drawn in, and the surface every dialog and menu is painted with — see
  // chromeRgb and surfaceRgb. Set on the document element rather than on
  // this component's own root because the dialogs and menus that need them
  // are portalled out to the body, which is not inside that root.
  //
  // Both together, because they are two halves of one answer: the text tone
  // flips on a light theme, so the surface under it has to move in the same
  // breath or the two end up the same colour.
  useEffect(() => {
    const theme = findTheme(terminalSettings.themeName)
    document.documentElement.style.setProperty('--chrome-rgb', chromeRgb(theme))
    document.documentElement.style.setProperty('--surface-rgb', surfaceRgb(theme))
    // And the widgets the browser paints rather than we do — see
    // themeColorScheme.
    document.documentElement.style.colorScheme = themeColorScheme(theme)
  }, [terminalSettings.themeName])

  // Panes with an auto-reconnect run under way, so the per-attempt failures a
  // run produces don't each raise a toast. A ref rather than state because the
  // only reader is the onStatus callback, which closes over a render's state
  // and would always see this one status behind — and because nothing renders
  // from it: the pane draws its own reconnecting strip from its own state.
  const reconnectingPanes = useRef(new Set<string>())

  // Read by the window-close hook below, which is mounted once and so can't
  // close over the current tabs/settings. Recomputed each render rather than
  // kept in state: it's a handful of leaves, and a stale answer here means
  // either nagging about nothing or dropping live sessions silently.
  const closeGuardRef = useRef({ connected: 0, enabled: true })
  closeGuardRef.current = {
    connected: tabs.reduce((n, t) => n + connectedPanes(t.root), 0),
    enabled: terminalSettings.confirmCloseWithConnection,
  }
  // Registering this listener at all changes how the window closes: the JS
  // API destroys the window itself once the handler returns without calling
  // preventDefault (see onCloseRequested in @tauri-apps/api). So every close
  // now goes through destroy(), which needs core:window:allow-destroy in
  // capabilities/default.json — without it the permission check rejects the
  // call and the close button silently does nothing at all.
  //
  // Nothing is lost by destroy() here: tauri-plugin-window-state saves the
  // geometry from the CloseRequested event, which is this one, so it has
  // already run by the time the window goes away.
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

  // A double-click aimed at the ✕ on the last tab must not maximize the
  // window when the drag-region spacer slides under the second press.
  useDragRegionDoubleClickGuard()

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
    // A vault import replaces sessions.json and workspaces.json too (all
    // three travel as one bundle — see vault_export/vault_import), so
    // anything that can change vault status also potentially changed the
    // saved-sessions and saved-workspace lists.
    setProfilesVersion((v) => v + 1)
    setWorkspacesVersion((v) => v + 1)
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

  // Keeps the on-disk snapshot current as tabs/panes change, rather than
  // only writing it on a clean exit — a crash or force-quit shouldn't lose
  // it either. Gated on restoreDecided so this can't fire (and overwrite
  // the very snapshot being offered) before the startup prompt is answered.
  useEffect(() => {
    if (!restoreDecided) return
    sessionSnapshot.saveSnapshot(tabs, activeTabId)
  }, [tabs, activeTabId, restoreDecided])

  /** The snapshot carries the same captured-copy staleness a workspace does —
   * it was written before the app last closed, and profiles can have been
   * edited since (by another window, or by a vault import) — so it gets the
   * same live re-resolution. Unlike a workspace its pane ids are kept, since
   * nothing else in the window is using them yet.
   *
   * `vaultUsable` is passed rather than read off `vaultStatus` for the same
   * reason materializeWorkspace takes it: the unlock paths below call this
   * immediately after refreshVaultStatus(), whose setState hasn't landed yet,
   * so the state still reads 'locked' and every pane just unlocked for would
   * be blanked. */
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

  /** The effects half of the vault-gated action dispatcher; the union and the
   * routing between these live in state/vaultGate.ts, where they can be
   * tested without a React tree. Only the parts that genuinely need App's
   * reducers and modal state are here. */
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

  /** Same as unlockAndRun, but via the OS-keychain unlock (Windows sign-in,
   * gated by a fresh Windows Hello/PIN check on Windows) instead of a typed
   * master password. */
  async function unlockWithOsAndRun(action: VaultGatedAction) {
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
    await runVaultGatedAction(action, vaultGateEffects)
  }

  function newTab() {
    dispatchTabs({ type: 'tabOpened', tab: blankTab() })
  }

  /** Panes in this subtree holding a live connection — what closing would
   * drop. A pane still sitting on its connect form costs nothing to close,
   * so only established sessions are worth interrupting anyone over. */
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
    // Every pane in the tab is gone, not just the active one — a closed
    // split tab used to leak its runtime state (status, logging, activity,
    // ...) for every pane but the one or two spots that happened to clean up
    // after themselves. One dispatch per leaf, closing the class of bug
    // rather than one instance of it.
    const closing = tabs.find((t) => t.id === id)
    if (closing) {
      for (const leaf of allLeaves(closing.root)) {
        dispatchPaneRuntime({ type: 'paneClosed', paneId: leaf.id })
      }
    }
    dispatchTabs({ type: 'tabClosed', tabId: id })
    // Tab ids are never reused, but leaving the entry behind would mean a
    // growing set of dead ids, so it goes with the tab.
    setBroadcastTabs((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    // Closing the active tab can reveal its neighbour, which was hidden (and
    // so sized 0x0) until now — handled by the layoutSignature-keyed refit
    // effect below rather than a call here, same as every other tree change.
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

  /** Reconnects one specific pane in place (generation bump remounts its
   * Terminal, which reconnects). */
  function reconnectPaneNow(tabId: string, paneId: string) {
    dispatchTabs({ type: 'paneReconnected', tabId, paneId })
  }

  /** The Reconnect action, gated on the vault the same way opening a
   * workspace is.
   *
   * The case this exists for: the machine sleeps, every link drops, and the
   * vault's idle timer locks it while nothing is watching. Reconnect on a
   * profile-backed pane then remounts the Terminal, which dials, which fails
   * on "vault is locked" — and the button, pressed again, fails again with no
   * hint that the missing piece is one password away. Asking for it here
   * turns that dead end into the unlock prompt the pane actually needs.
   *
   * Only vault-bound panes are gated: a telnet or serial pane, or a
   * profile whose auth needs no secret, reconnects with the vault left
   * locked exactly as before. */
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
   *
   * `refreshTabs` also re-reads each pane's profile, so a workspace saved
   * before a profile was renamed or moved opens against what that profile is
   * now rather than what it was.
   */
  function materializeWorkspace(
    workspace: Workspace,
    vaultUsable: boolean,
    originTabId?: string | null,
  ) {
    const restored: Tab[] = refreshTabs(workspace.tabs, sessions, vaultUsable).map((t) => {
      // reidentify() invalidates the stored activePaneId along with every
      // other id, so the first pane takes over — and the title has to be
      // recomputed from that same pane, not the one refreshTabs picked.
      const root = reidentify(t.root)
      const active = firstLeaf(root)
      return { ...t, id: newTabId(), root, activePaneId: active.id, title: leafTitle(active, t.title) }
    })
    dispatchTabs({ type: 'workspaceMaterialized', restored, originTabId: originTabId ?? null })
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
    if (sessionSnapshot.needsVaultUnlock(workspace.tabs, sessions) && vaultStatus === 'locked') {
      // The origin has to survive the prompt, or unlocking would materialise
      // the workspace next to the blank tab instead of over it.
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
    paneOptions?: { backspaceSendsCtrlH: boolean | null; autoReconnect: boolean | null },
  ) {
    // Set logging state before the source, so the Terminal mounts with logging
    // already armed and captures output from the first byte (batched with the
    // dispatch below in the same event, so it's a single render). The toolbar
    // icon then reflects this and can stop it mid-session.
    dispatchPaneRuntime({ type: 'loggingSet', paneId, logging: logSession })
    dispatchTabs({
      type: 'paneConnected',
      tabId,
      paneId,
      source,
      backspaceSendsCtrlH: paneOptions?.backspaceSendsCtrlH ?? null,
      autoReconnect: paneOptions?.autoReconnect ?? null,
    })
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
    dispatchTabs({ type: 'paneDisconnected', tabId, paneId })
  }

  function focusPane(tabId: string, paneId: string) {
    dispatchTabs({ type: 'paneFocused', tabId, paneId })
  }

  function splitPane(tabId: string, paneId: string, direction: 'horizontal' | 'vertical') {
    // The limit check also lives on the toolbar buttons, which disable
    // themselves at a limit — this only catches a caller that hasn't asked
    // first, and the reducer itself no-ops past the cap regardless.
    dispatchTabs({ type: 'paneSplit', tabId, paneId, direction })
  }

  function toggleLogging(paneId: string) {
    dispatchPaneRuntime({ type: 'loggingToggled', paneId })
  }

  function toggleForwards(paneId: string) {
    dispatchPaneRuntime({ type: 'panelToggled', paneId, panel: 'forwards' })
    // Both panels anchor to the same corner of the pane — keep them
    // mutually exclusive rather than stacking or overlapping.
    dispatchPaneRuntime({ type: 'panelSet', paneId, panel: 'files', open: false })
  }

  function closeForwards(paneId: string) {
    dispatchPaneRuntime({ type: 'panelSet', paneId, panel: 'forwards', open: false })
  }

  function toggleFiles(paneId: string) {
    dispatchPaneRuntime({ type: 'panelToggled', paneId, panel: 'files' })
    dispatchPaneRuntime({ type: 'panelSet', paneId, panel: 'forwards', open: false })
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
      // Already confirmed as a pane close if it needed to be — going through
      // closeTab here would ask a second time for the same one connection.
      // closeTabNow dispatches paneClosed for every leaf still in the tab
      // (just this one, here), so there's nothing left to clean up on this
      // path.
      closeTabNow(tabId)
      return
    }
    dispatchPaneRuntime({ type: 'paneClosed', paneId })
    dispatchTabs({ type: 'paneClosed', tabId, paneId })
  }

  /** Extracts a pane out of its (split) tab into its own new tab. The leaf
   * object — and the pooled Terminal/session it identifies — carries over
   * untouched; only its tree position changes. */
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

  /** Attaches a dragged tab's connection into an empty pane elsewhere,
   * closing the tab it came from. Same principle as popPaneToNewTab: the
   * leaf object moves, its id (and therefore its pooled Terminal) doesn't
   * change, so the live session is untouched by the move. */
  function attachTabToPane(targetPaneId: string, draggedTabId: string) {
    const draggedTab = tabs.find((t) => t.id === draggedTabId)
    if (!draggedTab || draggedTab.root.type !== 'leaf' || !draggedTab.root.source) return
    const draggedLeaf: PaneLeaf = draggedTab.root
    // Whatever was at targetPaneId before is discarded from the tree by the
    // reducer — its own leaf id is targetPaneId, since that's how it was
    // found — so its runtime state (if it has any at all) needs to go too,
    // same as any other pane that stops being reachable in the tree. The
    // dragged leaf itself keeps its own id and needs no such cleanup; it's
    // still live, just relocated.
    const replacedExisting = tabs.some((t) => t.id !== draggedTabId && findLeaf(t.root, targetPaneId))
    if (replacedExisting) dispatchPaneRuntime({ type: 'paneClosed', paneId: targetPaneId })
    dispatchTabs({ type: 'tabAttachedToPane', targetPaneId, draggedTabId })
    toast.success(`Attached ${leafTitle(draggedLeaf, sourceLabel(draggedLeaf.source!))}`)
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

    // Serial has no credential either, but unlike telnet it *does* need a
    // backend round trip: the profile stores the adapter's USB identity, and
    // only the Rust side can turn that into whichever COM number the adapter
    // holds right now. Hence a `serialProfile` source rather than a config
    // built from stored fields.
    if (profile.protocol === 'serial') {
      return {
        source: { protocol: 'serialProfile' as const, profileId: profile.id },
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

  /** Applies a source/initial pair to an already-open pane, in place —
   * shared by connectPaneFromProfile, editPaneFromProfile, and
   * unlockVaultAndConnectProfile below. */
  function applyProfileToPane(
    tabId: string,
    paneId: string,
    source: ConnectionSource | null,
    initial: PaneLeaf['initial'],
  ) {
    dispatchTabs({ type: 'paneProfileApplied', tabId, paneId, source, initial })
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

  function deleteSessionProfile(profile: SessionProfile) {
    // Deleting the profile doesn't touch the vault on its own — without
    // this, a profile with hasCredential would leave its actual credential
    // orphaned in the vault, keyed by an id nothing references anymore.
    // Best-effort: the profile itself is still gone either way, even if the
    // vault happens to be locked right now and can't be reached. The backend
    // sweeps whatever this misses on the next unlock (see
    // `prune_orphaned_credentials`), which is the only place it *can* be
    // done — a locked vault can't have an entry removed from it at all.
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

  // Fire-and-forget by design: a magic packet is a UDP broadcast with no
  // acknowledgement of any kind, so "sent" is the only thing that can honestly
  // be reported. Whether the machine actually wakes is answered by connecting
  // to it, which is the other half of the feature.
  function wakeSessionProfile(profile: SessionProfile) {
    profiles
      .wakeSession(profile.id)
      .then(() => toast.success(`Sent a magic packet to "${profile.label}"`))
      .catch((err) => toast.error(`Couldn't wake session: ${err}`))
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
    setModal({ kind: 'palette' })
  }

  /**
   * A step up or down the font size, or back to the default.
   *
   * Through the same setting the slider writes, so zooming is not a second,
   * temporary size that a visit to Settings would silently undo — and so it
   * persists, which is what anyone who has just made the text bigger expects
   * of the next window they open.
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

  // Keydown handlers close over state that changes every render; rather than
  // re-subscribing the listener on every change, keep a ref to the latest
  // callbacks and mount the listener once.
  const shortcutsRef = useRef({ newTab, closeTab, stepTab, openPalette, zoomFont, activeTabId })
  shortcutsRef.current = { newTab, closeTab, stepTab, openPalette, zoomFont, activeTabId }

  useEffect(() => {
    // Capture phase so these fire before the engine's own keydown handler can
    // treat them as shell input (e.g. Ctrl+W deletes a word in most
    // shells, so tab shortcuts intentionally avoid plain Ctrl combos).
    function onKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey) return
      const s = shortcutsRef.current

      // Font zoom, on the bindings every terminal and browser already shares.
      // Plain Ctrl combos, unlike the tab shortcuts above, because these are
      // the ones people arrive with -- and because the keys involved are ones
      // a shell has no use for. Ctrl+- in particular is not readline's undo;
      // that is Ctrl+_, which is Ctrl+*Shift*+- and deliberately left alone.
      //
      // preventDefault is what keeps them off the far end: the engine's input
      // handler skips any event that has already been consumed.
      if (!e.altKey && (e.key === '+' || e.key === '=')) {
        e.preventDefault()
        s.zoomFont(1)
        return
      }
      if (!e.altKey && !e.shiftKey && e.key === '-') {
        e.preventDefault()
        s.zoomFont(-1)
        return
      }
      if (!e.altKey && !e.shiftKey && e.key === '0') {
        e.preventDefault()
        s.zoomFont('reset')
        return
      }

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
  // Per-direction, because the limits are per-axis: a tab that's four panes
  // tall can still be split sideways, and only the button that would breach
  // a cap goes dim.
  const splitBlocked = (direction: 'horizontal' | 'vertical'): SplitLimit | null =>
    activeTab && activePaneId ? splitBlocker(activeTab.root, activePaneId, direction) : null
  const rightBlocked = splitBlocked('horizontal')
  const downBlocked = splitBlocked('vertical')

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
      case 'serialProfile': {
        const p = sessions.find((s) => s.id === src.profileId)?.serial
        if (!p) return { protocol: 'SERIAL', target: src.profileId }
        const framing = `${dataBitsDigit(p.dataBits)}${p.parity[0]}${p.stopBits === 'Two' ? 2 : 1}`
        // The adapter, not the COM number: the port is resolved at connect
        // time and may not be the one stored, so showing the stored name here
        // would be showing something that isn't true.
        const adapter = p.identity.usb?.serialNumber ?? p.identity.portName
        return { protocol: 'SERIAL', target: `${adapter} · ${p.baudRate} ${framing}` }
      }
      // The shell's name plus its arguments, which is the whole of what
      // identifies a local session — there is no endpoint to resolve. A WSL
      // profile reads as `wsl -d Ubuntu`, which is what makes two of them
      // distinguishable in the status bar.
      case 'local': {
        const args = src.config.args.join(' ')
        const label = sourceLabel(src)
        return { protocol: 'LOCAL', target: args ? `${label} ${args}` : label }
      }
    }
  })()
  const activePaneIndex = activePaneId
    ? activePaneLeaves.findIndex((l) => l.id === activePaneId) + 1
    : 0

  // Shared with the tab strip, where the active tab takes it as its own fill
  // so that tab and terminal read as one surface, and with panes that have no
  // connection yet, which paint it for themselves so waiting for one doesn't
  // look different from having one.
  const paneBackground = backgroundWithOpacity(
    findTheme(terminalSettings.themeName),
    terminalSettings.backgroundOpacity,
  )

  return (
    <div
      className={`flex h-screen w-screen flex-col overflow-hidden ${
        maximized ? '' : 'rounded-lg border border-chrome/10'
      }`}
      style={{ background: paneBackground }}
    >
      {/* No bottom hairline: the tabs above it have rounded tops now, and a
       * line running under the active one cut it off from the terminal it
       * belongs to — the opposite of what the shape is for. Erasing the line
       * only under that tab isn't available to us (every fill here is
       * translucent, so overpainting a translucent border tints it rather than
       * removing it, and segmenting the line leaves 2px breaks at the gaps
       * between tabs). Dropping it outright is the better answer anyway: the
       * strip's own wash is what separates it from the terminal by tone, and
       * the active tab, painted in the terminal's own colour, now runs
       * straight down into it with nothing crossing the join. */}
      <div
        className="flex h-10 shrink-0 items-stretch"
        // Away from the theme's background rather than a fixed direction —
        // see stripOverlay. A hardcoded bg-black/20 here had nowhere to go on
        // Campbell and left the strip, the quiet tabs and the active tab all
        // the same colour.
        style={{ background: stripOverlay(findTheme(terminalSettings.themeName)) }}
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
          <div className="flex shrink-0 items-center gap-0.5 border-l border-chrome/10 px-1.5">
            {activeLeaf?.source && (
              <button
                className="flex items-center justify-center rounded p-1.5 text-chrome/50 transition-colors duration-fast ease-swift hover:bg-chrome/10 hover:text-chrome/90"
                title="Find in terminal (Ctrl+Shift+F)"
                onClick={() =>
                  activePaneId &&
                  setSearchRequest((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, paneId: activePaneId }))
                }
              >
                <Search size={15} strokeWidth={2} />
              </button>
            )}
            {/* Only offered on a tab with more than one pane: on a single
                pane "broadcast" and "type normally" are the same thing, and a
                mode that appears to do nothing is how a user learns to leave
                it on. */}
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
                // Marks this button as part of the panel's own interaction
                // scope, so the panel's click-away doesn't treat opening it as
                // a click elsewhere. Without it the panel closed on the very
                // click that opened it.
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
            {/* Kept visible-but-disabled at the split limit rather than
                hidden: buttons vanishing from the toolbar reads as a bug,
                whereas a dimmed one with a tooltip explains itself. */}
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
                statusByPane={statusByPane}
                filesOpenByPane={filesOpenByPane}
                cwdByPane={cwdByPane}
                titleByPane={titleByPane}
                editorCommand={terminalSettings.externalEditor}
                paneBackground={paneBackground}
                sessionIdByPane={sessionIdByPane}
                sessions={sessions}
                workspaces={savedWorkspaces}
                onOpenWorkspace={(w) => openWorkspace(w, tab.id)}
                onFocusPane={(paneId) => focusPane(tab.id, paneId)}
                // `paneOptions` carries the connect dialog's "Backspace key
                // sends" choice. Dropping it here — which this did — left the
                // setting with no effect on any connection made through the
                // dialog; only panes restored from a saved profile got it,
                // because those read it from the profile instead.
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
                  autoReconnect={leaf.autoReconnect}
                  logging={loggingByPane[leaf.id] ?? false}
                  active={leaf.id === tab.activePaneId}
                  paneId={leaf.id}
                  broadcastGroupId={tab.id}
                  broadcasting={broadcastTabs.has(tab.id)}
                  searchRequest={searchRequest}
                  onStatus={(s) => {
                    // The connectedAt coupling (stamp once per connected run,
                    // drop on anything else, so the uptime clock resets on
                    // reconnect instead of counting through the outage) lives
                    // in the reducer now — see paneRuntime.ts's statusChanged
                    // case.
                    dispatchPaneRuntime({ type: 'statusChanged', paneId: leaf.id, status: s, now: Date.now() })
                    // Surfaced even for background tabs — otherwise a
                    // failed connection in a tab you're not looking at is
                    // silent.
                    //
                    // Not while an auto-reconnect run is under way, though.
                    // Each attempt reports its own failure from inside the
                    // transport, so a run would raise a dozen toasts for one
                    // outage and bury the reconnecting state under its own
                    // progress. Giving up arrives as a final `failed` with the
                    // run's last error in it, by which point the pane is no
                    // longer reconnecting and this fires — one toast, carrying
                    // the reason that actually matters.
                    if (s.startsWith('failed') && !reconnectingPanes.current.has(leaf.id)) {
                      toast.error(s.replace(/^failed: /, ''))
                    }
                    // A ref, not `statusByPane`: this callback closes over the
                    // state from the render that installed it, so the map it
                    // can see is always one status behind — the same staleness
                    // the close-on-disconnect note below was written about.
                    if (parseReconnecting(s)) reconnectingPanes.current.add(leaf.id)
                    else if (s === 'connected' || s.startsWith('failed')) {
                      reconnectingPanes.current.delete(leaf.id)
                    }
                    // A clean remote-initiated disconnect (the shell
                    // exited, the server hung up) closes the pane on its
                    // own rather than leaving a dead terminal sitting open
                    // — but only a clean disconnect, not a failure, since
                    // the error should stay visible until the user
                    // dismisses it themselves.
                    // closePaneNow, not closePane: there is nothing to
                    // confirm here. The session has already ended — usually
                    // because the user typed `exit` — so asking whether they
                    // meant to drop it is both wrong and unanswerable.
                    //
                    // Going through the guarded closePane also asked at the
                    // wrong time regardless: this callback's closure holds
                    // the statusByPane from the render that ran *before* the
                    // update above committed, so the check 800ms later still
                    // read the pane as connected.
                    //
                    // A *clean* disconnect only — see `shouldAutoClosePane`.
                    // This used to fire on `lost` too, which meant the setting
                    // quietly disabled auto-reconnect for everyone who had it
                    // on (it is on by default): closing the pane removes the
                    // session id, and that is exactly what stops a reconnect
                    // run. The two were never actually in conflict.
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
                    // The moment a full-screen program over SSH finally has
                    // something to say. While it works the running marker
                    // covers it, but that marker vanishes the instant it
                    // stops — so without this, coming back from another app
                    // means finding a tab that looks exactly as idle as one
                    // that never ran anything.
                    if (durationMs < PROGRESS_NOTIFY_THRESHOLD_MS) return
                    // Same "was this pane in view" test as a bell — the other
                    // half of a split finishing still deserves a marker.
                    if (leaf.id === focusedPaneId && document.hasFocus()) return
                    dispatchPaneRuntime({ type: 'attentionRaised', paneId: leaf.id })
                    // Marker and flash, but no toast or notification, which is
                    // the bell's treatment rather than a command completion's.
                    // All this knows is that something stopped: it has no
                    // command line, no exit code and no text, so a notification
                    // would say nothing the flashing button doesn't. A program
                    // with something to say can say it — that's OSC 9/777, and
                    // it goes through onRemoteNotify below.
                    if (!document.hasFocus()) void flashWindow()
                  }}
                  onRemoteTitle={(title) =>
                    dispatchPaneRuntime({ type: 'titleChanged', paneId: leaf.id, title })
                  }
                  onRemoteCwd={(cwd) =>
                    dispatchPaneRuntime({ type: 'cwdChanged', paneId: leaf.id, cwd })
                  }
                  onRemoteNotify={(notification) => {
                    if (!terminalSettings.remoteNotifications) return
                    // The pane's name is prepended rather than used as the
                    // title, so remote text can never occupy the line a user
                    // reads as the app speaking. A hostile host gets to say
                    // something; it does not get to say it *as* wRusTTY.
                    const from = notification.title
                      ? `${tab.title}: ${notification.title}`
                      : tab.title
                    // Same "was this pane in view" test as a bell or a
                    // completion — a notification from the other half of a
                    // split still deserves a marker.
                    if (!(leaf.id === focusedPaneId && document.hasFocus())) {
                      dispatchPaneRuntime({ type: 'attentionRaised', paneId: leaf.id })
                    }
                    // Shown even for the pane you are watching, unlike a
                    // command completion. A completion is inferred, so it has
                    // to guess whether you needed telling; this was asked for
                    // by name, and swallowing it would make the sequence
                    // unreliable in the one case its sender can't detect.
                    if (document.hasFocus()) {
                      toast.info(`${from} — ${notification.body}`)
                      return
                    }
                    // The body is deliberately dropped on the native path, the
                    // same call `describeCommandResultBriefly` makes and for a
                    // stronger reason: this is 200 characters an attacker
                    // chose, and the native branch fires precisely when nobody
                    // is at the screen — on Windows that is the lock screen of
                    // a machine the user has walked away from. Whoever walks up
                    // to it is the person `session_lock.rs` exists for, and one
                    // policy has to cover both channels.
                    //
                    // The pane name survives, because a notification whose job
                    // is to bring you back to the window has to say which one.
                    // The body is one alt-tab away in the toast path.
                    void notifyInBackground(tab.title, 'sent a notification')
                  }}
                  onCommandComplete={(result) => {
                    if (!terminalSettings.notifyOnCommandComplete) return
                    // A full-screen program (vim, top) that you quit a moment
                    // ago isn't a background job landing.
                    if (result.interactive) return
                    if (result.durationMs < COMMAND_NOTIFY_THRESHOLD_MS) return
                    // The marker and the toast have different bars, because
                    // they cost different amounts of attention. The marker is
                    // passive, so it only needs you to not have been watching
                    // *this pane* — the other half of a split finishing while
                    // you work in this one is exactly what it's for. The toast
                    // interrupts, so it waits until the whole tab is out of
                    // view and you had no way of seeing it at all.
                    const paneInView = leaf.id === focusedPaneId && document.hasFocus()
                    const tabInView = tab.id === activeTabId && document.hasFocus()
                    if (!paneInView) {
                      dispatchPaneRuntime({ type: 'attentionRaised', paneId: leaf.id })
                    }
                    if (tabInView) return
                    if (document.hasFocus()) {
                      // The window is up, just on a different tab — an in-app
                      // toast is exactly right here, and a native one would be
                      // redundant with something already on screen. It gets
                      // the full description, command line included: the user
                      // is demonstrably at the machine.
                      const message = describeCommandResult(result, tab.title)
                      if (result.exitCode) toast.error(message)
                      else toast.success(message)
                      return
                    }
                    // The window isn't in front, which is the case the whole
                    // feature exists for and the one a toast cannot serve: it
                    // would appear and expire entirely unseen. Deliberately
                    // the shorter description — see
                    // `describeCommandResultBriefly`.
                    void notifyInBackground(
                      result.exitCode ? 'Command failed' : 'Command finished',
                      describeCommandResultBriefly(result, tab.title),
                    )
                  }}
                  onBell={() => {
                    // Sound fires for every bell, including one from the pane
                    // you're looking at: that's the case where a bell is most
                    // often deliberate (a script signalling it's done while
                    // you read something else on screen), and it's the half
                    // of the bell a terminal has always had.
                    if (terminalSettings.bellSound) playBell()
                    if (!terminalSettings.bellMarksTab) return
                    // Same "was this pane in view" test as a completion — a
                    // bell from the other half of a split still deserves a
                    // marker.
                    if (leaf.id === focusedPaneId && document.hasFocus()) return
                    dispatchPaneRuntime({ type: 'attentionRaised', paneId: leaf.id })
                    // A bell is the oldest "I want your attention" signal
                    // there is, and it works with no shell-side setup at all —
                    // so it earns the taskbar flash when the window is away.
                    // No notification for it, though: a bell carries no
                    // message, and a toast reading "bell" says nothing the
                    // flashing button doesn't.
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
                  // Only mentioned when it's true, since it materially changes
                  // how much closing costs — and claiming it when the setting
                  // is off would be worse than saying nothing.
                  (terminalSettings.restoreSessionsOnLaunch ? ' They can be reopened next launch.' : '')
                }
                confirmLabel="Quit"
                onConfirm={() => {
                  closeModal()
                  // destroy() rather than close(): close() would just re-emit
                  // CloseRequested and land back in the hook above, which then
                  // destroys anyway — same outcome, one extra round trip, and
                  // it needs a flag to avoid asking twice.
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
                  count={sessionSnapshot.countSessions(modal.snapshot.tabs)}
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
                // Always true here — openWorkspace only sets this state when
                // the vault is locked and the workspace needs it.
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
                // Always true here — reconnectPane only reaches this state
                // for a vault-bound pane with the vault locked.
                needsVaultUnlock
                osUnlockAvailable={osUnlockAvailable}
                title="Unlock the vault to reconnect?"
                body="This session signs in with a credential from the vault, and the vault is locked."
                submitLabel="Unlock & Reconnect"
                cancelLabel="Cancel"
                // Unreachable while needsVaultUnlock is true, but the prop is
                // required: reconnecting without the unlock is the failure
                // this prompt exists to avoid, so it cancels instead.
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
