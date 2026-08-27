import { useEffect, useMemo, useRef, useState } from 'react'
import { SCROLLBAR_GUTTER_PX, type TerminalEngine } from '../lib/terminalEngine'
import { buildFontSelection } from '../lib/fontStack'
import { GhosttyEngine } from '../lib/ghostty/GhosttyEngine'
import {
  Search,
  ChevronUp,
  ChevronDown,
  X,
  Loader2,
  AlertTriangle,
  CaseSensitive,
  Regex,
  RotateCw,
  Unplug,
  TextCursorInput,
  Upload,
  ExternalLink,
  Copy,
} from 'lucide-react'
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager'
import { openUrl } from '@tauri-apps/plugin-opener'
import { error as logError } from '@tauri-apps/plugin-log'
import { getCurrentWindow } from '@tauri-apps/api/window'
import * as conn from '../lib/connection'
import { isDisconnect, parseReconnecting, shouldAutoClosePane } from '../lib/connection'
import type { AuthPromptField, ConnectionSource, ConnEvent, Reconnecting } from '../lib/connection'
import * as sessionLog from '../lib/logging'
import { createPtyResizeSender } from '../lib/ptyResize'
import type { TerminalSettings } from '../lib/settings'
import { findTheme, backgroundWithOpacity, hexToRgb } from '../lib/theme'
import { HostKeyPrompt } from './HostKeyPrompt'
import { AuthPrompt } from './AuthPrompt'
import { useConfirm } from './confirmContext'
import { useDismissable } from '../hooks/useDismissable'
import { LineEditor, parseHexLine } from '../lib/lineEditor'
import * as deliveryStats from '../lib/deliveryStats'
import { createWriteScheduler } from '../lib/writeScheduler'
import { CommandTracker, IDLE } from '../lib/shellIntegration'
import {
  harvestRemoteHistory,
  historyKeyForSource,
  recordAccepted,
  recordCommand,
  suggestCommands,
} from '../lib/commandHistory'
import { PromptInputTracker, tooShortToInfer } from '../lib/promptInput'
import { AutocompleteController, type SuggestionView } from '../lib/autocomplete'
import { SuggestionPopover } from './SuggestionPopover'
import { InlineSuggestion } from './InlineSuggestion'
import type { CommandActivity, CommandResult } from '../lib/shellIntegration'
import { parseOsc9, parseOsc777, ProgressTracker } from '../lib/appProgress'
import { parseWindowTitle, parseCwd, parseCwdProperty, guessCwdFromTitle } from '../lib/remoteIdentity'
import type { AppProgress, RemoteNotification } from '../lib/appProgress'
import { applyOsc52 } from '../lib/osc52'
import { formatBytes } from '../lib/formatBytes'
import { verdictForDrop } from '../lib/dropUpload'
import { Channel } from '@tauri-apps/api/core'
import * as sftp from '../lib/sftp'
import { toast } from '../lib/toast'
import * as broadcast from '../lib/broadcast'

/**
 * Bytes to write before telling the backend it may send more.
 *
 * A sixteenth of the backend's 16 MB window (`DEFAULT_MAX_INFLIGHT_BYTES` in
 * coalesce.rs), so credit flows back steadily rather than in lumps that let the
 * window drain to empty before it is topped up, while still costing one IPC
 * round trip per four deliveries rather than one per delivery.
 *
 * Left at 1 MB when the window went from 4 MB to 16: a larger batch would mean
 * fewer, bigger credit grants, which is the shape that starved the frontend at
 * the smaller window in the first place.
 */
const ACK_THRESHOLD_BYTES = 1024 * 1024

/**
 * Push a dead-engine report into the Rust-side log, which in a release build
 * is the only place it can land: the webview console isn't inspectable on a
 * user's machine, so a `console.error` there is the same as saying nothing.
 * See the log-plugin registration in src-tauri/src/lib.rs.
 *
 * Best-effort by design. `npm run dev` serves this in a plain browser with no
 * Tauri backend to invoke, and a failed report about a failure should never
 * become an unhandled rejection on top of the failure itself.
 */
function reportEngineFailure(message: string) {
  void logError(`terminal engine failed to start: ${message}`).catch(() => {})
}

interface Props {
  source: ConnectionSource
  label: string
  settings: TerminalSettings
  /** Which byte Backspace sends for this pane: true = ^H, false/null = ^?.
   * Per-connection rather than a global preference, because one machine
   * routinely has both kinds of host open at once. */
  backspaceSendsCtrlH?: boolean | null
  /** `false` opts this pane's session out of auto-reconnect; null/absent
   * follows the global setting. Resolved from the session profile where the
   * profile is known — see `PaneLeaf.autoReconnect`. */
  autoReconnect?: boolean | null
  logging?: boolean
  /** Whether this is the focused pane within its (possibly split) tab. */
  active?: boolean
  /** This pane's id, so a targeted searchRequest can address exactly it. */
  paneId: string
  /** The broadcast group this pane belongs to — its tab. Panes register under
   * it so input typed anywhere in the tab can be fanned out to all of them. */
  broadcastGroupId: string
  /** Whether this pane's tab is currently in broadcast mode. When it is, what
   * is typed here goes to every connected pane in the tab rather than only
   * this one. */
  broadcasting?: boolean
  /** Set by App's toolbar search button. When it targets this pane's id with
   * a nonce not seen before, the search box opens (the box is per-Terminal
   * local state, so this is how an App-level control reaches into it). */
  searchRequest?: { nonce: number; paneId: string } | null
  onStatus?: (status: string) => void
  onSessionId?: (id: string | null) => void
  /** The fitted grid in cells, reported only when it actually changes — see
   * `reportDimensions`. Fires on the engine's first fit and on every resize
   * that crosses a cell boundary, which is the same set of moments the remote
   * PTY is told about. */
  onDimensions?: (cols: number, rows: number) => void
  /** Bytes of scrollback this pane's engine was built with, reported once at
   * mount. Comes from the engine rather than the settings object on purpose:
   * the core fixes its limit at construction, so a pane opened before the
   * setting changed is still on the old budget, and the status bar must
   * describe the pane it is pointing at rather than the preference. */
  onScrollbackBudget?: (budgetBytes: number) => void
  /** Whether a command is currently running, per the remote shell's own OSC
   * 133 reports — silent (permanently idle) against a shell with no
   * integration set up. See lib/shellIntegration.ts. */
  onActivity?: (activity: CommandActivity) => void
  /** What a program on the far end says it is doing, via OSC 9;4 — null when
   * it has cleared its progress or the session has gone.
   *
   * The signal for the case `onActivity` structurally cannot cover: a
   * full-screen program on a remote host, which the shell sees as one long
   * command and reports nothing about. See lib/appProgress.ts. */
  onProgress?: (progress: AppProgress | null) => void
  /** A program that had been reporting progress has stopped — it cleared its
   * own progress, or the shell got back to a prompt, which proves it can't
   * still be running.
   *
   * The full-screen counterpart to `onCommandComplete`, and the moment that
   * actually wants you back: a tool that has been working for ten minutes has
   * either finished or is waiting on you. Not raised when the *session* went
   * away — a dropped connection says nothing about what the program was doing.
   *
   * @param durationMs how long progress had been up. The caller applies its
   * own floor; a program that flashes progress for a second wants nothing. */
  onProgressComplete?: (durationMs: number) => void
  /** The far end asked for a desktop notification by name (OSC 9 / OSC 777),
   * rather than this app inferring one from a command's exit. */
  onRemoteNotify?: (notification: RemoteNotification) => void
  /** The far end set a window title (OSC 0/2), or cleared it (null). Advisory:
   * the pane's own label still names the tab. See lib/remoteIdentity.ts. */
  onRemoteTitle?: (title: string | null) => void
  /** The far end reported its working directory (OSC 7). */
  onRemoteCwd?: (cwd: string) => void
  /** A command finished, with its exit code and how long it took. */
  onCommandComplete?: (result: CommandResult) => void
  /** The far end rang the terminal bell (BEL, 0x07) — the oldest and most
   * portable "I want your attention" signal there is, and the only one that
   * works with no shell-side setup at all. */
  onBell?: () => void
  /** A failed connection (bad credential, unreachable host, etc.) otherwise
   * leaves this pane stuck showing a dead terminal with no way back to the
   * connect dialog short of closing the whole pane — this reopens it in
   * place instead. */
  onBackToConnect?: () => void
  /** Retry the same connection in place — surfaced on the failed/disconnected
   * overlays as a "Reconnect" action. */
  /** Reopen failed connections in place. */
  onReconnect?: () => void
}

interface PendingHostKey {
  requestId: string
  host: string
  port: number
  fingerprint: string
  status: 'unknown' | 'changed'
  storedFingerprint: string | null
}

interface PendingAuthPrompt {
  requestId: string
  name: string
  instructions: string
  fields: AuthPromptField[]
  host: string
  port: number
  isJump: boolean
}

/**
 * The one trailing newline a copy button leaves behind, removed.
 *
 * Nearly every documentation site's copy icon puts a terminating newline
 * on the clipboard, and that newline is a Return: sent as-is it submits
 * the command instead of leaving it at the prompt to be read first, and
 * where the shell's own bracketed paste holds it back instead, it parks
 * the cursor on a second line of a buffer the user never asked for. A
 * paste should end where its text ends.
 *
 * Exactly one terminator goes: a blank line the user deliberately copied
 * before the last one is text, and survives.
 */
function stripTrailingNewline(text: string): string {
  return text.replace(/(\r\n|\r|\n)$/, '')
}

function countLines(text: string): number {
  return text.split(/\r\n|\r|\n/).length
}


export function Terminal({
  source,
  label,
  settings,
  backspaceSendsCtrlH,
  autoReconnect,
  logging,
  active,
  paneId,
  broadcastGroupId,
  broadcasting,
  searchRequest,
  onStatus,
  onSessionId,
  onDimensions,
  onScrollbackBudget,
  onActivity,
  onProgress,
  onProgressComplete,
  onRemoteNotify,
  onRemoteTitle,
  onRemoteCwd,
  onCommandComplete,
  onBell,
  onBackToConnect,
  onReconnect,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  /** Whether the search box was open on the previous render, so closing it can
   * hand focus back without the mount-time run of that effect doing so. */
  const wasSearchOpen = useRef(false)
  const termRef = useRef<TerminalEngine | null>(null)
  const [hostKeyPrompt, setHostKeyPrompt] = useState<PendingHostKey | null>(null)
  const [authPrompt, setAuthPrompt] = useState<PendingAuthPrompt | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  /** Keyboard selection is on. Mirrors engine state so the pane can say so —
   *  a mode that takes the arrow keys with nothing on screen to explain why is
   *  indistinguishable from a wedged pane. */
  const [markMode, setMarkMode] = useState(false)
  /** Hint mode is on. Same reasoning as `markMode`: a mode that swallows
   *  typing has to say so, and has to say how to get back out. */
  const [hintMode, setHintMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // Result position for the "N/M" count, fed by the addon's onDidChangeResults
  // (set up in the connect effect). index is 0-based, -1 when there are none.
  const [searchResults, setSearchResults] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0,
  })

  // The search box is a dismissable surface like any other, so Escape reaches
  // it only when it is the topmost one. Previously it had its own Escape on
  // both the container and the input, which fired regardless of what else was
  // open — so closing search with a forwarding panel up closed that too.
  useDismissable(searchOpen, () => setSearchOpen(false))

  /**
   * The right-click menu offered when the pointer is on a link.
   *
   * Right-click otherwise pastes (when that setting is on), and that gesture
   * is untouched away from a link. On one, a menu is the discoverable path for
   * anyone who never learns Ctrl+click — the same reason VTE has it — and it
   * also puts the destination on screen before anything is opened.
   */
  const [linkMenu, setLinkMenu] = useState<{ x: number; y: number; url: string } | null>(null)
  useDismissable(linkMenu !== null, () => setLinkMenu(null))

  /**
   * The last directory the host actually *reported*, which is where a dropped
   * file goes. Fed by OSC 7, by OSC 133/633's `P;Cwd=` and by OSC 1337's
   * `CurrentDir=` — three roads for one fact, and hosts differ in which they
   * take. Reading only OSC 7 meant a session that plainly showed its
   * directory still had none as far as a drop was concerned.
   */
  /** What autocomplete is currently offering, or null. Held in React state
   * because the popover is DOM; the controller that owns the decision lives in
   * the connection effect and pushes here. */
  const [suggestion, setSuggestion] = useState<SuggestionView | null>(null)
  /** Reached by the pane's key handler, which is installed in the same effect
   * that builds the controller but has to keep working across its lifetime. */
  const autocompleteRef = useRef<AutocompleteController | null>(null)
  const remoteCwdRef = useRef<string | null>(null)
  /** A directory *guessed* out of the window title. Never a destination on its
   *  own — only the prefill for the prompt. */
  const titleCwdRef = useRef<string | null>(null)
  /** A file is being dragged over this pane. */
  const [dropTarget, setDropTarget] = useState(false)
  /**
   * A dropped file whose destination has to be agreed before it is sent —
   * either because there is nowhere to put it, or because where it would go is
   * a claim the host made. Guessing `~`, or scraping it off the prompt, puts
   * the file somewhere the user did not ask for and did not watch it go.
   */
  const [dropDest, setDropDest] = useState<{
    file: File
    path: string
    /** Where the prefill came from, which is the whole of what the prompt has
     *  to explain — see the copy below. */
    source: 'reported' | 'title' | 'unknown'
  } | null>(null)
  /** What was typed into that prompt last time, to prefill it the next. */
  const lastDestRef = useRef<string | null>(null)
  /**
   * The reported directory the user has already agreed to send to.
   *
   * OSC 7 (and the OSC 633/133/1337 spellings of it) is *reported* rather than
   * guessed, but reported by the same untrusted party that chose the window
   * title — a host emitting `OSC 7 ; file://h/var/www/html` redirects the next
   * drop to a web root while the user believes it went to their working
   * directory. So a reported path is confirmed once, and again whenever it
   * changes; a drop into the directory already agreed goes straight out, which
   * is what keeps dropping several files in a row from being a chore.
   */
  const confirmedDestRef = useRef<string | null>(null)
  /** The upload in flight, for the progress readout and its cancel button. */
  const [transfer, setTransfer] = useState<{
    id: string | null
    name: string
    sent: number
    total: number
  } | null>(null)

  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  const [searchRegex, setSearchRegex] = useState(false)
  // Reinitializes to true on every mount, which is what we want — Pane.tsx
  // remounts this component (via a `key` bump) on every reconnect.
  const [connecting, setConnecting] = useState(true)
  // Set once a connection attempt fails and never cleared by anything short
  // of a remount (a fresh connect/reconnect) — surfaces the "back to connect
  // dialog" affordance below instead of leaving a dead terminal with no way
  // out short of closing the whole pane.
  const [connectFailed, setConnectFailed] = useState<string | null>(null)
  // A clean remote-initiated disconnect while "close pane on disconnect" is
  // off — shows the Reconnect / connection-settings overlay instead of
  // leaving a dead terminal (or auto-closing, which App does when the setting
  // is on). Reset to false on every remount, i.e. every reconnect.
  const [disconnected, setDisconnected] = useState(false)
  // An auto-reconnect in flight. The pane deliberately does *not* remount for
  // one — that is the whole point, and what keeps the scrollback — so unlike
  // the two states above this one has to be cleared explicitly when the
  // connection comes back.
  const [reconnecting, setReconnecting] = useState<Reconnecting | null>(null)
  // Read from inside the connection effect's event handler, which closes over
  // the state from the render that set it up and would never see the update.
  const reconnectingRef = useRef<Reconnecting | null>(null)
  reconnectingRef.current = reconnecting
  // The rendering engine itself never came up, so this pane will stay blank no
  // matter what the connection does. Deliberately distinct from the connection
  // failures above rather than folded into them: the session underneath may be
  // perfectly healthy, and reconnecting — the one remedy those overlays offer —
  // fixes nothing here.
  const [engineFailed, setEngineFailed] = useState<string | null>(null)

  // Settings can change without reconnecting the session, so they're read
  // through a ref rather than added to the effect's dependency array.
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // Same live-ref treatment as `settings`: read inside the connection effect,
  // which must not re-run (and tear down the session) when this changes.
  const backspaceRef = useRef(backspaceSendsCtrlH)
  backspaceRef.current = backspaceSendsCtrlH

  // And again, for the same reason: the connection effect reads this when it
  // dials, and a change to it must not tear the session down to apply — it
  // describes what happens to the *next* drop, which the running supervisor
  // was already told about when it started.
  const autoReconnectRef = useRef(autoReconnect)
  autoReconnectRef.current = autoReconnect

  // Same reason again: the paste guard is raised from a DOM listener installed
  // by the connection effect, which must not re-run when the provider's
  // identity changes.
  const confirm = useConfirm()
  const confirmRef = useRef(confirm)
  confirmRef.current = confirm

  // Read by the `onData` handler installed inside the connection effect, which
  // must not re-run when the tab toggles broadcast or the pane changes tab.
  const broadcastingRef = useRef(broadcasting)
  broadcastingRef.current = broadcasting
  const broadcastGroupRef = useRef(broadcastGroupId)
  broadcastGroupRef.current = broadcastGroupId

  const loggingRef = useRef(logging)
  loggingRef.current = logging

  // Read by applyLogging (below) so logging can start/stop against the live
  // session from outside the connect effect's local `sessionId`.
  const sessionIdRef = useRef<string | null>(null)
  // Whether a log file is currently open for this session — the single source
  // of truth that keeps the connect-time start and the mid-session toggle
  // from double-starting or double-stopping. Fresh (false) on every mount,
  // i.e. every reconnect.
  const loggingActiveRef = useRef(false)
  // label feeds the log filename; read through a ref so a mid-session start
  // uses the current label without making it a dependency anywhere.
  const labelRef = useRef(label)
  labelRef.current = label

  // Starts or stops session logging to match `want`, idempotently. Shared by
  // the connect handler (for "logging already on at connect") and the effect
  // below (for toggling it during a live session). loggingActiveRef is set
  // optimistically before the async start so a near-simultaneous second call
  // can't open a second log file for the same session.
  function applyLogging(sessionId: string, want: boolean | undefined) {
    if (want && !loggingActiveRef.current) {
      loggingActiveRef.current = true
      sessionLog.start(sessionId, labelRef.current, settingsRef.current.logPlainText).catch(() => {
        loggingActiveRef.current = false
      })
    } else if (!want && loggingActiveRef.current) {
      loggingActiveRef.current = false
      sessionLog.stop(sessionId).catch(() => {})
    }
  }

  // Toggling the logging setting now takes effect on the live session instead
  // of only at the next connect. No-op until the session id is known; the
  // connect handler applies the initial state once it is.
  useEffect(() => {
    const id = sessionIdRef.current
    if (id) applyLogging(id, logging)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logging])

  // Pane.tsx passes these as fresh inline closures on every render, so
  // including them in the connect effect's dependency array below would
  // tear down and reconnect the session on every status update it reports
  // (status update -> parent re-render -> new closure -> effect re-fires ->
  // more status updates -> ...), which is exactly the reconnect storm that
  // produced repeated "connection reset by peer" toasts stacked behind a
  // host-key prompt that never got a chance to be answered.
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  const onSessionIdRef = useRef(onSessionId)
  onSessionIdRef.current = onSessionId

  const onDimensionsRef = useRef(onDimensions)
  onDimensionsRef.current = onDimensions

  const onScrollbackBudgetRef = useRef(onScrollbackBudget)
  onScrollbackBudgetRef.current = onScrollbackBudget

  /** Last grid reported upward, so an unchanged one costs nothing.
   *
   * The ResizeObserver fires per pointer-move during a window drag, but the
   * cell grid only changes when a drag crosses a whole cell — a small
   * fraction of those. App's reducer treats a repeat as a no-op regardless;
   * this stops it being dispatched at all, which matters because nothing
   * downstream of App is memo-effective today (see the note at App.tsx's
   * paneRuntime). */
  const lastDimsRef = useRef<{ cols: number; rows: number } | null>(null)

  const reportDimensions = (term: TerminalEngine) => {
    const { cols, rows } = term
    // A hidden tab fits to 0x0; the callers all guard against that, but a
    // zero grid is never worth reporting even if one day one doesn't.
    if (cols <= 0 || rows <= 0) return
    const last = lastDimsRef.current
    if (last && last.cols === cols && last.rows === rows) return
    lastDimsRef.current = { cols, rows }
    onDimensionsRef.current?.(cols, rows)
  }

  // Same live-ref treatment as onStatus/onSessionId above — App passes these
  // as fresh inline closures every render, and the connect effect must not
  // list anything that changes per-render in its dependencies.
  const onActivityRef = useRef(onActivity)
  onActivityRef.current = onActivity

  const onCommandCompleteRef = useRef(onCommandComplete)
  onCommandCompleteRef.current = onCommandComplete

  const onProgressRef = useRef(onProgress)
  onProgressRef.current = onProgress

  const onProgressCompleteRef = useRef(onProgressComplete)
  onProgressCompleteRef.current = onProgressComplete

  const onRemoteNotifyRef = useRef(onRemoteNotify)
  onRemoteNotifyRef.current = onRemoteNotify

  const onRemoteTitleRef = useRef(onRemoteTitle)
  onRemoteTitleRef.current = onRemoteTitle

  const onRemoteCwdRef = useRef(onRemoteCwd)
  onRemoteCwdRef.current = onRemoteCwd

  const onBellRef = useRef(onBell)
  onBellRef.current = onBell

  // Registers this pane as a broadcast target for its tab.
  //
  // Its own effect rather than part of the connect effect because the two have
  // different lifetimes: dragging a pane to another tab changes the group and
  // must re-register, but must emphatically *not* re-run the connect effect,
  // which would tear the session down to move it. The writer reads `source`
  // and the session id through refs, so it stays correct across a reconnect
  // without this effect having to re-run for that either.
  //
  // Registration is unconditional — a pane joins its group whether or not
  // broadcast is on — because the mode is a property of the tab, decided at
  // send time by whoever is typing, not of the panes receiving.
  const sourceRef = useRef(source)
  sourceRef.current = source
  useEffect(() => {
    return broadcast.join(paneId, broadcastGroupId, (data) => {
      const id = sessionIdRef.current
      // A pane still connecting, or one whose session has gone, is silently
      // skipped: a broadcast is a convenience, and failing the whole send
      // because one pane of eight isn't up yet would be worse than the
      // partial delivery the user can see on screen.
      if (id) conn.write(sourceRef.current, id, data).catch(() => {})
    })
  }, [paneId, broadcastGroupId])

  const activeRef = useRef(active)
  activeRef.current = active

  // Open the search box when App's toolbar button issues a request addressed
  // to this pane. The nonce guards against re-firing on unrelated re-renders
  // and lets a repeat click on the same pane reopen/refocus.
  const searchReqSeen = useRef(0)
  useEffect(() => {
    if (!searchRequest || searchRequest.paneId !== paneId) return
    if (searchRequest.nonce === searchReqSeen.current) return
    searchReqSeen.current = searchRequest.nonce
    setSearchOpen(true)
    // Refocus the input if the box was already open (setSearchOpen is a no-op
    // then, so the searchOpen effect below won't fire to do it).
    searchInputRef.current?.focus()
  }, [searchRequest, paneId])

  // Set inside the connect effect below; lets the theme-update effect above
  // reach into that closure's scrollbar-coloring function without being
  // part of the same effect (which would tear down and reconnect the
  // session on every theme change).
  const updateScrollbarColorsRef = useRef<(() => void) | null>(null)

  // Same idea again, for showing/hiding the custom scrollbar based on
  // whether this pane is the focused one (see the connect effect below).
  const updateScrollbarFocusRef = useRef<((active: boolean) => void) | null>(null)

  // And again, so the font effect below can re-fit this one pane. Dispatching
  // a window resize event would also work, but every mounted pane runs that
  // effect, so N panes would each trigger a re-fit of all N.
  const refitRef = useRef<(() => void) | null>(null)

  // Theme updates apply live to the existing terminal instance instead of
  // tearing down and reconnecting the session.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.setTheme(settings.themeName, settings.backgroundOpacity)
    }
    updateScrollbarColorsRef.current?.()
  }, [settings.themeName, settings.backgroundOpacity])

  // Font and scrollback likewise apply to the live terminal rather than
  // recreating it, which would drop the connection and the scrollback along
  // with it. Changing the font changes the cell size and so the row/column
  // count, so this has to re-fit and tell the remote PTY the new size —
  // otherwise the shell keeps line-wrapping to the old width.
  /**
   * The faces to rasterize with, rebuilt only when a font setting moves.
   * Memoized because it is an effect dependency and because building it
   * registers `@font-face`s for the OpenType features -- a fresh object every
   * render would re-run the font effect, and the font effect rebuilds the
   * renderer and re-fits the grid.
   */
  const {
    fontFamily,
    fontFamilyBold,
    fontFamilyItalic,
    fontFamilyBoldItalic,
    fontFeatures,
    fontVariations,
    fontRanges,
    fontWeight,
    fontWeightBold,
    lineHeightPercent,
    letterSpacing,
  } = settings
  const fontSelection = useMemo(
    () =>
      buildFontSelection({
        fontFamily,
        fontFamilyBold,
        fontFamilyItalic,
        fontFamilyBoldItalic,
        fontFeatures,
        fontVariations,
        fontRanges,
        fontWeight,
        fontWeightBold,
        lineHeightPercent,
        letterSpacing,
      }),
    [
      fontFamily,
      fontFamilyBold,
      fontFamilyItalic,
      fontFamilyBoldItalic,
      fontFeatures,
      fontVariations,
      fontRanges,
      fontWeight,
      fontWeightBold,
      lineHeightPercent,
      letterSpacing,
    ],
  )

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.setFont(fontSelection, settings.fontSize)
    term.setScrollbackBudget(settings.scrollbackBudgetMB)
    term.setCursorStyle(settings.cursorStyle, settings.cursorBlink)
    term.setTextBlending?.(settings.textBlending)
    term.setLigatures?.(settings.ligatures)
    refitRef.current?.()
  }, [
    fontSelection,
    settings.fontSize,
    settings.scrollbackBudgetMB,
    settings.cursorStyle,
    settings.cursorBlink,
    settings.textBlending,
    settings.ligatures,
  ])

  // Its own effect because it is a per-session setting rather than one of the
  // global ones above, and it changes when the session's profile does.
  useEffect(() => {
    termRef.current?.setBackspaceSendsCtrlH?.(backspaceSendsCtrlH)
  }, [backspaceSendsCtrlH])

  // Only the focused pane's scrollbar is shown — a background pane's
  // scrollbar would otherwise be a distracting, non-interactive-feeling
  // artifact sitting on content you're not looking at.
  useEffect(() => {
    updateScrollbarFocusRef.current?.(!!active)
  }, [active])

  // Runs a search through the addon with the current toggle state, always
  // supplying decorations so every match stays highlighted (not just the one
  // scrolled to). `next`/`incremental` mirror the addon's own findNext/
  // findPrevious semantics. An empty query (or one that doesn't compile as a
  // regex) clears highlights and the count rather than throwing.
  function runSearch(
    query: string,
    opts: { back?: boolean; incremental?: boolean; caseSensitive?: boolean; regex?: boolean } = {},
  ) {
    const term = termRef.current
    if (!term) return
    if (!query) {
      term.clearSearchDecorations()
      setSearchResults({ index: -1, count: 0 })
      return
    }
    try {
      term.search(query, {
        caseSensitive: opts.caseSensitive ?? searchCaseSensitive,
        regex: opts.regex ?? searchRegex,
        incremental: opts.incremental,
        back: opts.back,
      })
    } catch {
      setSearchResults({ index: -1, count: 0 })
    }
  }

  /**
   * How much of a dropped file goes over IPC at a time.
   *
   * The bytes have to travel through the webview at all because Tauri's native
   * drag-drop is off on purpose — enabling it breaks the HTML5 drag events
   * tab-to-pane dragging is built on (see `dragDropEnabled` in
   * tauri.conf.json). 256 KB is large enough that the per-call overhead
   * disappears and small enough that the backend's four-deep queue is a
   * fraction of a megabyte rather than a buffer worth worrying about.
   */
  const UPLOAD_CHUNK_BYTES = 256 * 1024

  /** One place for the three sequences that can report a directory, so a pane
   *  and the status bar can never disagree about which one arrived last. */
  function noteRemoteCwd(cwd: string) {
    onRemoteCwdRef.current?.(cwd)
    // Kept locally as well as reported upwards: a file dropped on this pane
    // goes to the directory this pane is sitting in, and the drop handler is
    // local. Routing it up to App state and back down as a prop would make the
    // destination a render behind.
    remoteCwdRef.current = cwd
  }

  /** Only SSH has a file transfer channel at all. Asked of the shared mapping
   *  rather than by matching protocols here, so a new source variant cannot
   *  quietly become "not SSH" in one place and SSH in another. */
  const canUpload = conn.transportOf(source) === 'ssh'

  /** The prompt's own Send: remembers the directory as agreed — so a second
   *  drop into the same reported one goes straight out — and then uploads. */
  function sendDropDest(dest: { file: File; path: string }) {
    const path = dest.path.trim()
    lastDestRef.current = path
    confirmedDestRef.current = path
    setDropDest(null)
    void uploadFile(dest.file, path)
  }

  /**
   * Sends one file to `remoteDir` on this pane's host, keeping its name.
   *
   * Reads the file in slices and hands each to the backend, which streams them
   * straight into the SFTP write — so the file is never held whole on either
   * side, and the progress shown is bytes the server has actually taken rather
   * than bytes the webview has read.
   */
  async function uploadFile(file: File, remoteDir: string) {
    const sessionId = sessionIdRef.current
    if (!sessionId) {
      toast.error('Not connected — nothing to upload to.')
      return
    }
    const dir = remoteDir.replace(/\/+$/, '')
    const remotePath = `${dir}/${file.name}`

    let overwrite = false
    try {
      if (await sftp.exists(sessionId, remotePath)) {
        const replace = await confirmRef.current({
          title: `Replace ${file.name}?`,
          body: `${remotePath} already exists on ${labelRef.current}. The existing file is left alone unless the whole upload succeeds.`,
          confirmLabel: 'Replace',
        })
        if (!replace) return
        overwrite = true
      }
    } catch (err) {
      toast.error(`Could not check ${remotePath}: ${String(err)}`)
      return
    }

    setTransfer({ id: null, name: file.name, sent: 0, total: file.size })
    const channel = new Channel<sftp.SftpEvent>()
    channel.onmessage = (event) => {
      switch (event.type) {
        case 'transferProgress':
          setTransfer((t) => (t ? { ...t, sent: event.transferred } : t))
          break
        case 'transferDone':
          setTransfer(null)
          toast.success(`Uploaded ${file.name} to ${dir}`)
          break
        case 'transferCancelled':
          setTransfer(null)
          toast.info(`Upload of ${file.name} cancelled`)
          break
        case 'transferFailed':
          setTransfer(null)
          toast.error(`Upload failed: ${event.error}`)
          break
      }
    }

    let transferId: string
    try {
      transferId = await sftp.uploadBegin(sessionId, dir, file.name, overwrite, channel)
    } catch (err) {
      setTransfer(null)
      toast.error(`Upload failed: ${String(err)}`)
      return
    }
    setTransfer((t) => (t ? { ...t, id: transferId } : t))

    try {
      for (let at = 0; at < file.size; at += UPLOAD_CHUNK_BYTES) {
        const slice = await file.slice(at, at + UPLOAD_CHUNK_BYTES).arrayBuffer()
        await sftp.uploadChunk(transferId, new Uint8Array(slice))
      }
      await sftp.uploadFinish(transferId)
    } catch {
      // A chunk is refused when the transfer is already over — cancelled from
      // the button, or failed on the far side. Both have reported themselves
      // through the channel already, so this only has to stop pushing and
      // make sure nothing is left half-written.
      await sftp.cancelTransfer(transferId).catch(() => {})
    }
  }

  /** The file to send, or null having said out loud why not. The rules
   *  themselves are in `verdictForDrop`. */
  function fileFromDrop(e: React.DragEvent): File | null {
    // `webkitGetAsEntry` has to be called while the handler runs — the item
    // list is emptied as soon as it returns — and it is the only reliable way
    // to tell a folder from a file, since a dropped folder arrives as a `File`
    // with an empty type and a plausible-looking size.
    const folder = Array.from(e.dataTransfer.items).some(
      (item) => item.webkitGetAsEntry?.()?.isDirectory,
    )
    const files = Array.from(e.dataTransfer.files)
    const verdict = verdictForDrop({
      transport: conn.transportOf(source),
      connected: sessionIdRef.current !== null,
      busy: transfer !== null,
      folder,
      fileCount: files.length,
    })
    if (!verdict.ok) {
      toast.error(verdict.reason)
      return null
    }
    return files[0]
  }

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
      // Restore highlights for a query still in the box from last time it
      // was open, rather than making the user retype to see them again.
      if (searchQuery) runSearch(searchQuery, { incremental: true })
    } else {
      // Leaving search shouldn't leave the whole scrollback stippled with
      // highlights behind you.
      termRef.current?.clearSearchDecorations()
      setSearchResults({ index: -1, count: 0 })
      // Closing the box unmounts the input that had focus, which drops focus
      // to <body> — so every route out of search left the pane looking active
      // while swallowing every keystroke until you clicked it. Handled here
      // rather than at each call site so Escape, Ctrl+Shift+F, the close
      // button and the toolbar toggle all get it.
      //
      // Guarded on having actually been open: this effect also runs once on
      // mount with `searchOpen` already false, and focusing then would steal
      // focus from whichever pane really has it in a split.
      if (wasSearchOpen.current) termRef.current?.focus()
    }
    wasSearchOpen.current = searchOpen
    // Only meant to fire when the box opens/closes — searchQuery is read as a
    // one-shot restore, not a trigger (keystrokes drive search via onChange).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen])

  // Re-run the current query when a toggle flips so the highlights/count
  // reflect the new mode immediately, without waiting for the next keystroke.
  useEffect(() => {
    if (searchOpen && searchQuery) runSearch(searchQuery, { incremental: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchCaseSensitive, searchRegex])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    let sessionId: string | null = null

    termRef.current = new GhosttyEngine()
    const term = termRef.current

    // The theme/font effects above are declared before this one, so on a first
    // mount they run while termRef is still null and their settings never reach
    // the engine — it was left on its own built-in defaults (grey on black)
    // rather than the configured theme. Applying them here is also what gets
    // the palette into the Ghostty core, which resolves every cell's color
    // against it at construction.
    //
    // Every setting the engine takes has to be repeated here, not just added to
    // the effect above: the effect only ever fires for *changes*, so anything
    // missing from this list is silently absent on a new pane and correct on
    // every existing one. That is exactly how the cursor preference shipped
    // wrong — new panes came up as the engine's own default block instead of
    // the configured shape.
    term.setTheme(settingsRef.current.themeName, settingsRef.current.backgroundOpacity)
    term.setFont(buildFontSelection(settingsRef.current), settingsRef.current.fontSize)
    term.setScrollbackBudget(settingsRef.current.scrollbackBudgetMB)
    term.setCursorStyle(settingsRef.current.cursorStyle, settingsRef.current.cursorBlink)
    term.setTextBlending?.(settingsRef.current.textBlending)
    term.setLigatures?.(settingsRef.current.ligatures)
    // Not part of `settings` — it is per-session, not global — but it obeys
    // the same rule as everything above: repeated here so a new pane gets it,
    // because the effect that tracks it only fires on changes.
    term.setBackspaceSendsCtrlH?.(backspaceRef.current)
    // Read back rather than echoing the setting: the engine resolves an
    // unknown tier to its own fallback, and this has to describe what the pane
    // got. Reported after the setter above and only here — the core fixes the
    // budget when it builds, so it cannot change for the life of this engine.
    onScrollbackBudgetRef.current?.(term.scrollbackBudgetBytes)

    const searchResultsListener = term.onSearchResult((result) => {
      if (disposed) return
      setSearchResults({ index: result.index, count: result.count })
    })

    // Engines that can fail to start say so here (see TerminalEngine.
    // onInitError); ones that can't don't implement it.
    const initErrorListener = term.onInitError?.((message) => {
      reportEngineFailure(message)
      if (disposed) return
      setEngineFailed(message)
    })

    term.mount(container)
    term.fit()
    reportDimensions(term)

    // Custom scrollbar overlay. It originated as a replacement for
    // xterm.js's own scrollbar widget, which explicitly doesn't support
    // arrow buttons (its bundled source throws if `verticalHasArrows` is
    // ever set) — the engine has changed since, but a scrollbar styled to
    // match native Windows console scrollbars is still what's wanted. See
    // the .term-scrollbar-* rules in index.css, which also hide any
    // engine-drawn scrollbar so the two don't overlap.
    // z-index (not just position) is what actually matters here: without an
    // explicit value, this element doesn't establish its own CSS stacking
    // context, so the scrollbar's z-index below "escapes" it and competes
    // for paint order against its own siblings — the connecting/
    // connectFailed/searchOpen overlay divs in the JSX below, none of which
    // set an explicit z-index either — painting over them and silently
    // eating clicks meant for whatever's underneath instead of respecting
    // DOM order like a plain position:relative box would.
    container.style.position = 'relative'
    container.style.zIndex = '0'
    const scrollbarEl = document.createElement('div')
    scrollbarEl.className = 'term-scrollbar'
    // Fixed-width inner box for the actual visible/interactive controls,
    // anchored to the right edge of the (dynamically wider) outer masking
    // box — see the .term-scrollbar-inner comment in index.css.
    const innerEl = document.createElement('div')
    innerEl.className = 'term-scrollbar-inner'
    const upBtn = document.createElement('div')
    upBtn.className = 'term-scrollbar-btn up'
    const track = document.createElement('div')
    track.className = 'term-scrollbar-track'
    const thumb = document.createElement('div')
    thumb.className = 'term-scrollbar-thumb'
    track.appendChild(thumb)
    const downBtn = document.createElement('div')
    downBtn.className = 'term-scrollbar-btn down'
    innerEl.append(upBtn, track, downBtn)
    scrollbarEl.append(innerEl)
    container.appendChild(scrollbarEl)

    // The CSS width above is only a fallback — FitAddon reserves gutter
    // space for "wherever a scrollbar will go", but the terminal's actual
    // rendered canvas (cols * cellWidth) essentially never lands exactly on
    // that boundary, since an integer column count almost always leaves a
    // few leftover pixels of a partial column. Measuring the canvas's real
    // right edge and sizing this overlay to close that exact gap covers it
    // precisely regardless of font size or how wide that leftover sliver
    // happens to be, rather than assuming a fixed width matches.
    //
    // This has to be recomputed every time the grid resizes, not just when the
    // OS window does. The box is opaque and sits above the canvas, so a width
    // measured while the canvas is still at its 80x24 fallback masks the right
    // half of the pane — and because it paints the theme background, the result
    // reads as text truncated on a clean column boundary rather than as an
    // overlay. That is the whole of the "terminal doesn't fill the container
    // until you resize the window" bug: resizing was simply the only thing that
    // called this again.
    const canvasObserver = new ResizeObserver(() => updateScrollbarGeometry())
    const updateScrollbarGeometry = () => {
      let canvasRight = 0
      for (const canvas of container.querySelectorAll('canvas')) {
        const rect = canvas.getBoundingClientRect()
        if (rect.width > 0) canvasRight = Math.max(canvasRight, rect.right)
      }
      // Watching the canvases themselves is what makes this self-correcting:
      // the container doesn't change size when the grid refits from the 80x24
      // fallback to its real width, so the observer on the container never
      // fires and the mask keeps its stale width. Re-observing here (observe()
      // is idempotent per element) also picks up a canvas that was swapped out
      // from under us by a renderer rebuild.
      for (const canvas of container.querySelectorAll('canvas')) {
        canvasObserver.observe(canvas)
      }
      if (canvasRight === 0) return
      const gap = container.getBoundingClientRect().right - canvasRight
      // Clamped because the failure modes are wildly asymmetric: too narrow
      // leaves a sliver of gutter in the wrong shade, too wide hides the
      // terminal. The area legitimately needing masking is one partial column
      // plus the gutter, so anything beyond that is a stale measurement.
      const width = Math.min(Math.max(gap, SCROLLBAR_GUTTER_PX), SCROLLBAR_GUTTER_PX * 8)
      scrollbarEl.style.width = `${width}px`
    }

    // Foreground for the thumb/arrows (matching xterm's own default
    // scrollbarSliderBackground behavior) so they stay legible against any
    // preset theme; background for the widget's own base fill, covering
    // FitAddon's reserved gutter (see the .term-scrollbar width comment in
    // index.css) with the pane's actual background rather than leaving it
    // transparent — WebView2 doesn't reliably render that reserved-but-
    // unused canvas strip as the real background color, so painting over
    // it here is what actually makes it match instead of just hoping the
    // canvas underneath already does.
    function updateScrollbarColors() {
      const theme = findTheme(settingsRef.current.themeName)
      const [fr, fg, fb] = hexToRgb(theme.foreground)
      const [br, bg, bb] = hexToRgb(theme.background)
      scrollbarEl.style.setProperty('--term-scrollbar-fg', `${fr}, ${fg}, ${fb}`)
      scrollbarEl.style.setProperty('--term-scrollbar-bg', `${br}, ${bg}, ${bb}`)
    }
    updateScrollbarColors()
    updateScrollbarColorsRef.current = updateScrollbarColors

    // The interactive controls (thumb + arrows) are shown only when there's
    // actual scrollback to reach (updateThumb) *and* this is the focused
    // pane (updateScrollbarFocusRef) — a background pane's scrollbar would
    // otherwise sit there as a non-interactive-feeling distraction on
    // content you're not looking at. `.term-scrollbar` itself (the
    // background mask covering FitAddon's reserved gutter — see index.css)
    // stays visible unconditionally: it's not optional decoration, it's
    // what keeps that gutter matching the pane's background at all, needed
    // even when nothing is scrollable or focused.
    // `visibility` rather than `display`: reading layout (track.clientHeight,
    // below) from a `display: none` subtree always returns 0, which would
    // corrupt the thumb's position/size if updateThumb() ever runs while
    // hidden (e.g. this pane's container resizing when a sibling pane is
    // split off it, while this one isn't the newly-focused pane) — and
    // nothing would recompute it again until the next scroll/write, leaving
    // the wrong position baked in even after this pane regains focus.
    // `visibility: hidden` keeps real layout geometry available throughout,
    // and is equally non-interactive/invisible.
    let hasOverflow = false
    let isFocused = activeRef.current ?? false
    function applyScrollbarVisibility() {
      const visibility = hasOverflow && isFocused ? 'visible' : 'hidden'
      upBtn.style.visibility = visibility
      downBtn.style.visibility = visibility
      thumb.style.visibility = visibility
    }

    function updateThumb() {
      const total = term.scrollbackLength
      const rows = term.rows
      hasOverflow = total > rows
      applyScrollbarVisibility()
      if (!hasOverflow) return
      const trackHeight = track.clientHeight
      const thumbHeight = Math.max(20, (rows / total) * trackHeight)
      const maxScroll = total - rows
      const maxThumbTop = trackHeight - thumbHeight
      const thumbTop = maxScroll > 0 ? (term.viewportY / maxScroll) * maxThumbTop : 0
      thumb.style.height = `${thumbHeight}px`
      thumb.style.top = `${thumbTop}px`
    }
    updateScrollbarGeometry()
    updateThumb()

    updateScrollbarFocusRef.current = (nextActive) => {
      isFocused = nextActive
      applyScrollbarVisibility()
    }

    // Hold-to-repeat for the arrow buttons, matching native scroll-arrow feel.
    function startRepeat(action: () => void) {
      action()
      let timeoutId: number
      const step = () => {
        action()
        timeoutId = window.setTimeout(step, 60)
      }
      timeoutId = window.setTimeout(step, 350)
      const stop = () => {
        clearTimeout(timeoutId)
        window.removeEventListener('mouseup', stop)
      }
      window.addEventListener('mouseup', stop)
    }
    // preventDefault on mousedown (rather than an explicit refocus after)
    // is what stops the browser from shifting focus off the terminal when
    // clicking these — the standard scrollbar-widget trick.
    const onUpMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      startRepeat(() => term.scrollLines(-1))
    }
    const onDownMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      startRepeat(() => term.scrollLines(1))
    }
    upBtn.addEventListener('mousedown', onUpMouseDown)
    downBtn.addEventListener('mousedown', onDownMouseDown)

    // Page up/down when clicking the track itself, above/below the thumb —
    // dragging the thumb is handled separately below.
    const onTrackMouseDown = (e: MouseEvent) => {
      if (e.target !== track) return
      e.preventDefault()
      if (e.clientY - track.getBoundingClientRect().top < thumb.offsetTop) {
        term.scrollLines(-term.rows)
      } else {
        term.scrollLines(term.rows)
      }
    }
    track.addEventListener('mousedown', onTrackMouseDown)

    let dragMoveHandler: ((e: MouseEvent) => void) | null = null
    let dragUpHandler: (() => void) | null = null
    const onThumbMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const startY = e.clientY
      const startTop = thumb.offsetTop
      const trackHeight = track.clientHeight
      const thumbHeight = thumb.clientHeight
      const maxThumbTop = trackHeight - thumbHeight
      const maxScroll = term.scrollbackLength - term.rows
      dragMoveHandler = (moveEv: MouseEvent) => {
        const newTop = Math.min(Math.max(0, startTop + (moveEv.clientY - startY)), maxThumbTop)
        const ratio = maxThumbTop > 0 ? newTop / maxThumbTop : 0
        term.scrollToLine(Math.round(ratio * maxScroll))
      }
      dragUpHandler = () => {
        if (dragMoveHandler) window.removeEventListener('mousemove', dragMoveHandler)
        if (dragUpHandler) window.removeEventListener('mouseup', dragUpHandler)
        dragMoveHandler = null
        dragUpHandler = null
      }
      window.addEventListener('mousemove', dragMoveHandler)
      window.addEventListener('mouseup', dragUpHandler)
    }
    thumb.addEventListener('mousedown', onThumbMouseDown)

    const scrollListener = term.onScroll(() => {
      updateThumb()
      // A list drawn against a line that has just moved is worse than no list:
      // it would sit over unrelated text and complete a prompt that is no
      // longer on screen. Clearing also forgets the last query, so the next
      // parsed write re-offers if the prompt is still there.
      autocomplete.clear()
    })
    const writeParsedListener = term.onWriteParsed(() => {
      updateThumb()
      // Where a pending `B` origin is finally measured — the OSC scanner runs
      // ahead of the parser, so at marker time the prompt is not on the grid
      // yet. Also the moment the offered list is re-checked against what the
      // line now says, which is how a suggestion goes away when the far end
      // redraws underneath it.
      promptInput.noteParsed()
      autocomplete.refresh()
      harvestOnce()
    })

    // Shell integration. Nothing here fires unless the far end is actually
    // emitting OSC 133/633 — an un-integrated shell (or a switch console,
    // which will never have one) simply leaves the tracker idle forever, so
    // there's no setting gating the tracking itself, only the notifications
    // it can produce. Both identifiers get the same handler: OSC 633 is
    // VS Code's superset of the same letters, and a shell configured for
    // one commonly emits the other alongside it.
    // Whether this host has ever named a command it ran, via OSC 633 `E`.
    // Once it has, passive capture from the screen has nothing left to add —
    // see `captureTypedLine`.
    let reportsCommandText = false
    const tracker = new CommandTracker({
      onChange: (activity) => {
        if (!disposed) onActivityRef.current?.(activity)
      },
      onComplete: (result) => {
        if (disposed) return
        onCommandCompleteRef.current?.(result)
        // The shell named what it ran, so it will keep doing so, and there is
        // no longer any reason to reconstruct command lines from the screen.
        // See `captureTypedLine`.
        if (result.command) reportsCommandText = true
        // Tier 2 capture. The command line arrives here already verbatim —
        // the shell said what it ran, via OSC 633 `E` — so there is nothing to
        // reconstruct and nothing that can be mistaken for a password: a
        // shell that reports its command lines does not report the reply to
        // `read -s`.
        //
        // Recorded on completion rather than on start, because that is where
        // the tracker hands the text over, and because a line that never
        // reached `D` is one the session dropped under — a half-run command
        // nobody wants offered back. Its exit code is deliberately ignored:
        // a command that failed is still one you may want to recall and fix,
        // and under a partial integration the code is often null anyway.
        if (!settingsRef.current.autocompleteEnabled || !result.command) return
        void recordCommand({
          host: historyKeyForSource(source),
          command: result.command,
          cwd: remoteCwdRef.current,
          source: 'integration',
        }).catch(() => {
          // Best-effort, and deliberately silent. Autocomplete failing to
          // remember a command is not something to interrupt a terminal
          // session over, and the store is offline entirely under `npm run
          // dev`, where there is no backend to invoke.
        })
      },
    })
    // What a program on the far end last reported through OSC 9;4, so a
    // repeat can be recognised and dropped before it reaches App. A busy app
    // re-sends the same indeterminate state for as long as it runs, and this
    // handler is on the output hot path.
    const progressTracker = new ProgressTracker({
      onChange: (progress) => {
        if (!disposed) onProgressRef.current?.(progress)
      },
      onComplete: (durationMs) => {
        if (!disposed) onProgressCompleteRef.current?.(durationMs)
      },
      // A full terminal reset takes any progress with it: the program that set
      // it has just had the screen pulled out from under it, which is what
      // `reset` at a shell, or a full-screen program starting up, does to a
      // half-finished report. The core handles the RIS itself — this is only
      // the indicator on the tab strip, which the core knows nothing about.
      //
      // The tracker holds this open only while a report is showing, because
      // watching is not free; see the note on `watchReset`.
      watchReset: (cb) => term.registerResetHandler(cb),
    })

    // What is being typed at the prompt right now, read off the grid rather
    // than modelled from keystrokes — see lib/promptInput.ts for why that is
    // the only version of this that works.
    const promptInput = new PromptInputTracker(term)
    const autocomplete = new AutocompleteController({
      tracker: promptInput,
      suggest: (typed, limit) =>
        suggestCommands({
          host: historyKeyForSource(source),
          typed,
          cwd: remoteCwdRef.current,
          limit,
        }),
      send: (text) => {
        const id = sessionIdRef.current
        if (id) conn.write(source, id, new TextEncoder().encode(text)).catch(() => {})
      },
      noteAccepted: (command) => {
        void recordAccepted(historyKeyForSource(source), command).catch(() => {})
      },
      enabled: () => settingsRef.current.autocompleteEnabled,
      onChange: (view) => {
        if (!disposed) setSuggestion(view)
      },
    })
    autocompleteRef.current = autocomplete

    /**
     * Tier 1: import this host's own shell history, once.
     *
     * Fired on the first output rather than from the connect path — which is
     * as close to "the first prompt" as this can get without shell
     * integration, and shell integration is exactly what a host that needs
     * this most does not have. Waiting also keeps it off the critical path of
     * a connection: nothing here should make a session take longer to become
     * usable.
     *
     * Once per session, whatever the outcome. A host that refuses — a
     * restricted shell, `ForceCommand`, an appliance whose `exec` is its own
     * CLI — must not be asked again every time output arrives, and a host that
     * answered has nothing more to say until its history file grows.
     */
    let harvestAttempted = false
    function harvestOnce() {
      if (harvestAttempted) return
      // SSH only: importing needs a second channel on the live connection, and
      // neither a telnet session nor a serial line has one.
      if (conn.transportOf(source) !== 'ssh') return
      const id = sessionIdRef.current
      if (!id) return
      // The outer gate, and the only one this side owns — the harvest's own
      // setting and the saved session's override of it are resolved backend
      // side, before any channel is opened. See `harvestRemoteHistory`.
      if (!settingsRef.current.autocompleteEnabled) return
      harvestAttempted = true
      void harvestRemoteHistory({
        sessionId: id,
        host: historyKeyForSource(source),
        importGlobally: settingsRef.current.autocompleteImportRemoteHistory,
        profileId: source.protocol === 'sshProfile' ? source.profileId : null,
      }).catch(() => {
        // A host that will not answer is an ordinary outcome, not something to
        // interrupt a session over.
      })
    }

    /**
     * Tier 3 capture: remember a command on a host that never said it ran one.
     *
     * Only for hosts with no shell integration — where there is one, its `E`
     * report is verbatim and this reconstruction could only be worse. The
     * two conditions below are what make it safe rather than merely
     * plausible:
     *
     *   - **Everything typed has to have shown up.** If less is visible than
     *     went out, something swallowed it, and the thing that swallows
     *     keystrokes is a password prompt. One unechoed character disqualifies
     *     the whole line.
     *   - **The text comes off the grid**, so what gets stored is what was on
     *     screen — never a keystroke buffer that might hold something the
     *     screen never showed.
     */
    function captureTypedLine() {
      if (!settingsRef.current.autocompleteEnabled) return
      // This host reports its own command lines, so reading one off the grid
      // would only add a worse copy of the same thing.
      //
      // Keyed on having actually seen a reported command rather than on the
      // prompt being marked, and the difference matters: a shell that brackets
      // its prompt without emitting OSC 633 `E` — the original OSC 133, which
      // has no field for the command text — would otherwise have a marked
      // prompt, no reported commands, and nothing recorded at all. Our own
      // snippets emit both, so for them this flips on the first command and
      // stays on.
      if (reportsCommandText) return
      const input = promptInput.read()
      if (!input || input.text.trim() === '') return
      // An unmarked prompt is a guessed one, and a guess cannot tell a shell
      // prompt from a program waiting for a keypress. The `n` that answers
      // apt's `[Y/n]` would otherwise be stored as a command. See
      // `tooShortToInfer`.
      if (!promptInput.exact && tooShortToInfer(input.text)) return
      if (input.text.length < promptInput.typedCount) return
      void recordCommand({
        host: historyKeyForSource(source),
        command: input.text,
        cwd: remoteCwdRef.current,
        source: 'screen',
      }).catch(() => {})
    }

    const oscListeners = [133, 633].map((ident) =>
      term.registerOscHandler(ident, (data) => {
        // A prompt being drawn, or a command reporting its exit, means the
        // program that set any progress is gone. Apps are supposed to clear
        // their own with `9;4;0` on the way out, and a great many do — but one
        // killed with SIGKILL, or cut off mid-run, never gets to, and the
        // indicator would otherwise spin for the rest of the pane's life. The
        // shell reaching a fresh prompt is the proof that it can't still be
        // running. Done here rather than inside CommandTracker: this is not
        // the shell's signal to own, only the moment that invalidates it.
        const kind = data.split(';')[0]
        if (kind === 'A' || kind === 'D') progressTracker.set(null)
        // `P;Cwd=` rides in on the same sequence. Read here rather than in
        // `CommandTracker` because it is not part of what the shell is
        // *doing* — it is the same fact OSC 7 carries, arriving by another
        // road, and plenty of hosts take only this one.
        const reported = parseCwdProperty(data)
        if (reported) noteRemoteCwd(reported)
        // Same markers, a second reader: `A`/`B` say where the prompt ends and
        // the typed line begins, and `C`/`D` say when there is no line to
        // complete because something is running.
        promptInput.handleOsc(data)
        return tracker.handleOsc(data)
      }),
    )
    // Progress and notifications the *application* emits, as opposed to the
    // shell markers above. This is the only signal that survives a full-screen
    // program over SSH: there is no local PTY to inspect, and the shell sees
    // the whole session as one command and says nothing until it ends. See
    // lib/appProgress.ts.
    oscListeners.push(
      term.registerOscHandler(9, (data) => {
        const result = parseOsc9(data)
        if (result.kind === 'progress') {
          progressTracker.set(result.progress)
          // A program reporting for itself supersedes the shell's account of
          // the same run — see CommandTracker.noteProgress. Told on the report
          // rather than from `progressTracker.onChange`, because a repeat of a
          // state already showing is dropped there as a no-op, and because a
          // clear counts: `9;4;0` is a program saying it is not working, which
          // is exactly as much of an answer as `9;4;3`. Claude Code opens with
          // one, and taking it means its pane is quiet from launch instead of
          // sweeping until the first turn.
          tracker.noteProgress()
        } else if (result.kind === 'notify') onRemoteNotifyRef.current?.(result.notification)
        // Claimed either way, including the ignored forms: nothing else here
        // handles OSC 9, and letting an unrecognised subcommand fall through
        // gains nothing.
        return true
      }),
      term.registerOscHandler(777, (data) => {
        const notification = parseOsc777(data)
        if (notification) onRemoteNotifyRef.current?.(notification)
        // Not claimed unconditionally: OSC 777 has subcommands beyond
        // `notify` that this doesn't implement, and swallowing them would
        // silently block a later handler that does.
        return notification !== null
      }),
    )
    // What the far end says it is and where it is. Like the progress
    // sequences above, these come from whatever is running rather than from
    // the shell's prompt markers, so they work with no integration set up and
    // keep reporting through a full-screen program. Neither renames the tab —
    // see lib/remoteIdentity.ts.
    oscListeners.push(
      // OSC 0 sets the icon name and the title together; OSC 2 the title
      // alone. Not claimed: OSC 0's icon-name half is a real part of the
      // sequence that this doesn't implement, and the engine keeps its own
      // notion of the title from the same bytes.
      ...[0, 2].map((ident) =>
        term.registerOscHandler(ident, (data) => {
          const title = parseWindowTitle(data)
          onRemoteTitleRef.current?.(title)
          // Not a reported directory — a guess at one, kept only to prefill
          // the prompt a drop puts up when nothing has reported anything. See
          // `guessCwdFromTitle`.
          titleCwdRef.current = guessCwdFromTitle(title)
          return false
        }),
      ),
      term.registerOscHandler(7, (data) => {
        const cwd = parseCwd(data)
        if (cwd) noteRemoteCwd(cwd)
        // Claimed only when it parsed. A payload that isn't a directory is
        // something else using the number, and swallowing it would silently
        // block a handler that understands it.
        return cwd !== null
      }),
      // iTerm2's `CurrentDir=`, which several shells emit alongside or instead
      // of OSC 7.
      term.registerOscHandler(1337, (data) => {
        const cwd = parseCwdProperty(data)
        if (cwd) noteRemoteCwd(cwd)
        // OSC 1337 carries a great deal this does not implement.
        return cwd !== null
      }),
    )
    // OSC 52 is the only copy path a program on the far end of a session has:
    // it cannot reach this machine's clipboard, and while it is grabbing the
    // mouse for its own UI the user cannot drag out a selection either. Reads
    // are parsed and dropped — answering one would hand whatever the user last
    // copied (a password, a token) to the remote end unasked.
    oscListeners.push(
      term.registerOscHandler(52, (data) =>
        applyOsc52(data, {
          allowWrite: settingsRef.current.clipboardWriteFromRemote,
          writeText,
          // The write is the point of the feature, but doing it silently is
          // what makes clipboard poisoning work: the user pastes into a
          // *local* shell believing the contents are their own. A toast costs
          // nothing when the write was wanted, and is the whole defence when
          // it wasn't.
          onWrote: () => toast.info('The remote host set your clipboard'),
          onError: logError,
        }),
      ),
    )
    // Entering the alternate screen mid-command means a full-screen program
    // took over (vim, top, less). Recorded on the run so the completion it
    // eventually reports can be recognized as "you quit an editor", not "a
    // batch job you were waiting on has landed".
    const bufferListener = term.onBufferChange((isAlternate) => {
      promptInput.setAltScreen(isAlternate)
      if (isAlternate) autocomplete.clear()
      tracker.setAltScreen(isAlternate)
    })
    const bellListener = term.onBell(() => {
      if (!disposed) onBellRef.current?.()
    })

    const onEvent = (event: ConnEvent) => {
      if (disposed) return
      setConnecting(false)
      switch (event.type) {
        case 'status': {
          onStatusRef.current?.(event.status)
          const retry = parseReconnecting(event.status)
          if (event.status.startsWith('failed') || isDisconnect(event.status)) {
            term.writeln(`\r\n[${event.status}]`)
            // Whatever was running went down with the connection. Its real
            // outcome is unknowable from here, so drop it silently rather
            // than leaving the tab spinning or claiming a completion. The
            // same goes for any progress an application had set: it had no
            // chance to clear it, and there is now no session it could
            // describe.
            tracker.reset()
            progressTracker.reset()
          }
          if (retry) {
            // Supersedes both terminal states: the run is still going, and the
            // "failed" the last attempt reported is a step in it rather than a
            // verdict. Giving up arrives as its own `failed`, which is what
            // finally sticks.
            setReconnecting(retry)
            setConnectFailed(null)
            setDisconnected(false)
          } else if (event.status.startsWith('failed')) {
            setReconnecting(null)
            setConnectFailed(event.status.replace(/^failed: /, ''))
          } else if (event.status === 'connected') {
            if (reconnectingRef.current) {
              // Be honest about what came back. SSH has no session resumption:
              // the remote process is gone, the working directory is back to
              // the login default, and anything unsaved in a full-screen
              // program is lost. The scrollback survives because it is ours,
              // not the server's — so say where the seam is rather than let
              // the old output imply continuity with the new.
              term.writeln('\r\n[reconnected — this is a new shell]')
            }
            setReconnecting(null)
          } else if (
            isDisconnect(event.status) &&
            !shouldAutoClosePane(event.status, settingsRef.current.closeOnDisconnect)
          ) {
            // Suppressed only when the pane is actually about to close, where
            // the overlay would flash for the ~800ms before it vanishes.
            // Keying that off the *setting* rather than off what the setting
            // will do left a `lost` pane with auto-close on showing nothing at
            // all — no overlay, and no close either, since only a clean
            // disconnect closes now.
            setReconnecting(null)
            setDisconnected(true)
          }
          break
        }
        case 'hostKeyPrompt':
          setHostKeyPrompt({
            requestId: event.requestId,
            host: event.host,
            port: event.port,
            fingerprint: event.fingerprint,
            status: event.status,
            storedFingerprint: event.storedFingerprint,
          })
          break
        case 'authPrompt':
          setAuthPrompt({
            requestId: event.requestId,
            name: event.name,
            instructions: event.instructions,
            fields: event.fields,
            host: event.host,
            port: event.port,
            isJump: event.isJump,
          })
          break
      }
    }

    // PTY output arrives on its own raw-bytes channel (see lib/connection.ts)
    // rather than as a base64 string on `onEvent` — no decode step needed.
    // Session logging happens Rust-side before these bytes are even sent,
    // so there's nothing to do here beyond rendering.
    // Metered against the frame rather than written the instant IPC hands the
    // bytes over. Writing inline froze the window for up to 106 ms during a
    // flood — not one slow parse, but ~30 deliveries of 3.5 ms each running
    // with no chance to render between them, because IPC had a queue behind it.
    // An idle terminal is unaffected: a keystroke echo is one small delivery
    // into a full budget and still goes in synchronously. See lib/writeScheduler.
    // Bytes written but not yet credited to the backend. Batched rather than
    // acked per delivery: the backend's window is 4 MB, so crediting every
    // 1 MB keeps it comfortably fed at a quarter of the IPC round trips.
    let unacked = 0
    const scheduler = createWriteScheduler(
      (bytes) => {
        // Wrapped rather than called directly so the real delivery path can be
        // measured in a live session — see lib/deliveryStats.ts. Off by default,
        // and when off this is a branch and a call, no clock reads.
        deliveryStats.record(bytes.length, () => term.write(bytes))
        unacked += bytes.length
        // Also sent the moment the queue drains, so a quiet session cannot
        // leave credit stranded below the batch size and slowly starve itself
        // over a long connection.
        if (unacked >= ACK_THRESHOLD_BYTES || scheduler.pending === 0) {
          const credit = unacked
          unacked = 0
          const id = sessionIdRef.current
          if (id) conn.ackDelivery(id, credit).catch(() => {})
        }
      },
      undefined,
      undefined,
      // Declared so the report can tell pacing from starvation; without it a
      // deliberate yield reads as the frontend failing to keep up.
      deliveryStats.recordPaced,
    )
    const onData = (bytes: Uint8Array) => {
      if (disposed) return
      setConnecting(false)
      scheduler.push(bytes)
    }

    // Readline/Readline-hex (serial only) buffer keystrokes locally and
    // only hand a completed line to the wire on Enter, instead of the
    // normal one-keystroke-at-a-time passthrough — see lib/lineEditor.ts.
    const inputMode = source.protocol === 'serial' ? source.config.inputMode : 'Normal'
    const lineEditor =
      inputMode === 'Readline' || inputMode === 'ReadlineHex'
        ? new LineEditor(term, (line) => {
            if (!sessionId) return
            if (inputMode === 'ReadlineHex') {
              const bytes = parseHexLine(line)
              if (!bytes) {
                term.writeln('[invalid hex — expected space-separated bytes like "AA 0x1B FF"]')
                return
              }
              conn.write(source, sessionId, bytes).catch(() => {})
            } else {
              // Appending a bare CR and letting the existing line-ending
              // translation (already applied to everything written to the
              // serial port) rewrite it means Readline mode's Enter key
              // behaves exactly like a normal typed Enter would.
              conn.write(source, sessionId, new TextEncoder().encode(`${line}\r`)).catch(() => {})
            }
          })
        : null

    // The container measures 0x0 on the first few frames after mount — React
    // has committed the node but the flex/resizable-panel layout above it
    // hasn't resolved a width yet. Connecting at that point creates the PTY at
    // the fallback 80x24, so the shell generates its MOTD (and every prompt
    // until the first SIGWINCH lands) wrapped to a width the pane never had,
    // which is what left the output stranded in a narrow column that only a
    // manual window resize cleaned up. Waiting for a real measurement costs a
    // frame or two and gets the size right the first time.
    //
    // The timeout matters as much as the wait: a pane created in a background
    // tab is `display: none` and therefore legitimately 0x0 for as long as
    // that tab stays hidden, so this can't block on a size that may never
    // arrive. Falling back to connecting anyway just restores the old
    // behaviour for that case, and the existing ResizeObserver still corrects
    // the size once the tab is shown.
    const beginConnect = () => {
      if (disposed) return
      termRef.current?.fit(true)
      if (termRef.current) reportDimensions(termRef.current)
      const cols = termRef.current?.cols || 80
      const rows = termRef.current?.rows || 24
      connectWith(cols, rows)
    }

    const mountedAt = performance.now()
    let lastW = -1
    let lastH = -1
    let stableFrames = 0
    const awaitSize = () => {
      if (disposed) return
      const el = containerRef.current
      const w = el?.clientWidth ?? 0
      const h = el?.clientHeight ?? 0
      // "Settled" has to mean held steady for a while, not merely non-zero and
      // not merely equal twice. The pane climbs to its final width in stages
      // as react-resizable-panels resolves the layout, and it rests on an
      // intermediate width long enough to satisfy a two-frame check — which
      // is how the PTY ended up created at ~38 columns and the server sent a
      // MOTD truncated to match. Nothing can repair that text afterwards: the
      // later resize fixes the PTY, but the characters the server already
      // dropped are gone, which is exactly the cropped output that only went
      // away once something forced the shell to redraw.
      if (w > 0 && h > 0 && w === lastW && h === lastH) stableFrames++
      else stableFrames = 0
      lastW = w
      lastH = h
      // ~100ms of no movement, or a hard cap so a pane in a hidden tab (which
      // is legitimately 0x0 for as long as that tab stays hidden) still
      // connects rather than waiting forever.
      if (stableFrames >= 6 || performance.now() - mountedAt > 1000) {
        beginConnect()
        return
      }
      requestAnimationFrame(awaitSize)
    }
    awaitSize()

    function connectWith(cols: number, rows: number) {
    conn
      .connect(
        source,
        onEvent,
        onData,
        cols,
        rows,
        conn.reconnectPolicy(settingsRef.current, autoReconnectRef.current),
      )
      .then((id) => {
        if (disposed) {
          conn.disconnect(source, id).catch(() => {})
          return
        }
        setConnecting(false)
      
        // Now that the session is established, force a fit to ensure the backend
        // PTY gets the actual layout dimensions instead of the initial 80x24.
        termRef.current?.fit(true)
        setTimeout(() => {
          if (termRef.current) {
            termRef.current.fit(true)
            reportDimensions(termRef.current)
            const { cols: fittedCols, rows: fittedRows } = termRef.current
            conn.resize(source, id, fittedCols, fittedRows).catch(() => {})
          }
        }, 100)
      
        sessionId = id
        sessionIdRef.current = id
        onSessionIdRef.current?.(id)
        const { cols: initialCols, rows: initialRows } = term
        conn.resize(source, id, initialCols, initialRows).catch(() => {})
        // So you can start typing immediately instead of having to click
        // into the pane first — this is the point a new connection is
        // actually usable.
        term.focus()
        lineEditor?.start()
        applyLogging(id, loggingRef.current)
      })
      .catch((err) => {
        if (!disposed) {
          setConnecting(false)
          term.writeln(`\r\n[connect error] ${String(err)}`)
          setConnectFailed(String(err))
        }
      })
    }

    const dataListener = term.onData((data) => {
      if (lineEditor) {
        // Not translated: the line editor is local and matches on the
        // engine's own ^? for its own editing. What it eventually sends is a finished
        // line, which never contains a backspace anyway.
        //
        // Decoded here and nowhere else: the line editor works in characters,
        // and this path only ever carries typing — never a mouse report, which
        // is what made the byte channel necessary in the first place.
        lineEditor.handleData(new TextDecoder().decode(data))
        return
      }
      // Applied here rather than via a key handler so it covers every route
      // the engine takes to produce the byte, and only on what actually goes out
      // on the wire. Null means the session never expressed a preference,
      // which is ^? — what modern Unix expects.
      if (sessionId) conn.write(source, sessionId, data)
    })

    // The fan-out point, deliberately on `onInput` and not `onData`.
    //
    // `onData` also carries mouse tracking reports, DEC 1004 focus reports and
    // the core's replies to host queries (DSR, DA, OSC colour). None of those
    // may leave this pane: a mouse report carries *this* pane's geometry, so
    // in a differently-sized sibling the click lands on the wrong cell; a
    // focus report tells a pane it gained focus it did not gain; and a reply
    // belongs to the host that asked for it — fanning it out both leaves that
    // host waiting out its timeout and delivers unasked-for text to panes on
    // other machines entirely.
    //
    // Only what a human typed or pasted is broadcast, and it *adds* to this
    // pane's own write above rather than replacing it (see `broadcast.send`'s
    // `exceptPaneId`), so the single-pane path is identical either way.
    //
    // The backspace translation is re-derived here from this pane's setting
    // and travels with the bytes, which is the wrong-in-principle-but-right-
    // in-practice choice: it is a per-pane setting, and a group could in
    // theory mix ^H and ^? hosts. Translating per target would mean fanning
    // out the *string*, which is more machinery than a case nobody has hit is
    // worth. Noted here rather than silently.
    const inputListener = term.onInput((data) => {
      // Autocomplete's view of typing. `onInput` rather than `onData` because
      // this must not be fed by mouse reports or the replies the core sends to
      // host queries — neither is someone typing at a prompt.
      //
      // Enter and `^C` end the line: whatever was being composed is gone, and
      // the next thing on screen is output or a fresh prompt. Everything else
      // is a keystroke that may have started a line on a host with no markers
      // to say so.
      if (!lineEditor) {
        const submitted = data.some((b) => b === 0x0d || b === 0x0a)
        const abandoned = data.some((b) => b === 0x03)
        if (submitted) captureTypedLine()
        if (submitted || abandoned) {
          // `^C` throws the line away rather than running it, so it is an end
          // of line for tracking purposes but never something to remember.
          promptInput.reset()
          autocomplete.reset()
        } else {
          promptInput.noteInput(data)
          // Arms the offer on printable input and disarms it on anything else,
          // so a list never opens because the far end redrew the line — see
          // `AutocompleteController.noteInput`.
          autocomplete.noteInput(data)
        }
      }
      // A line-edited session (telnet without remote echo) sends whole lines
      // from the local editor, not keystrokes; there is nothing here to fan
      // out until the line is finished, and the keystrokes themselves would
      // be meaningless to a remote shell.
      if (lineEditor) return
      if (!broadcastingRef.current) return
      broadcast.send(broadcastGroupRef.current, data, paneId)
    })

    const selectionListener = term.onSelectionChange(() => {
      if (!settingsRef.current.copyOnSelect) return
      const text = term.getSelection()
      if (text) writeText(text).catch(() => {})
    })

    // Mark mode copies through the engine rather than by reaching for the
    // clipboard itself — see TerminalEngine.onCopyRequest. Unconditional:
    // pressing Enter to copy is an explicit request, not copy-on-select.
    const copyListener = term.onCopyRequest?.((text) => {
      if (text) writeText(text).catch(() => {})
    })
    const markModeListener = term.onMarkModeChange?.(setMarkMode)
    const hintModeListener = term.onHintModeChange?.(setHintMode)

    // The engine decides *that* a link was activated; opening it is the
    // platform's business and therefore this side's. The engine has already
    // checked the scheme immediately before asking — see `activateLink` — so
    // there is deliberately no second policy here, only the call.
    //
    // The opener plugin enforces a *scope* of its own on top of the command
    // permission, and the two are separate grants: `opener:allow-open-url`
    // enables the command "without any pre-configured scope", which means
    // every URL is refused until the capability also names one. Both live in
    // `src-tauri/capabilities/default.json`, where the scope is `http://*`
    // and `https://*` — deliberately the same allow-list `isOpenableUrl`
    // enforces, rather than the plugin's `allow-default-urls` set, which
    // would also grant `mailto:` and `tel:`.
    const linkListener = term.onLinkActivate?.((url) => {
      openUrl(url).catch((err) => {
        void logError(`opening a link failed: ${String(err)}`).catch(() => {})
        // The reason is in the message — a refused scope and a missing
        // browser are different problems and looked identical without it.
        toast.error(`Could not open that link: ${String(err)}`)
      })
    })

    // The single paste path, shared by right-click, Ctrl+Shift+V and
    // Shift+Insert. Its own function precisely so the multi-line guard cannot
    // apply to one route and not another: a keyboard paste that silently ran
    // forty lines while the mouse route asked first would be the worst of both.
    const pasteFromClipboard = () => {
      readText()
        .then((raw) => {
          if (!raw) return
          const text = stripTrailingNewline(raw)
          // All the clipboard held was a newline; there is nothing left to send.
          if (!text) return
          const lines = countLines(text)
          // The engine's own judgement where there is one. It refuses the same
          // multi-line pastes this used to catch by counting, and one more it
          // could not: a single line carrying a bracketed-paste terminator,
          // which looks perfectly ordinary and is the case that matters.
          const safe = term.isPasteSafe?.(text) ?? lines === 1
          if (safe) {
            term.paste(text)
            return
          }
          const multiLine = lines > 1
          // Both reasons get said when both apply. Naming only the line count
          // for a multi-line paste that *also* carries an escape sequence left
          // the more dangerous of the two properties unmentioned.
          const reasons: string[] = []
          if (multiLine) {
            reasons.push(
              'Every newline in a multi-line paste is a Return the shell acts on, so this runs each line as typed.',
            )
          }
          if (text.includes('\x1b')) {
            reasons.push(
              `${multiLine ? 'It also contains' : 'This text contains'} a terminal escape sequence. That is defused before being sent — the escape becomes a space — but text carrying one is worth a second look.`,
            )
          }
          void confirmRef.current({
            title: multiLine ? `Paste ${lines} lines?` : 'Paste this text?',
            // The fallback is unreachable today — the core calls a paste
            // unsafe only for a newline or an embedded terminator, and each
            // has a reason above — but an empty dialog would be the worst
            // possible way to find out that had changed.
            body: reasons.join(' ') || 'This text may not be safe to paste as typed.',
            confirmLabel: 'Paste',
          }).then((ok) => {
            if (ok) term.paste(text)
          })
        })
        .catch(() => {})
    }

    const onContextMenu = (e: MouseEvent) => {
      // A right-click on a link offers the link; anywhere else the gesture is
      // exactly what it was. Checked first because the paste setting would
      // otherwise swallow the event before the link was ever considered.
      const url = term.linkAtPointer?.(e) ?? null
      if (url) {
        e.preventDefault()
        setLinkMenu({ x: e.clientX, y: e.clientY, url })
        return
      }
      if (!settingsRef.current.rightClickPaste) return
      e.preventDefault()
      pasteFromClipboard()
    }
    container.addEventListener('contextmenu', onContextMenu)

    const onKeyDown = (e: KeyboardEvent) => {
      // Autocomplete first, and only ever while a suggestion is actually on
      // screen: `handleKey` returns false for everything else, so Tab, the
      // arrows and Escape reach the far end untouched the rest of the time.
      // Consumed the same way as the chords below — `GhosttyInputHandler`
      // skips any event that has been `preventDefault`ed.
      if (autocompleteRef.current?.handleKey(e)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      // Ctrl+Shift+C is what every terminal binds copy to, precisely because
      // plain Ctrl+C has to stay available as SIGINT. Until now the only copy in
      // the app was copy-on-select, so turning that setting off left no way to
      // copy at all. Runs on capture so the pane's input element never sees it.
      //
      // That capture is now the whole of the protection, where it used to be
      // belt and braces: this comment said Ctrl+Shift+C "maps to no sequence
      // anyway", and since the engine's own key encoder replaced our table it
      // does — `CSI 99;5u`, and under the Kitty protocol a program may well be
      // listening for it. Every branch below therefore has to consume what it
      // claims. `GhosttyInputHandler` skips any event that has been
      // `preventDefault`ed, which is what makes that enough.
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') {
        const text = term.getSelection()
        // With no selection there is nothing to copy, and consuming the key
        // would only mask whatever else might want it — which, now that the
        // chord encodes, includes the program on the far end.
        if (!text) return
        e.preventDefault()
        e.stopPropagation()
        writeText(text).catch(() => {})
      } else if (
        // The counterpart to the copy binding above, and consumed the same
        // way — see the note there about why consuming is now the point.
        // Plain Ctrl+V deliberately isn't bound —
        // it sends ^V, which is readline's quoted-insert, and a terminal that
        // swallowed it would break entering a literal control character.
        //
        // Shift+Insert is here because it is what PuTTY binds paste to, and
        // that is the muscle memory this app's users arrive with.
        //
        // Neither respects `rightClickPaste`: that setting is about what the
        // mouse does, not about whether pasting is allowed at all. Without
        // these, turning it off left no way to paste — the same hole the
        // Ctrl+Shift+C binding was added to close for copy.
        (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') ||
        (e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'Insert')
      ) {
        e.preventDefault()
        e.stopPropagation()
        pasteFromClipboard()
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') {
        // Selecting with the keyboard. Ctrl+Shift+M is what Windows Terminal
        // binds mark mode to, and like the copy and paste bindings above it
        // consumes the key rather than leaving it to the encoder. The engine
        // owns the mode itself — this is only the way in.
        e.preventDefault()
        e.stopPropagation()
        term.toggleMarkMode?.()
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u') {
        // Opening a link with the keyboard, beside mark mode's Ctrl+Shift+M so
        // the two read as a family. Consumed like the bindings above, and it
        // is the only link gesture that works while a full-screen program is
        // holding the mouse.
        e.preventDefault()
        e.stopPropagation()
        term.toggleHintMode?.()
      }
      // Escape is not handled here. Closing search runs through the shared
      // dismiss stack instead, so it competes properly with anything else
      // open. Note it is never preventDefault'd on any path: ESC has to keep
      // reaching the engine, or vim stops working.
    }
    container.addEventListener('keydown', onKeyDown, true)

    // One per session: it also holds the last size actually delivered, which is
    // what lets a tab switch that changed nothing send nothing.
    const ptyResize = createPtyResizeSender((cols, rows) => {
      if (!sessionId) return
      conn.resize(source, sessionId, cols, rows).catch(() => {})
    })

    const onResize = () => {
      // Switching away from this tab sets its container to `display:
      // none`, collapsing it to 0x0 — which the ResizeObserver below
      // faithfully reports. Fitting to that would resize the remote PTY
      // down to nothing and back on every tab switch, which is exactly
      // the kind of double-resize that left the client-side cursor
      // rendering a few columns off from the shell's own idea of where
      // it is, until the next full redraw (e.g. pressing Enter) resynced
      // them. A hidden container has nothing useful to fit to anyway.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      // Fitted immediately: the canvas has to track the container while the
      // pointer is still moving, or the pane visibly lags the window.
      term.fit()
      reportDimensions(term)
      // The far end is told once the drag settles — see ptyResize.ts. This
      // observer fires at pointer rate, and every intermediate size that
      // crosses a row boundary is its own SIGWINCH there. A program pinning a
      // status line to the last row redraws it on each one and leaves the row
      // it drew on before behind as ordinary text: measured against apt's
      // progress bar, a drag across five row boundaries left five stranded
      // bars and scrolled the real output off the top of the screen.
      if (sessionId) ptyResize.post(term.cols, term.rows)
      // Guarding against the 0x0 fit stopped the PTY-side desync, but the
      // canvas can still end up visually stale after this — most sharply
      // when a pane is dragged between tabs, since that detaches and
      // reattaches its DOM node elsewhere (React portal retargeting), and
      // detaching/reattaching a WebGL canvas can silently clear its actual
      // drawing buffer even though the JS-level context survives. The
      // renderer still believes already-painted rows are valid and only
      // repaints cells that changed, so old (cleared) content stays blank
      // while newly written rows still render correctly — clearTextureAtlas
      // + refresh() wasn't enough to fix this, since both still defer to
      // that same "nothing changed here" assumption. Tearing down and
      // rebuilding the addon from scratch forces a genuinely fresh full
      // repaint with no assumptions left over from before the move.
      // Delegate webgl rebuilding to engine
      term.rebuildWebglRenderer?.()
      term.refresh(0, term.rows - 1)
      updateScrollbarGeometry()
      updateThumb()
      // This only reaches here on a real (non-zero) resize, which is
      // exactly what happens when a hidden tab becomes visible again
      // (App.tsx's refit() dispatches a resize event on tab switch) — so
      // this doubles as "the tab holding this pane just became active."
      // Guarded on `active` too so, in a split, switching tabs doesn't
      // steal focus from a pane other than the one you'd last clicked
      // into within it.
      if (activeRef.current) term.focus()
    }
    window.addEventListener('resize', onResize)
    refitRef.current = onResize

    // Returning to the app from another window (Alt-Tab, a native dialog, the
    // Windows Hello prompt) leaves the active pane wedged — no keystrokes, no
    // cursor blink — until a tab switch refocuses it. On blur the input element
    // blurs (the engine reports focus loss and stops the blink); on return the
    // browser doesn't restore focus to it, and the Ghostty engine's input lives
    // on an invisible, pointer-events:none textarea Chromium won't re-focus on
    // its own. Crucially this is a *native* window activation — WebView2 does
    // not emit a DOM 'focus' event for it — so we listen to Tauri's window focus
    // event and re-assert focus on the active, visible pane (0×0 = a hidden tab,
    // which must not steal focus, matching the onResize guard).
    let unlistenFocus: (() => void) | null = null
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return
        if (!activeRef.current) return
        if (container.clientWidth === 0 || container.clientHeight === 0) return
        // Defer past WebView2's own focus handling: the native event can arrive
        // before the webview finishes restoring focus (often to <body>), and a
        // synchronous .focus() would then be overridden. Re-check on the next
        // frame that this pane is still the active, on-screen one before taking
        // focus, so a fast tab switch in between doesn't get overridden.
        requestAnimationFrame(() => {
          if (disposed || !activeRef.current) return
          if (container.clientWidth === 0 || container.clientHeight === 0) return
          // A selection the native transition left dangling (the browser can
          // also drop a stray gray selection where you clicked to refocus)
          // swallows input; clear it before handing focus back.
          window.getSelection()?.removeAllRanges()
          const refocusTarget = termRef.current
          // Window deactivation can sever the input element's IME/input context
          // in WebView2 so a plain focus() leaves printable input dead (only
          // Enter/arrows work). resetInputContext rebuilds it; fall back to
          // focus() for engines that don't need it.
          if (refocusTarget?.resetInputContext) refocusTarget.resetInputContext()
          else refocusTarget?.focus()
        })
      })
      .then((un) => {
        if (disposed) un()
        else unlistenFocus = un
      })

    // The container can shrink or grow without the OS window itself
    // resizing — e.g. the status footer appearing/disappearing as a
    // connection's status changes reflows the flex layout above it. A
    // plain 'resize' listener on window misses that entirely, leaving
    // the engine's row count stale and its rendering overlapping whatever
    // ends up occupying the space it no longer actually has.
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(container)

    return () => {
      disposed = true
      // A disposed pane must not resize a session it no longer owns.
      ptyResize.cancel()
      // Before the engine goes: the scheduler may be holding a queue and a
      // pending frame callback, and draining either into a disposed terminal
      // is a write to a freed core.
      scheduler.dispose()
      window.removeEventListener('resize', onResize)
      unlistenFocus?.()
      refitRef.current = null
      resizeObserver.disconnect()
      canvasObserver.disconnect()
      container.removeEventListener('contextmenu', onContextMenu)
      container.removeEventListener('keydown', onKeyDown, true)
      selectionListener.dispose()
      copyListener?.dispose()
      markModeListener?.dispose()
      hintModeListener?.dispose()
      linkListener?.dispose()
      dataListener.dispose()
      inputListener.dispose()
      scrollListener.dispose()
      writeParsedListener.dispose()
      searchResultsListener.dispose()
      initErrorListener?.dispose()
      bellListener.dispose()
      progressTracker.dispose()
      bufferListener.dispose()
      autocompleteRef.current = null
      autocomplete.reset()
      promptInput.resetAll()
      for (const listener of oscListeners) listener.dispose()
      // Reported directly rather than through the tracker (whose own reset
      // is a no-op when nothing was running) so a pane torn down mid-command
      // can't leave a spinner behind on a tab that no longer has a session.
      onActivityRef.current?.(IDLE)
      // Same reasoning, and reported directly for the same reason: `disposed`
      // is already set by this point, so setProgress would refuse it.
      onProgressRef.current?.(null)
      upBtn.removeEventListener('mousedown', onUpMouseDown)
      downBtn.removeEventListener('mousedown', onDownMouseDown)
      track.removeEventListener('mousedown', onTrackMouseDown)
      thumb.removeEventListener('mousedown', onThumbMouseDown)
      if (dragMoveHandler) window.removeEventListener('mousemove', dragMoveHandler)
      if (dragUpHandler) window.removeEventListener('mouseup', dragUpHandler)
      scrollbarEl.remove()
      if (sessionId) {
        conn.disconnect(source, sessionId).catch(() => {})
        if (loggingActiveRef.current) sessionLog.stop(sessionId).catch(() => {})
      }
      loggingActiveRef.current = false
      sessionIdRef.current = null
      onSessionIdRef.current?.(null)
      termRef.current = null
      
      updateScrollbarColorsRef.current = null
      updateScrollbarFocusRef.current = null
      term.dispose()
    }
    // `label` is display-only text for the "Connecting to..." line, not a
    // reconnect trigger — intentionally excluded so relabeling a pane
    // doesn't tear down its session. `logging`, `onStatus`, and
    // `onSessionId` are all read through refs so none of them reconnect
    // the session either (onStatus/onSessionId are fresh closures from
    // Pane.tsx on every render — see the refs above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  // Shared by both the failed and clean-disconnect overlays: retry the same
  // host, or drop back to the (pre-filled) connect dialog to change it.
  const disconnectActions = (
    <div className="flex items-center gap-2">
      {onReconnect && (
        <button
          type="button"
          onClick={onReconnect}
          className="flex items-center gap-1.5 rounded-md bg-sky-500/90 px-3 py-1.5 text-sm font-medium text-white transition-colors duration-fast ease-swift hover:bg-sky-500"
        >
          <RotateCw size={14} /> Reconnect
        </button>
      )}
      {onBackToConnect && (
        <button
          type="button"
          onClick={onBackToConnect}
          className="rounded-md bg-chrome/10 px-3 py-1.5 text-sm font-medium text-chrome/80 transition-colors duration-fast ease-swift hover:bg-chrome/15 hover:text-chrome"
        >
          Connection settings
        </button>
      )}
    </div>
  )

  // Geometry for the suggestion list, read at render time rather than carried
  // in the controller's state: cell size and scroll position change for
  // reasons that have nothing to do with what is being suggested (a resize, a
  // font change, scrolling back through history), and a copy taken when the
  // list opened would be stale for all three.
  const suggestionAnchor = (() => {
    if (!suggestion) return null
    const term = termRef.current
    const cell = term?.cellSize?.()
    if (!term || !cell || cell.width <= 0 || cell.height <= 0) return null
    return { cell, viewportY: term.viewportY, rows: term.rows, cols: term.cols }
  })()

  return (
    <div
      className="relative h-full w-full px-1.5 pt-3"
      // Painted here, from the exact same findTheme() call that configures
      // the engine's own theme a few lines up, rather than duplicated in a
      // separate wrapper — one source of truth means this padding can
      // never drift out of sync with whatever the terminal itself paints,
      // which a previous attempt at this (matching color one level up, in
      // App.tsx) did the moment a non-default theme was actually tested.
      style={{ background: backgroundWithOpacity(findTheme(settings.themeName), settings.backgroundOpacity) }}
      // A file dragged in from Explorer, as a DOM event rather than Tauri's
      // own drag-drop — that is switched off because it intercepts OS drags on
      // WebView2 and breaks the HTML5 events tab-to-pane dragging needs. The
      // `Files` check is what keeps the two apart: a pane being dragged
      // between tabs carries its own MIME type and must fall straight through
      // to the handlers that expect it.
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!dropTarget) setDropTarget(true)
      }}
      onDragLeave={(e) => {
        // Moving onto a child fires leave on the parent; the pointer has only
        // really left when what it moved to is outside this pane.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropTarget(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDropTarget(false)
        const file = fileFromDrop(e)
        if (!file) return
        const cwd = remoteCwdRef.current
        // Already agreed, and still the same directory: the point of asking
        // was that the host chose this path, and it has not chosen a new one
        // since. See `confirmedDestRef`.
        if (cwd && cwd === confirmedDestRef.current) {
          void uploadFile(file, cwd)
          return
        }
        // No OSC 7 means the shell never said where it is. Asking is the only
        // honest option — guessing `~` puts the file somewhere the user did
        // not choose and did not watch it go.
        //
        // With OSC 7 the prompt is a confirmation rather than a question: the
        // path is filled in and one Enter sends it.
        //
        // Failing both, prefer a path read off the window title over the last
        // one typed: it is at least this session's, and on a stock bash prompt
        // it is usually exactly right — it just isn't reported at all.
        setDropDest({
          file,
          path: cwd ?? titleCwdRef.current ?? lastDestRef.current ?? '',
          source: cwd ? 'reported' : titleCwdRef.current ? 'title' : 'unknown',
        })
      }}
    >
      {/* Deliberately loud, and on every pane in the group rather than only
          the focused one: the failure mode this guards against is typing a
          `reload` into what you believed was one switch. A ring around the
          whole pane is visible in peripheral vision in a way a toolbar badge
          is not, and it is the only state in the app that changes what a
          keystroke does. */}
      {broadcasting && (
        <div className="pointer-events-none absolute inset-0 z-30 rounded-sm ring-2 ring-inset ring-amber-400/70" />
      )}
      <div ref={containerRef} className="relative h-full w-full">
        {/* Inside the container so it is positioned against the grid itself,
            and after it so it paints over the canvas. `pointer-events-none` on
            the wrapper keeps the rest of the pane clickable — the list itself
            re-enables them for its own rows.

            `overflow-hidden` is the structural half of keeping the list inside
            its pane. `placeSuggestions` bounds its height to the space
            actually available, which is what stops it covering the line being
            typed; this is what stops it painting *outside the pane
            altogether* — over the status bar, or over a neighbouring pane in a
            split. Without it nothing at all constrains the overlay, because
            the grid is a few pixels shorter than the container that holds it
            and absolutely-positioned children happily paint past both. Belt
            and braces on purpose: a suggestion list drawn over the app's own
            chrome looks like a rendering fault, and one bad number should not
            be able to produce it. */}
        {suggestion && suggestionAnchor && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {suggestion.mode === 'inline' ? (
              <InlineSuggestion
                view={suggestion}
                cell={suggestionAnchor.cell}
                viewportY={suggestionAnchor.viewportY}
                rows={suggestionAnchor.rows}
                cols={suggestionAnchor.cols}
                fontFamily={settings.fontFamily}
                fontSize={settings.fontSize}
              />
            ) : (
              <SuggestionPopover
                view={suggestion}
                cell={suggestionAnchor.cell}
                viewportY={suggestionAnchor.viewportY}
                rows={suggestionAnchor.rows}
                onPick={(index) => {
                  const controller = autocompleteRef.current
                  if (!controller?.current) return
                  controller.move(index - controller.current.index)
                  controller.accept()
                  termRef.current?.focus()
                }}
              />
            )}
          </div>
        )}
      </div>
      {connecting && (
        <div className="animate-in fade-in pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#16171d] text-xs text-chrome/50 duration-150">
          <Loader2 size={20} className="animate-spin text-sky-400" />
          Connecting to {label}...
        </div>
      )}
      {connectFailed && (
        // Otherwise a failed connection (bad credential, unreachable host,
        // etc.) leaves this pane stuck showing a dead terminal with no way
        // back to the connect dialog short of closing the whole pane —
        // which, in a split, takes any sibling panes down with it too.
        <div className="animate-in fade-in absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#16171d] px-8 text-center text-xs text-chrome/60 duration-fast">
          <AlertTriangle size={20} className="text-red-400" />
          <p className="max-w-xs text-chrome/70">{connectFailed}</p>
          {disconnectActions}
        </div>
      )}
      {reconnecting && (
        // Deliberately not a full cover: the scrollback behind it is the whole
        // reason the pane did not remount, and hiding it would make a
        // four-second outage look like a pane that died. A strip, so what was
        // on screen stays readable while the connection comes back.
        <div className="animate-in fade-in slide-in-from-top-1 pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-2 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200/90 duration-fast">
          <Unplug size={13} className="animate-pulse" />
          <span>
            Connection lost — reconnecting in {reconnecting.inSeconds}s
            {reconnecting.attempt > 1 && ` (attempt ${reconnecting.attempt})`}
          </span>
        </div>
      )}
      {disconnected && !connectFailed && (
        // A clean remote-initiated disconnect with auto-close turned off:
        // offer to reconnect or reopen the connect dialog rather than leaving
        // a dead terminal behind.
        <div className="animate-in fade-in absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#16171d] px-8 text-center text-xs text-chrome/60 duration-fast">
          <Unplug size={20} className="text-chrome/40" />
          <p className="max-w-xs text-chrome/70">Connection closed.</p>
          {disconnectActions}
        </div>
      )}
      {engineFailed && (
        // Last of the state overlays deliberately, so plain DOM order paints
        // it over the connecting/failed/disconnected ones (see the z-index
        // note by the scrollbar above — these divs rank by document order, not
        // z-index). If the renderer never started, none of what those three
        // report is actionable and this is the only true thing on screen.
        //
        // Worth having at all because Ghostty is the default for new panes:
        // when its WASM core can't load, every method on the engine no-ops and
        // the pane is simply, silently blank — which reads as "the app is
        // broken" rather than as one component failing. There is no in-app
        // engine switch to point at, so this says what happened and where the
        // detail is, and stops short of implying a fix that doesn't exist.
        <div className="animate-in fade-in absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#16171d] px-8 text-center text-xs text-chrome/60 duration-fast">
          <AlertTriangle size={20} className="text-red-400" />
          <p className="max-w-xs text-chrome/70">This pane's terminal renderer failed to start.</p>
          <p className="max-w-xs text-chrome/40">{engineFailed}</p>
          <p className="max-w-xs text-chrome/40">Details are in the application log.</p>
        </div>
      )}
      {markMode && (
        // Bottom-left, clear of the search bar: both can be open at once, and
        // the mode is the thing you need to see while looking at text in the
        // middle of the pane. The keys are spelled out because a mode that
        // swallows typing has to say how to get back out of it.
        <div className="animate-in fade-in slide-in-from-bottom-1 pointer-events-none absolute bottom-2 left-2 z-40 flex items-center gap-2 rounded-lg border border-chrome/10 bg-surface px-2 py-1.5 text-xs text-chrome/70 shadow-xl duration-fast ease-swift">
          <TextCursorInput size={13} className="text-emerald-400" />
          <span className="font-medium">Mark</span>
          <span className="text-chrome/40">Shift+arrows select · Enter copies · Esc exits</span>
        </div>
      )}
      {hintMode && (
        // Beside mark mode's indicator and worded the same way: the mode has
        // taken the keyboard, so it has to say what the keys do now and how to
        // get out. An empty screen of labels means there were no links, which
        // this leaves visible rather than explaining away.
        <div className="animate-in fade-in slide-in-from-bottom-1 pointer-events-none absolute bottom-2 left-2 z-40 flex items-center gap-2 rounded-lg border border-chrome/10 bg-surface px-2 py-1.5 text-xs text-chrome/70 shadow-xl duration-fast ease-swift">
          <ExternalLink size={13} className="text-amber-400" />
          <span className="font-medium">Links</span>
          <span className="text-chrome/40">Type a label to open · Esc exits</span>
        </div>
      )}
      {dropTarget && canUpload && (
        // Deliberately just a ring and a word: the pane underneath is what the
        // file is being aimed at, and covering it would hide the directory the
        // prompt line is showing.
        <div className="pointer-events-none absolute inset-0 z-40 flex items-start justify-center rounded-sm bg-sky-400/5 ring-2 ring-inset ring-sky-400/70">
          <span className="mt-3 rounded-md border border-chrome/10 bg-surface px-2 py-1 text-xs text-chrome/80 shadow-xl">
            {remoteCwdRef.current && remoteCwdRef.current === confirmedDestRef.current
              ? `Send to ${remoteCwdRef.current}`
              : (remoteCwdRef.current ?? titleCwdRef.current)
                ? `Send to ${remoteCwdRef.current ?? titleCwdRef.current}? — you will be asked to confirm`
                : 'Drop to send — you will be asked where'}
          </span>
        </div>
      )}
      {dropDest && (
        // Where the destination is agreed rather than assumed: once per
        // directory, and again whenever the reported one changes.
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-80 rounded-lg border border-chrome/10 bg-surface p-3 text-xs shadow-xl">
            <p className="mb-1 font-medium text-chrome/90">Send {dropDest.file.name}</p>
            <p className="mb-2 text-chrome/40">
              {dropDest.source === 'reported'
                ? 'This is the directory the host says it is in. Confirmed once, and again whenever it changes — a host can report any directory it likes, and a file sent to the wrong one is hard to notice.'
                : dropDest.source === 'title'
                  ? 'This session reports its directory only in the window title, so this is read from there rather than told to us — check it before sending.'
                  : 'This session has not reported a working directory, so there is nowhere to send it by default. Give a directory on the host.'}
            </p>
            <input
              autoFocus
              value={dropDest.path}
              onChange={(e) => setDropDest({ ...dropDest, path: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dropDest.path.trim()) {
                  sendDropDest(dropDest)
                } else if (e.key === 'Escape') {
                  setDropDest(null)
                }
              }}
              placeholder="/var/tmp"
              className="mb-2 w-full rounded border border-chrome/10 bg-black/30 px-2 py-1 text-chrome/90 outline-none placeholder:text-chrome/25"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDropDest(null)}
                className="rounded px-2 py-1 text-chrome/50 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/90"
              >
                Cancel
              </button>
              <button
                disabled={!dropDest.path.trim()}
                onClick={() => sendDropDest(dropDest)}
                className="rounded bg-sky-500/25 px-2 py-1 text-sky-100 transition-colors duration-100 hover:bg-sky-500/40 disabled:opacity-30"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
      {transfer && (
        <div className="animate-in fade-in slide-in-from-bottom-1 absolute bottom-2 right-2 z-40 flex w-64 flex-col gap-1.5 rounded-lg border border-chrome/10 bg-surface px-2.5 py-2 text-xs shadow-xl duration-fast ease-swift">
          <div className="flex items-center gap-2">
            <Upload size={13} className="shrink-0 text-sky-400" />
            <span className="min-w-0 flex-1 truncate text-chrome/80">{transfer.name}</span>
            <button
              onClick={() => {
                if (transfer.id) void sftp.cancelTransfer(transfer.id).catch(() => {})
              }}
              title="Cancel this upload"
              className="flex items-center justify-center rounded p-0.5 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/80"
            >
              <X size={12} />
            </button>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-chrome/10">
            <div
              className="h-full bg-sky-400 transition-[width] duration-150"
              style={{
                width: `${transfer.total > 0 ? Math.min(100, (transfer.sent / transfer.total) * 100) : 100}%`,
              }}
            />
          </div>
          <span className="text-chrome/40">
            {formatBytes(transfer.sent)} of {formatBytes(transfer.total)}
          </span>
        </div>
      )}
      {linkMenu && (
        // Fixed to the pointer, like the tab strip's own menu. The URL is
        // shown in full rather than only acted on: the destination is the one
        // thing worth seeing before a browser opens on it, and it is the same
        // disclosure an OSC 8 link will need when that arrives, where the text
        // on screen and the target need not agree at all.
        <>
          {/* A click anywhere else closes it, including a click meant for the
              grid — which would otherwise land in the terminal underneath
              while the menu stayed up. */}
          <div className="fixed inset-0 z-40" onMouseDown={() => setLinkMenu(null)} />
          <div
            className="animate-in fade-in zoom-in-95 fixed z-50 max-w-xs origin-top-left rounded-md border border-chrome/10 bg-surface py-1 text-xs text-chrome/80 shadow-xl duration-100"
            style={{ left: linkMenu.x, top: linkMenu.y }}
          >
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 hover:bg-chrome/10"
              onClick={() => {
                termRef.current?.openLink?.(linkMenu.url)
                setLinkMenu(null)
              }}
            >
              <ExternalLink size={13} /> Open link
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 hover:bg-chrome/10"
              onClick={() => {
                writeText(linkMenu.url).catch(() => {})
                setLinkMenu(null)
              }}
            >
              <Copy size={13} /> Copy link
            </button>
            <div className="mt-1 break-all border-t border-chrome/10 px-3 pt-1.5 text-[11px] text-chrome/40">
              {linkMenu.url}
            </div>
          </div>
        </>
      )}
      {searchOpen && (
        <div className="animate-in fade-in slide-in-from-top-1 absolute right-2 top-2 z-40 flex items-center gap-0.5 rounded-lg border border-chrome/10 bg-surface px-2 py-1.5 text-xs shadow-xl duration-fast ease-swift">
          <Search size={13} className="mr-1 text-chrome/40" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              runSearch(e.target.value, { incremental: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                runSearch(searchQuery, { back: e.shiftKey })
              } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
                // Repeated from the pane-level binding because this input is a
                // *sibling* of the terminal container, not a child — so the
                // container's capture-phase handler never sees a keystroke
                // typed in here. Without this the toggle is one-way in exactly
                // the state where closing is the obvious thing to want: the box
                // focuses and selects itself the moment it opens, so the second
                // press of the same chord went nowhere.
                e.preventDefault()
                setSearchOpen(false)
              }
            }}
            placeholder="Find..."
            className="w-40 bg-transparent text-chrome/90 outline-none placeholder:text-chrome/30"
          />
          <span className="mx-1 min-w-[3.25rem] shrink-0 text-right tabular-nums text-chrome/40">
            {searchResults.count > 0
              ? `${searchResults.index + 1}/${searchResults.count}`
              : searchQuery
                ? 'None'
                : ''}
          </span>
          <button
            onClick={() => setSearchCaseSensitive((v) => !v)}
            className={`flex items-center justify-center rounded p-1 transition-colors duration-fast ease-swift ${
              searchCaseSensitive
                ? 'bg-sky-500/25 text-sky-200'
                : 'text-chrome/50 hover:bg-chrome/10 hover:text-chrome/90'
            }`}
            title="Match case"
          >
            <CaseSensitive size={14} />
          </button>
          <button
            onClick={() => setSearchRegex((v) => !v)}
            className={`flex items-center justify-center rounded p-1 transition-colors duration-fast ease-swift ${
              searchRegex
                ? 'bg-sky-500/25 text-sky-200'
                : 'text-chrome/50 hover:bg-chrome/10 hover:text-chrome/90'
            }`}
            title="Use regular expression"
          >
            <Regex size={14} />
          </button>
          <button
            onClick={() => runSearch(searchQuery, { back: true })}
            className="flex items-center justify-center rounded p-1 text-chrome/50 transition-colors duration-fast ease-swift hover:bg-chrome/10 hover:text-chrome/90"
            title="Previous (Shift+Enter)"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={() => runSearch(searchQuery)}
            className="flex items-center justify-center rounded p-1 text-chrome/50 transition-colors duration-fast ease-swift hover:bg-chrome/10 hover:text-chrome/90"
            title="Next (Enter)"
          >
            <ChevronDown size={14} />
          </button>
          <button
            onClick={() => setSearchOpen(false)}
            className="flex items-center justify-center rounded p-1 text-chrome/50 transition-colors duration-fast ease-swift hover:bg-chrome/10 hover:text-chrome/90"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {hostKeyPrompt && (
        <HostKeyPrompt
          host={hostKeyPrompt.host}
          port={hostKeyPrompt.port}
          fingerprint={hostKeyPrompt.fingerprint}
          status={hostKeyPrompt.status}
          storedFingerprint={hostKeyPrompt.storedFingerprint}
          onAnswer={(accept) => {
            conn.respondHostKey(hostKeyPrompt.requestId, accept)
            setHostKeyPrompt(null)
            // The initial auto-focus (in the connect().then() below) fires
            // as soon as the session id comes back, which for a fresh host
            // is *before* the SSH handshake actually finishes — host-key
            // verification blocks inside connect() itself, not before it's
            // called. Clicking Accept/Reject on this dialog's own button
            // steals focus, and once the button unmounts the browser drops
            // it to <body> with nothing left to reclaim it. Re-focus here,
            // right as the dialog closes, so the terminal is left with
            // focus regardless of which one of these two fired first.
            termRef.current?.focus()
          }}
        />
      )}
      {authPrompt && (
        <AuthPrompt
          // Keyed by request so each round of a multi-step exchange gets a
          // fresh dialog. Without it React reuses the mounted one and the
          // previous round's typed values sit in the new round's fields —
          // which for "Password:" then "Verification code:" means submitting
          // the password as the code.
          key={authPrompt.requestId}
          name={authPrompt.name}
          instructions={authPrompt.instructions}
          fields={authPrompt.fields}
          host={authPrompt.host}
          port={authPrompt.port}
          isJump={authPrompt.isJump}
          onAnswer={(responses) => {
            conn.respondAuthPrompt(authPrompt.requestId, responses)
            setAuthPrompt(null)
            // Same focus handoff as the host-key dialog above: this dialog's
            // own input held focus, and once it unmounts the browser drops
            // focus to <body> with nothing left to reclaim it.
            termRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}
