import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
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
  ArrowLeftRight,
  Folder,
  Search,
  Cpu,
} from 'lucide-react'
import { toast } from './lib/toast'
import * as profiles from './lib/profiles'
import type { SessionProfile } from './lib/profiles'
import * as vault from './lib/vault'
import type { VaultStatus, VaultSecret } from './lib/vault'
import type { ConnectionSource } from './lib/connection'
import { sourceLabel } from './lib/connection'
import { loadSettings, saveSettings } from './lib/settings'
import { formatCommandDuration } from './lib/shellIntegration'
import type { CommandResult } from './lib/shellIntegration'
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
  splitBlocker,
} from './lib/paneTree'
import type { SplitLimit } from './lib/paneTree'
import * as sessionSnapshot from './lib/sessionSnapshot'
import type { SessionSnapshot } from './lib/sessionSnapshot'
import type { PaneLeaf, PaneNode, Tab } from './types'
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
  attentionPanesOf,
} from './state/paneRuntime'
import { tabsReducer, layoutSignature } from './state/tabs'

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

/** Commands quicker than this never notify. Without a floor, a shell with
 * integration enabled reports *every* command, so switching tabs mid-`ls`
 * would fire a toast — which trains you to ignore them, defeating the point.
 * Ten seconds is roughly "long enough that you went and did something else". */
const COMMAND_NOTIFY_THRESHOLD_MS = 10_000

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

function App() {
  // Temporary switch for Phase 2 go/no-go milestone test


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
  const [paneRuntime, dispatchPaneRuntime] = useReducer(paneRuntimeReducer, {})
  const statusByPane = statusByPaneOf(paneRuntime)
  const connectedAtByPane = connectedAtByPaneOf(paneRuntime)
  const loggingByPane = loggingByPaneOf(paneRuntime)
  const forwardsOpenByPane = forwardsOpenByPaneOf(paneRuntime)
  const filesOpenByPane = filesOpenByPaneOf(paneRuntime)
  const sessionIdByPane = sessionIdByPaneOf(paneRuntime)
  const activityByPane = activityByPaneOf(paneRuntime)
  const attentionPanes = attentionPanesOf(paneRuntime)
  // Set by the toolbar search button to ask one specific pane's terminal to
  // open its search box (the box itself is per-Terminal local state, so this
  // is how an App-level control reaches into it). Targeted by pane id — not a
  // broadcast — because every tab has its own focused pane, so a plain signal
  // would open search in background tabs too. The nonce lets a repeat click on
  // the same pane re-fire.
  const [searchRequest, setSearchRequest] = useState<{ nonce: number; paneId: string } | null>(null)

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

  /** What a vault unlock was for — the launch-restore prompt, the
   * open-workspace prompt, and the per-pane saved-session sidebar's own
   * unlock form each used to hand-roll their own password/OS pair of
   * unlock-then-act functions (six total). One dispatcher plus two shared
   * unlock entry points below replace all six; adding a fourth vault-gated
   * action is a new union member here, not a new pair of functions. */
  type VaultGatedAction =
    | { kind: 'restoreSessions'; snapshot: SessionSnapshot }
    | { kind: 'openWorkspace'; workspace: Workspace; originTabId: string | null }
    | { kind: 'connectProfile'; tabId: string; paneId: string; profile: SessionProfile }

  async function runVaultGatedAction(action: VaultGatedAction) {
    switch (action.kind) {
      case 'restoreSessions':
        applyRestore(action.snapshot, true)
        return
      case 'openWorkspace':
        materializeWorkspace(action.workspace, true, action.originTabId)
        closeModal()
        return
      case 'connectProfile': {
        // Checked fresh against the Rust side rather than trusting
        // `vaultStatus` React state, which wouldn't have caught up yet at
        // this point in the same call.
        const hasCredential = await vault.hasCredential(action.profile.id).catch(() => false)
        const source: ConnectionSource | null = hasCredential
          ? { protocol: 'sshProfile', profileId: action.profile.id }
          : null
        applyProfileToPane(action.tabId, action.paneId, source, profileToInitial(action.profile))
        return
      }
    }
  }

  /** Unlocks the vault with a freshly-typed master password, then runs
   * whatever vault-gated action was waiting on it. */
  async function unlockAndRun(password: string, action: VaultGatedAction) {
    await vault.unlock(password)
    refreshVaultStatus()
    await runVaultGatedAction(action)
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
    await runVaultGatedAction(action)
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
  function reconnectPane(tabId: string, paneId: string) {
    dispatchTabs({ type: 'paneReconnected', tabId, paneId })
  }

  /** Reconnects the tab's active pane in place (the tab-context-menu action). */
  function reconnectTab(id: string) {
    const tab = tabs.find((t) => t.id === id)
    if (tab) reconnectPane(id, tab.activePaneId)
  }

  /** Switches one pane's rendering engine. The grid and scrollback live inside
   *  the engine, so swapping it means tearing one down and building the other —
   *  there is nothing to hand over — which the generation bump does by remounting
   *  the Terminal (and thereby reconnecting the session). Deliberate and rare:
   *  the escape hatch for the handful of upstream ghostty-web ABI gaps. */
  function setPaneEngine(tabId: string, paneId: string, engine: 'xterm' | 'ghostty') {
    dispatchTabs({ type: 'paneEngineSet', tabId, paneId, engine })
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
    paneOptions?: { backspaceSendsCtrlH: boolean | null },
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
    setModal({ kind: 'palette' })
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
          activityByPane={activityByPane}
          attentionPanes={attentionPanes}
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
            {activeLeaf?.source &&
              (() => {
                const current = activeLeaf.engine ?? 'ghostty'
                const other = current === 'ghostty' ? 'xterm' : 'ghostty'
                const label = (e: 'xterm' | 'ghostty') => (e === 'ghostty' ? 'Ghostty' : 'xterm')
                return (
                  <button
                    className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-white/10 ${
                      // Highlighted only when overridden to xterm, so a pane on
                      // the non-default fallback engine reads at a glance.
                      current === 'xterm' ? 'text-amber-400 hover:text-amber-300' : 'text-white/50 hover:text-white/90'
                    }`}
                    title={`Rendering engine: ${label(current)}${current === 'ghostty' ? ' (default)' : ''} — click to switch to ${label(other)} (reconnects this pane)`}
                    onClick={() => activeTab && activePaneId && setPaneEngine(activeTab.id, activePaneId, other)}
                  >
                    <Cpu size={15} strokeWidth={2} />
                  </button>
                )
              })()}
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
            {/* Kept visible-but-disabled at the split limit rather than
                hidden: buttons vanishing from the toolbar reads as a bug,
                whereas a dimmed one with a tooltip explains itself. */}
            <button
              disabled={!!rightBlocked}
              className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 ${
                rightBlocked
                  ? 'cursor-default text-white/15'
                  : 'text-white/50 hover:bg-white/10 hover:text-white/90'
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
                  ? 'cursor-default text-white/15'
                  : 'text-white/50 hover:bg-white/10 hover:text-white/90'
              }`}
              title={downBlocked ? splitLimitHint(downBlocked) : 'Split down'}
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
          <SettingsDialog settings={terminalSettings} onChange={updateSettings} />
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
                  engine={leaf.engine}
                  backspaceSendsCtrlH={leaf.backspaceSendsCtrlH}
                  logging={loggingByPane[leaf.id] ?? false}
                  active={leaf.id === tab.activePaneId}
                  paneId={leaf.id}
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
                    if (s.startsWith('failed')) toast.error(s.replace(/^failed: /, ''))
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
                    if (s === 'disconnected' && terminalSettings.closeOnDisconnect) {
                      setTimeout(() => closePaneNow(tab.id, leaf.id), 800)
                    }
                  }}
                  onSessionId={(id) => dispatchPaneRuntime({ type: 'sessionIdSet', paneId: leaf.id, sessionId: id })}
                  onActivity={(activity) =>
                    dispatchPaneRuntime({ type: 'activityChanged', paneId: leaf.id, activity })
                  }
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
                    const message = describeCommandResult(result, tab.title)
                    if (result.exitCode) toast.error(message)
                    else toast.success(message)
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
          default:
            return null
        }
      })()}
    </div>
  )
}

export default App
