import { useEffect, useMemo, useRef, useState } from 'react'
import { SCROLLBAR_GUTTER_PX, type TerminalEngine } from '../lib/terminalEngine'
import { buildFontSelection } from '../lib/fontStack'
import type { SessionProfile } from '../lib/profiles'
import { GhosttyEngine } from '../lib/ghostty/GhosttyEngine'
import type { ModeSnapshot } from '../lib/ghostty/sessionModes'
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
  FolderOpen,
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
import { proxyConfigFrom } from '../lib/settings'
import { actionForEvent, isRecordingShortcut } from '../lib/keybindings'
import { findTheme, backgroundWithOpacity, hexToRgb } from '../lib/theme'
import { HostKeyPrompt } from './HostKeyPrompt'
import { AuthPrompt } from './AuthPrompt'
import { useConfirm } from './confirmContext'
import { useDismissable } from '../hooks/useDismissable'
import { LineEditor, parseHexLine } from '../lib/lineEditor'
import * as deliveryStats from '../lib/deliveryStats'
import { createWriteScheduler } from '../lib/writeScheduler'
import { pathFlavorFor } from '../lib/localOpen'
import { CommandTracker, IDLE } from '../lib/shellIntegration'
import {
  harvestRemoteHistory,
  forgetCommandHistory,
  historyKeyForSource,
  recordAccepted,
  recordCommand,
  suggestCommands,
} from '../lib/commandHistory'
import { PromptInputTracker, tooShortToInfer } from '../lib/promptInput'
import { AutocompleteController, type SuggestionView } from '../lib/autocomplete'
import { SuggestionPopover } from './SuggestionPopover'
import { InlineSuggestion } from './InlineSuggestion'
import { HistoryRepeatWatcher } from '../lib/historyRepeat'
import { HistoryFlicker, spansFor } from '../lib/historyFlicker'
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
import { countLines, pasteNeedsNoConfirm, stripTrailingNewline } from '../lib/pasteGuard'

/**
 * Bytes to write before granting the backend more credit: a sixteenth of its
 * 16 MB window (`DEFAULT_MAX_INFLIGHT_BYTES` in coalesce.rs), so credit flows
 * back steadily at one IPC round trip per four deliveries.
 */
const ACK_THRESHOLD_BYTES = 1024 * 1024

/** The theme for the pane's surroundings: the configured one, with App's
 *  unfocused-window background override applied. */
function paneTheme(settings: TerminalSettings) {
  const theme = findTheme(settings.themeName)
  return settings.backgroundOverride ? { ...theme, background: settings.backgroundOverride } : theme
}

/**
 * Sends a dead-engine report to the Rust-side log, the only place it is
 * visible in a release build. Best-effort: there's no backend under `npm run dev`.
 */
function reportEngineFailure(message: string) {
  void logError(`terminal engine failed to start: ${message}`).catch(() => {})
}

interface Props {
  source: ConnectionSource
  /** The saved session this pane was opened from, if any, so history files under
   * it; see `historyKeyForSource`. */
  savedProfile?: SessionProfile | null
  label: string
  settings: TerminalSettings
  /** Which byte Backspace sends for this pane: true = ^H, false/null = ^?. */
  backspaceSendsCtrlH?: boolean | null
  /** `false` opts out of auto-reconnect; null/absent follows the global setting.
   * See `PaneLeaf.autoReconnect`. */
  autoReconnect?: boolean | null
  logging?: boolean
  /** Start a transcript at connect even though `logging` is off. */
  autoLog?: boolean
  /** Told when `autoLog` started one. */
  onAutoLog?: () => void
  /** Whether this is the focused pane within its (possibly split) tab. */
  active?: boolean
  /** This pane's id, so a targeted searchRequest can address it. */
  paneId: string
  /** The broadcast group (the pane's tab). */
  broadcastGroupId: string
  /** Whether this pane's tab is broadcasting input to all its panes. */
  broadcasting?: boolean
  /** App's toolbar search request; opens the search box when it targets this
   * pane with a new nonce. */
  searchRequest?: { nonce: number; paneId: string } | null
  onStatus?: (status: string) => void
  onSessionId?: (id: string | null) => void
  /** The fitted grid in cells, reported only when it changes. */
  onDimensions?: (cols: number, rows: number) => void
  /** Scrollback bytes this pane's engine was built with, reported once at mount.
   * From the engine, not settings: open panes keep their original budget. */
  onScrollbackBudget?: (budgetBytes: number) => void
  /** Whether a command is running, per OSC 133. See lib/shellIntegration.ts. */
  onActivity?: (activity: CommandActivity) => void
  /** OSC 9;4 progress from the far end, or null when cleared or disconnected.
   * Covers full-screen programs that shell integration can't see. See
   * lib/appProgress.ts. */
  onProgress?: (progress: AppProgress | null) => void
  /** A program that was reporting progress has stopped (cleared it, or the shell
   * returned to a prompt). Not raised when the session drops.
   *
   * @param durationMs how long progress had been up; the caller applies a floor. */
  onProgressComplete?: (durationMs: number) => void
  /** The far end asked for a desktop notification (OSC 9 / OSC 777). */
  onRemoteNotify?: (notification: RemoteNotification) => void
  /** The far end set (or cleared, null) the window title via OSC 0/2. See
   * lib/remoteIdentity.ts. */
  onRemoteTitle?: (title: string | null) => void
  /** The far end reported its working directory (OSC 7). */
  onRemoteCwd?: (cwd: string) => void
  /** A file path in the output was activated, as written; the caller resolves
   *  it. Path links are only offered when this is given. */
  onOpenPath?: (path: string) => void
  /** A command finished, with its exit code and how long it took. */
  onCommandComplete?: (result: CommandResult) => void
  /** The far end rang the bell (BEL). */
  onBell?: () => void
  /** Reopen the connect dialog in place after a failed connection. */
  onBackToConnect?: () => void
  /** Retry the same connection in place. */
  onReconnect?: () => void
}

interface PendingHostKey {
  requestId: string
  host: string
  port: number
  fingerprint: string
  status: 'unknown' | 'changed' | 'newKeyType'
  storedFingerprint: string | null
  knownKeys: string[]
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

export function Terminal({
  source,
  savedProfile,
  label,
  settings,
  backspaceSendsCtrlH,
  autoReconnect,
  logging,
  autoLog,
  onAutoLog,
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
  onOpenPath,
  onCommandComplete,
  onBell,
  onBackToConnect,
  onReconnect,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  /** Border-only frame over the non-grid parts of the pane; widths are measured. */
  const frameRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  /** Whether search was open last render, so closing it can return focus. */
  const wasSearchOpen = useRef(false)
  const termRef = useRef<TerminalEngine | null>(null)
  const [hostKeyPrompt, setHostKeyPrompt] = useState<PendingHostKey | null>(null)
  const [authPrompt, setAuthPrompt] = useState<PendingAuthPrompt | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  /** Keyboard selection is on; shown in the pane since it takes the arrow keys. */
  const [markMode, setMarkMode] = useState(false)
  /** Hint mode is on; shown in the pane since it swallows typing. */
  const [hintMode, setHintMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  /**
   * A full-screen program has the terminal. The alternate screen has no
   * scrollback, so the find bar says it is only searching the visible screen.
   */
  const [altScreen, setAltScreen] = useState(false)
  // Search position for the "N/M" count; index is 0-based, -1 when none.
  const [searchResults, setSearchResults] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0,
  })

  // Escape reaches the search box only when it is the topmost surface.
  useDismissable(searchOpen, () => setSearchOpen(false))

  /**
   * Right-click menu on a link. Right-click elsewhere still pastes (when
   * enabled); the menu shows the destination before anything opens.
   */
  const [linkMenu, setLinkMenu] = useState<{
    x: number
    y: number
    url: string
    kind: 'url' | 'path'
  } | null>(null)
  useDismissable(linkMenu !== null, () => setLinkMenu(null))

  /** What autocomplete is offering, or null; pushed by the controller in the
   * connection effect. */
  const [suggestion, setSuggestion] = useState<SuggestionView | null>(null)
  /** For the pane's key handler, which outlives individual controllers. */
  const autocompleteRef = useRef<AutocompleteController | null>(null)
  /** The last directory the host reported (OSC 7, OSC 133/633 `P;Cwd=`, or
   *  OSC 1337 `CurrentDir=`), where a dropped file goes. */
  const remoteCwdRef = useRef<string | null>(null)
  /** A directory guessed from the window title; only ever a prompt prefill. */
  const titleCwdRef = useRef<string | null>(null)
  /** A file is being dragged over this pane. */
  const [dropTarget, setDropTarget] = useState(false)
  /**
   * A dropped file whose destination needs confirming: there's nowhere known to
   * put it, or the destination is a claim made by the host.
   */
  const [dropDest, setDropDest] = useState<{
    file: File
    path: string
    /** Where the prefill came from, which the prompt explains. */
    source: 'reported' | 'title' | 'unknown'
  } | null>(null)
  /** What was typed into that prompt last time, to prefill it the next. */
  const lastDestRef = useRef<string | null>(null)
  /**
   * The reported directory the user already agreed to send to. Reported paths
   * come from the untrusted host (OSC 7 could point a drop at a web root), so
   * each new one is confirmed once; repeat drops into it go straight out.
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
  // Pane.tsx remounts this component on every reconnect.
  const [connecting, setConnecting] = useState(true)
  // Set when a connection attempt fails; cleared only by a remount. Shows the
  // "back to connect dialog" affordance.
  const [connectFailed, setConnectFailed] = useState<string | null>(null)
  // A clean remote disconnect with "close pane on disconnect" off; shows the
  // Reconnect overlay.
  const [disconnected, setDisconnected] = useState(false)
  // An auto-reconnect in flight. The pane doesn't remount for one (that keeps
  // the scrollback), so this is cleared explicitly on reconnection.
  const [reconnecting, setReconnecting] = useState<Reconnecting | null>(null)
  // Read from the connection effect's handler, which closes over stale state.
  const reconnectingRef = useRef<Reconnecting | null>(null)
  reconnectingRef.current = reconnecting
  // The rendering engine never came up. Separate from connection failures:
  // the session may be fine, and reconnecting won't help.
  const [engineFailed, setEngineFailed] = useState<string | null>(null)

  // Settings change without reconnecting, so they're read through a ref.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // Read at each use: profiles load late and can be edited.
  const savedProfileRef = useRef(savedProfile)
  savedProfileRef.current = savedProfile

  // Live refs for values the connection effect reads but must not re-run on.
  const backspaceRef = useRef(backspaceSendsCtrlH)
  backspaceRef.current = backspaceSendsCtrlH

  const autoReconnectRef = useRef(autoReconnect)
  autoReconnectRef.current = autoReconnect

  const confirm = useConfirm()
  const confirmRef = useRef(confirm)
  confirmRef.current = confirm

  const broadcastingRef = useRef(broadcasting)
  broadcastingRef.current = broadcasting
  const broadcastGroupRef = useRef(broadcastGroupId)
  broadcastGroupRef.current = broadcastGroupId

  const loggingRef = useRef(logging)
  loggingRef.current = logging
  const autoLogRef = useRef(autoLog)
  autoLogRef.current = autoLog
  const onAutoLogRef = useRef(onAutoLog)
  onAutoLogRef.current = onAutoLog

  // Lets applyLogging act on the live session from outside the connect effect.
  const sessionIdRef = useRef<string | null>(null)
  // Whether a log file is open for this session; prevents double start/stop.
  const loggingActiveRef = useRef(false)
  // Feeds the log filename.
  const labelRef = useRef(label)
  labelRef.current = label

  // Starts or stops session logging to match `want`, idempotently. The flag is
  // set before the async start so a second call can't open a second log.
  function applyLogging(sessionId: string, want: boolean | undefined) {
    if (want && !loggingActiveRef.current) {
      loggingActiveRef.current = true
      const { logPlainText, logDirectory } = settingsRef.current
      sessionLog.start(sessionId, labelRef.current, logPlainText, logDirectory).catch((err) => {
        loggingActiveRef.current = false
        // Likeliest cause is a chosen folder that's gone (an unplugged drive).
        toast.error(`Could not start the session log: ${String(err)}`)
      })
    } else if (!want && loggingActiveRef.current) {
      loggingActiveRef.current = false
      sessionLog.stop(sessionId).catch(() => {})
    }
  }

  // Apply logging toggles to the live session; the connect handler applies the
  // initial state.
  useEffect(() => {
    const id = sessionIdRef.current
    if (id) applyLogging(id, logging)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logging])

  // Pane.tsx passes fresh closures every render; listing them as effect
  // dependencies would reconnect the session on every status update.
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  const onSessionIdRef = useRef(onSessionId)
  onSessionIdRef.current = onSessionId

  const onDimensionsRef = useRef(onDimensions)
  onDimensionsRef.current = onDimensions

  const onScrollbackBudgetRef = useRef(onScrollbackBudget)
  onScrollbackBudgetRef.current = onScrollbackBudget

  /** Last grid reported upward, so the many ResizeObserver callbacks during a
   * drag only dispatch when the cell grid actually changes. */
  const lastDimsRef = useRef<{ cols: number; rows: number } | null>(null)

  const reportDimensions = (term: TerminalEngine) => {
    const { cols, rows } = term
    // A hidden tab fits to 0x0.
    if (cols <= 0 || rows <= 0) return
    const last = lastDimsRef.current
    if (last && last.cols === cols && last.rows === rows) return
    lastDimsRef.current = { cols, rows }
    onDimensionsRef.current?.(cols, rows)
  }

  // Same live-ref treatment as onStatus.
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

  const onOpenPathRef = useRef(onOpenPath)
  onOpenPathRef.current = onOpenPath

  const onBellRef = useRef(onBell)
  onBellRef.current = onBell

  // Registers this pane as a broadcast target for its tab. Separate from the
  // connect effect so moving a pane between tabs re-registers without tearing
  // down the session. Registration is unconditional; broadcast mode is decided
  // at send time.
  const sourceRef = useRef(source)
  sourceRef.current = source
  useEffect(() => {
    return broadcast.join(paneId, broadcastGroupId, (data) => {
      const id = sessionIdRef.current
      // Panes without a live session are skipped.
      if (id) conn.write(sourceRef.current, id, data).catch(() => {})
    })
  }, [paneId, broadcastGroupId])

  const activeRef = useRef(active)
  activeRef.current = active

  // Open the search box when App's toolbar targets this pane; the nonce
  // prevents refiring on unrelated renders.
  const searchReqSeen = useRef(0)
  useEffect(() => {
    if (!searchRequest || searchRequest.paneId !== paneId) return
    if (searchRequest.nonce === searchReqSeen.current) return
    searchReqSeen.current = searchRequest.nonce
    setSearchOpen(true)
    // Refocus if already open (the effect below won't fire).
    searchInputRef.current?.focus()
  }, [searchRequest, paneId])

  // Set inside the connect effect so other effects can reach into it without
  // reconnecting the session.
  const updateScrollbarColorsRef = useRef<(() => void) | null>(null)

  const updateScrollbarFocusRef = useRef<((active: boolean) => void) | null>(null)

  // Lets the font effect re-fit just this pane (a window resize event would
  // re-fit every pane).
  const refitRef = useRef<(() => void) | null>(null)

  // Theme updates apply live, without reconnecting.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.setTheme(
        settings.themeName,
        settings.backgroundOpacity,
        settings.backgroundOverride,
      )
    }
    updateScrollbarColorsRef.current?.()
  }, [settings.themeName, settings.backgroundOpacity, settings.backgroundOverride])

  // Font settings apply live too; the effect re-fits so the PTY learns the new
  // size. Memoized because building the selection registers `@font-face`s and a
  // new object would rebuild the renderer.
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

  // Per-session setting, separate from the global ones above.
  useEffect(() => {
    termRef.current?.setBackspaceSendsCtrlH?.(backspaceSendsCtrlH)
  }, [backspaceSendsCtrlH])

  // Only the focused pane shows its scrollbar.
  useEffect(() => {
    updateScrollbarFocusRef.current?.(!!active)
  }, [active])

  // Runs a search with the current toggles. An empty or invalid query clears
  // highlights and the count.
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
   * Upload chunk size over IPC. Bytes go through the webview because Tauri's
   * native drag-drop is off (it breaks tab dragging; see `dragDropEnabled` in
   * tauri.conf.json).
   */
  const UPLOAD_CHUNK_BYTES = 256 * 1024

  /** One place for the three sequences that can report a directory. */
  function noteRemoteCwd(cwd: string) {
    onRemoteCwdRef.current?.(cwd)
    // Kept locally too: the drop handler needs it without a render's delay.
    remoteCwdRef.current = cwd
  }

  /** Only SSH can transfer files. */
  const canUpload = conn.transportOf(source) === 'ssh'

  /** The prompt's Send: remembers the directory as agreed, then uploads. */
  function sendDropDest(dest: { file: File; path: string }) {
    const path = dest.path.trim()
    lastDestRef.current = path
    confirmedDestRef.current = path
    setDropDest(null)
    void uploadFile(dest.file, path)
  }

  /**
   * Sends one file to `remoteDir` on this pane's host, streamed in slices
   * straight into the SFTP write. Progress is bytes the server has accepted.
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
          toast.info(`Upload of ${file.name} canceled`)
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
      // The transfer already ended (canceled or failed, already reported).
      await sftp.cancelTransfer(transferId).catch(() => {})
    }
  }

  /** The file to send, or null after reporting why; see `verdictForDrop`. */
  function fileFromDrop(e: React.DragEvent): File | null {
    // Must run during the handler; a dropped folder otherwise looks like a file.
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
      // Restore highlights for a query still in the box.
      if (searchQuery) runSearch(searchQuery, { incremental: true })
    } else {
      // Don't leave highlights behind.
      termRef.current?.clearSearchDecorations()
      setSearchResults({ index: -1, count: 0 })
      // Closing unmounts the focused input, dropping focus to <body>; return it
      // to the pane. Guarded so the mount-time run doesn't steal focus.
      if (wasSearchOpen.current) termRef.current?.focus()
    }
    wasSearchOpen.current = searchOpen
    // Fires on open/close only; searchQuery is a one-shot restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen])

  // Re-run the query when a toggle flips.
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

    // The settings effects above ran before the engine existed, and only fire on
    // changes, so every engine setting must be applied here too.
    term.setTheme(
      settingsRef.current.themeName,
      settingsRef.current.backgroundOpacity,
      settingsRef.current.backgroundOverride,
    )
    term.setFont(buildFontSelection(settingsRef.current), settingsRef.current.fontSize)
    term.setScrollbackBudget(settingsRef.current.scrollbackBudgetMB)
    term.setCursorStyle(settingsRef.current.cursorStyle, settingsRef.current.cursorBlink)
    term.setTextBlending?.(settingsRef.current.textBlending)
    term.setLigatures?.(settingsRef.current.ligatures)
    // Per-session, same rule.
    term.setBackspaceSendsCtrlH?.(backspaceRef.current)
    // ConPTY keeps no scrollback and repaints after a resize, so rows pulled
    // back from ours would be lost.
    const transport = conn.transportOf(source)
    term.setResizePullsScrollback?.(transport !== 'local' && transport !== 'elevated')
    // Paths are links only where there's somewhere to send one.
    term.setPathLinks?.(onOpenPathRef.current === undefined ? null : pathFlavorFor(source))
    // Read back from the engine, which resolves unknown tiers and fixes the
    // budget at construction.
    onScrollbackBudgetRef.current?.(term.scrollbackBudgetBytes)

    const searchResultsListener = term.onSearchResult((result) => {
      if (disposed) return
      setSearchResults({ index: result.index, count: result.count })
    })

    // Engines that can fail to start report it here.
    const initErrorListener = term.onInitError?.((message) => {
      reportEngineFailure(message)
      if (disposed) return
      setEngineFailed(message)
    })

    term.mount(container)
    term.fit()
    reportDimensions(term)

    // Custom scrollbar overlay with arrow buttons, styled like the native Windows
    // console's (see .term-scrollbar-* in index.css). The explicit z-index gives
    // the container its own stacking context, so the scrollbar doesn't paint over
    // (and eat clicks meant for) the overlay siblings in the JSX below.
    container.style.position = 'relative'
    container.style.zIndex = '0'
    const scrollbarEl = document.createElement('div')
    scrollbarEl.className = 'term-scrollbar'
    // Fixed-width controls anchored right inside the wider masking box.
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

    // Size the mask to the real gap between the canvas's right edge and the
    // container (a partial column plus the gutter). Recomputed whenever the grid
    // resizes, not just the window: a width measured at the 80x24 fallback masks
    // half the pane.
    const canvasObserver = new ResizeObserver(() => updateScrollbarGeometry())
    const updateScrollbarGeometry = () => {
      let canvasRight = 0
      let canvasLeft = Infinity
      let canvasTop = Infinity
      let canvasBottom = 0
      for (const canvas of container.querySelectorAll('canvas')) {
        const rect = canvas.getBoundingClientRect()
        if (rect.width > 0) {
          canvasRight = Math.max(canvasRight, rect.right)
          canvasLeft = Math.min(canvasLeft, rect.left)
          canvasTop = Math.min(canvasTop, rect.top)
          canvasBottom = Math.max(canvasBottom, rect.bottom)
        }
      }
      // Observe the canvases themselves: the container doesn't resize when the
      // grid refits, and a renderer rebuild can swap the canvas.
      for (const canvas of container.querySelectorAll('canvas')) {
        canvasObserver.observe(canvas)
      }
      if (canvasRight === 0) return
      const gap = container.getBoundingClientRect().right - canvasRight
      // Clamped to one partial column plus the gutter; anything wider is stale
      // and would hide the terminal.
      const width = Math.min(Math.max(gap, SCROLLBAR_GUTTER_PX), SCROLLBAR_GUTTER_PX * 8)
      scrollbarEl.style.width = `${width}px`

      // The frame covers exactly what the grid doesn't: padding, gutter, and the
      // partial column and row.
      const frame = frameRef.current
      if (frame) {
        const box = frame.getBoundingClientRect()
        frame.style.borderTopWidth = `${Math.max(0, canvasTop - box.top)}px`
        frame.style.borderLeftWidth = `${Math.max(0, canvasLeft - box.left)}px`
        frame.style.borderRightWidth = `${Math.max(0, box.right - canvasRight)}px`
        frame.style.borderBottomWidth = `${Math.max(0, box.bottom - canvasBottom)}px`
      }
    }

    // Thumb/arrow color from the theme foreground. The gutter background comes
    // from the frame; see .term-scrollbar in index.css.
    function updateScrollbarColors() {
      const theme = findTheme(settingsRef.current.themeName)
      const [fr, fg, fb] = hexToRgb(theme.foreground)
      scrollbarEl.style.setProperty('--term-scrollbar-fg', `${fr}, ${fg}, ${fb}`)
    }
    updateScrollbarColors()
    updateScrollbarColorsRef.current = updateScrollbarColors

    // Controls show only when there's scrollback and the pane is focused; the
    // mask itself always stays. `visibility`, not `display`, so track geometry
    // stays measurable while hidden.
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
    // preventDefault keeps focus on the terminal.
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

    // Clicking the track pages up or down.
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
      // A list drawn against a line that just moved would sit over unrelated text.
      autocomplete.clear()
    })
    const writeParsedListener = term.onWriteParsed(() => {
      updateThumb()
      // Pending `B` origins are measured here (the OSC scanner runs ahead of the
      // parser), and the offered list is re-checked against the redrawn line.
      promptInput.noteParsed()
      // The far end answered; also how the session's round trip is measured.
      historyRepeats.noteParsed()
      autocomplete.refresh()
      harvestOnce()
    })

    // Shell integration via OSC 133 and VS Code's superset OSC 633 (same
    // handler). Without integration the tracker just stays idle.
    //
    // Whether this host has reported a command via OSC 633 `E`; once it has,
    // screen capture is unnecessary (see `captureTypedLine`).
    let reportsCommandText = false
    const tracker = new CommandTracker({
      onChange: (activity) => {
        if (!disposed) onActivityRef.current?.(activity)
      },
      onComplete: (result) => {
        if (disposed) return
        onCommandCompleteRef.current?.(result)
        if (result.command) reportsCommandText = true
        // Tier 2 capture: the shell reported the command verbatim, so nothing can
        // be mistaken for a password. Recorded on completion (a line that never
        // reached `D` was dropped); failed commands are still worth recalling.
        if (!settingsRef.current.autocompleteEnabled || !result.command) return
        // Null for a pane that records nothing; see `historyKeyForSource`.
        const historyKey = historyKeyForSource(source, savedProfileRef.current)
        if (!historyKey) return
        void recordCommand({
          host: historyKey,
          command: result.command,
          cwd: remoteCwdRef.current,
          source: 'integration',
        }).catch(() => {
          // Best-effort; the store is offline under `npm run dev`.
        })
      },
    })
    // Drops repeated OSC 9;4 reports before they reach App; busy apps resend the
    // same state constantly, on the output hot path.
    const progressTracker = new ProgressTracker({
      onChange: (progress) => {
        if (!disposed) onProgressRef.current?.(progress)
      },
      onComplete: (durationMs) => {
        if (!disposed) onProgressCompleteRef.current?.(durationMs)
      },
      // A full reset (RIS) clears the tab's progress indicator. Watched only
      // while a report is showing; see `watchReset`.
      watchReset: (cb) => term.registerResetHandler(cb),
    })

    // The line being typed, read off the grid; see lib/promptInput.ts.
    const promptInput = new PromptInputTracker(term)
    // Blinks the command when Up lands on the one already showing, so duplicate
    // history entries don't look like a dropped key. Independent of
    // autocomplete. Goes straight to the renderer, not React state.
    const historyFlicker = new HistoryFlicker((spans) => {
      if (!disposed) term.setHiddenSpans?.(spans)
    })
    const historyRepeats = new HistoryRepeatWatcher({
      read: () => promptInput.read(),
      emit: (repeat) => {
        if (!disposed) historyFlicker.flash(spansFor(repeat.origin, repeat.cursor))
      },
    })
    const autocomplete = new AutocompleteController({
      tracker: promptInput,
      suggest: (typed, limit) => {
        const historyKey = historyKeyForSource(source, savedProfileRef.current)
        if (!historyKey) return Promise.resolve([])
        return suggestCommands({
          host: historyKey,
          typed,
          cwd: remoteCwdRef.current,
          limit,
        })
      },
      send: (text) => {
        const id = sessionIdRef.current
        if (id) conn.write(source, id, new TextEncoder().encode(text)).catch(() => {})
      },
      noteAccepted: (command) => {
        const historyKey = historyKeyForSource(source, savedProfileRef.current)
        if (!historyKey) return
        void recordAccepted(historyKey, command).catch(() => {})
      },
      forget: (command) => {
        const historyKey = historyKeyForSource(source, savedProfileRef.current)
        if (!historyKey) return Promise.resolve()
        return forgetCommandHistory({ host: historyKey, command })
      },
      enabled: () => settingsRef.current.autocompleteEnabled,
      onChange: (view) => {
        if (!disposed) setSuggestion(view)
      },
    })
    autocompleteRef.current = autocomplete

    /**
     * Tier 1: import this host's shell history once per session, on first output
     * (the closest thing to "first prompt" without integration, and off the
     * connect path). Never retried, so a refusing host isn't asked repeatedly.
     */
    let harvestAttempted = false
    function harvestOnce() {
      if (harvestAttempted) return
      // SSH only: it needs a second channel.
      if (conn.transportOf(source) !== 'ssh') return
      const id = sessionIdRef.current
      if (!id) return
      // The harvest's own setting and profile override are resolved backend side.
      if (!settingsRef.current.autocompleteEnabled) return
      const historyKey = historyKeyForSource(source, savedProfileRef.current)
      if (!historyKey) return
      harvestAttempted = true
      void harvestRemoteHistory({
        sessionId: id,
        host: historyKey,
        importGlobally: settingsRef.current.autocompleteImportRemoteHistory,
        // The profile's import override applies when history is filed under it.
        profileId: historyKey.startsWith('profile://') ? historyKey.slice('profile://'.length) : null,
      }).catch(() => {
        // An ordinary outcome.
      })
    }

    /**
     * Tier 3 capture, for hosts without shell integration. Safe because every
     * typed character must have appeared on screen (an unechoed one suggests a
     * password prompt), and the stored text comes off the grid, not keystrokes.
     */
    function captureTypedLine() {
      if (!settingsRef.current.autocompleteEnabled) return
      // Keyed on having seen a reported command, not on a marked prompt: plain
      // OSC 133 marks prompts but can't report command text.
      if (reportsCommandText) return
      const input = promptInput.read()
      if (!input || input.text.trim() === '') return
      // A guessed prompt can't tell a shell from `[Y/n]`; see `tooShortToInfer`.
      if (!promptInput.exact && tooShortToInfer(input.text)) return
      if (input.text.length < promptInput.typedCount) return
      // PowerShell and CMD panes never reach screen capture.
      const historyKey = historyKeyForSource(source, savedProfileRef.current)
      if (!historyKey) return
      void recordCommand({
        host: historyKey,
        command: input.text,
        cwd: remoteCwdRef.current,
        source: 'screen',
      }).catch(() => {})
    }

    /** Core modes when the running command started; see the `C` case below. */
    let modesAtCommandStart: ModeSnapshot | null = null
    const oscListeners = [133, 633].map((ident) =>
      term.registerOscHandler(ident, (data) => {
        // A new prompt or exit report proves the program that set progress is gone
        // (one killed with SIGKILL never clears its own).
        const kind = data.split(';')[0]
        if (kind === 'A' || kind === 'D') progressTracker.set(null)
        // Likewise reset modes a killed program left on (mouse reporting, Kitty
        // keyboard). Snapshot at the first `C` only; some shells repeat it per
        // pipeline segment.
        if (kind === 'C') modesAtCommandStart ??= term.captureModes?.() ?? null
        else if ((kind === 'A' || kind === 'D') && modesAtCommandStart) {
          term.resetLeftoverModes?.(modesAtCommandStart)
          modesAtCommandStart = null
        }
        // `P;Cwd=` carries the same fact as OSC 7.
        const reported = parseCwdProperty(data)
        if (reported) noteRemoteCwd(reported)
        // `A`/`B` bound the typed line; `C`/`D` mean nothing to complete.
        promptInput.handleOsc(data)
        return tracker.handleOsc(data)
      }),
    )
    // Application progress and notifications: the only signal that survives a
    // full-screen program over SSH. See lib/appProgress.ts.
    oscListeners.push(
      term.registerOscHandler(9, (data) => {
        const result = parseOsc9(data)
        if (result.kind === 'progress') {
          progressTracker.set(result.progress)
          // The program's own report supersedes the shell's account of the run,
          // including a clear (`9;4;0`); see CommandTracker.noteProgress.
          tracker.noteProgress()
        } else if (result.kind === 'notify') onRemoteNotifyRef.current?.(result.notification)
        // A Windows directory only applies to a local shell.
        else if (result.kind === 'cwd' && conn.transportOf(sourceRef.current) !== 'ssh') {
          noteRemoteCwd(result.cwd)
        }
        // Claimed either way; nothing else handles OSC 9.
        return true
      }),
      term.registerOscHandler(777, (data) => {
        const notification = parseOsc777(data)
        if (notification) onRemoteNotifyRef.current?.(notification)
        // OSC 777 has other subcommands a later handler may implement.
        return notification !== null
      }),
    )
    // Title and directory from the far end; work without integration. Neither
    // renames the tab; see lib/remoteIdentity.ts.
    oscListeners.push(
      // OSC 0 (icon name + title) and OSC 2 (title). Not claimed.
      ...[0, 2].map((ident) =>
        term.registerOscHandler(ident, (data) => {
          const title = parseWindowTitle(data)
          onRemoteTitleRef.current?.(title)
          // Only a guess, used to prefill the drop prompt.
          titleCwdRef.current = guessCwdFromTitle(title)
          return false
        }),
      ),
      term.registerOscHandler(7, (data) => {
        const cwd = parseCwd(data)
        if (cwd) noteRemoteCwd(cwd)
        // Claimed only when it parsed.
        return cwd !== null
      }),
      // iTerm2's `CurrentDir=`.
      term.registerOscHandler(1337, (data) => {
        const cwd = parseCwdProperty(data)
        if (cwd) noteRemoteCwd(cwd)
        // OSC 1337 carries a great deal this does not implement.
        return cwd !== null
      }),
    )
    // OSC 52: the far end's only route to the clipboard. Reads are dropped, so
    // the host can't read what the user copied.
    oscListeners.push(
      term.registerOscHandler(52, (data) =>
        applyOsc52(data, {
          allowWrite: settingsRef.current.clipboardWriteFromRemote,
          writeText,
          // Toast on every write: silent writes are what make clipboard poisoning
          // work.
          onWrote: () => toast.info('The remote host set your clipboard'),
          onError: logError,
        }),
      ),
    )
    // Alternate screen mid-command means a full-screen program, so its
    // completion isn't reported like a finished batch job.
    const bufferListener = term.onBufferChange((isAlternate) => {
      setAltScreen(isAlternate)
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
            // Before the status line, so it lands on the primary screen, and so a new
            // shell doesn't inherit the dead program's modes.
            term.resetSessionModes?.()
            modesAtCommandStart = null
            term.writeln(`\r\n[${event.status}]`)
            // The running command's outcome and any progress are now unknowable.
            tracker.reset()
            progressTracker.reset()
          }
          if (retry) {
            // The retry run supersedes both terminal states until it gives up.
            setReconnecting(retry)
            setConnectFailed(null)
            setDisconnected(false)
          } else if (event.status.startsWith('failed')) {
            setReconnecting(null)
            setConnectFailed(event.status.replace(/^failed: /, ''))
          } else if (event.status === 'connected') {
            if (reconnectingRef.current) {
              // SSH has no session resumption; mark the seam in the scrollback.
              term.writeln('\r\n[reconnected — this is a new shell]')
            }
            setReconnecting(null)
          } else if (
            isDisconnect(event.status) &&
            !shouldAutoClosePane(event.status, settingsRef.current.closeOnDisconnect)
          ) {
            // Suppressed only when the pane is about to auto-close.
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
            knownKeys: event.knownKeys,
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

    // PTY output arrives on its own raw-bytes channel (see lib/connection.ts);
    // logging happens Rust-side. Writes are metered per frame rather than
    // inline, so a flood can't freeze the window (see lib/writeScheduler).
    // Credit is returned in ACK_THRESHOLD_BYTES batches.
    let unacked = 0
    const scheduler = createWriteScheduler(
      (bytes) => {
        // Measurable in a live session; see lib/deliveryStats.ts.
        deliveryStats.record(bytes.length, () => term.write(bytes))
        unacked += bytes.length
        // Also ack when the queue drains, so credit isn't stranded.
        if (unacked >= ACK_THRESHOLD_BYTES || scheduler.pending === 0) {
          const credit = unacked
          unacked = 0
          const id = sessionIdRef.current
          if (id) conn.ackDelivery(id, credit).catch(() => {})
        }
      },
      undefined,
      undefined,
      // Distinguishes deliberate pacing from starvation in the report.
      deliveryStats.recordPaced,
    )
    const onData = (bytes: Uint8Array) => {
      if (disposed) return
      setConnecting(false)
      scheduler.push(bytes)
    }

    // Readline modes (serial only) send whole lines on Enter; see
    // lib/lineEditor.ts.
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
              // The serial line-ending translation turns this CR into a normal Enter.
              conn.write(source, sessionId, new TextEncoder().encode(`${line}\r`)).catch(() => {})
            }
          })
        : null

    // Wait for the container to settle before connecting, so the PTY is created
    // at the real size rather than 80x24 (which wraps the MOTD wrongly). Capped,
    // since a pane in a hidden tab stays 0x0; the ResizeObserver fixes it later.
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
      // "Settled" means unchanged for several frames: the panel layout pauses on
      // intermediate widths, and text the server already wrapped can't be fixed.
      if (w > 0 && h > 0 && w === lastW && h === lastH) stableFrames++
      else stableFrames = 0
      lastW = w
      lastH = h
      // ~100ms steady, or a 1s cap.
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
        proxyConfigFrom(settingsRef.current),
      )
      .then((id) => {
        if (disposed) {
          conn.disconnect(source, id).catch(() => {})
          return
        }
        setConnecting(false)
      
        // Fit again now that the session exists so the PTY gets the real size.
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
        // Ready to type into immediately.
        term.focus()
        lineEditor?.start()
        // Applied once at connect, so stopping an automatic log stays stopped.
        const wantLog = loggingRef.current || autoLogRef.current === true
        applyLogging(id, wantLog)
        if (wantLog && !loggingRef.current) onAutoLogRef.current?.()
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
        // The line editor works in characters and edits on the engine's ^?; this
        // path only carries typing.
        lineEditor.handleData(new TextDecoder().decode(data))
        return
      }
      // Raw bytes to the wire; Backspace translation already happened in the engine.
      if (sessionId) conn.write(source, sessionId, data)
    })

    // Broadcast fans out from `onInput`, not `onData`: `onData` also carries
    // mouse reports (this pane's geometry), focus reports and replies to host
    // queries, none of which belong to other panes. Broadcast adds to this pane's
    // own write (see `broadcast.send`'s `exceptPaneId`). Backspace translation
    // uses this pane's setting for every target, which is wrong in principle for
    // a group mixing ^H and ^? hosts.
    const inputListener = term.onInput((data) => {
      // Autocomplete's view of typing. Enter and `^C` end the line.
      if (!lineEditor) {
        const submitted = data.some((b) => b === 0x0d || b === 0x0a)
        const abandoned = data.some((b) => b === 0x03)
        if (submitted) captureTypedLine()
        if (submitted || abandoned) {
          // `^C` discards the line, so it's never remembered.
          promptInput.reset()
          autocomplete.reset()
          historyRepeats.reset()
          historyFlicker.stop()
        } else {
          promptInput.noteInput(data)
          // After `noteInput`, which may infer the prompt origin.
          historyRepeats.noteInput(data)
          // Only printable input arms the offer; see
          // `AutocompleteController.noteInput`.
          autocomplete.noteInput(data)
        }
      }
      // A line-edited session sends whole lines; keystrokes aren't fanned out.
      if (lineEditor) return
      if (!broadcastingRef.current) return
      broadcast.send(broadcastGroupRef.current, data, paneId)
    })

    const selectionListener = term.onSelectionChange(() => {
      if (!settingsRef.current.copyOnSelect) return
      const text = term.getSelection()
      if (text) writeText(text).catch(() => {})
    })

    // Mark mode copies via the engine; unconditional since Enter is explicit.
    const copyListener = term.onCopyRequest?.((text) => {
      if (text) writeText(text).catch(() => {})
    })
    const markModeListener = term.onMarkModeChange?.(setMarkMode)
    const hintModeListener = term.onHintModeChange?.(setHintMode)

    // The engine has already checked the scheme (see `activateLink`). The opener
    // plugin also needs a URL scope, separate from the command permission; it is
    // `http://*` and `https://*` in `src-tauri/capabilities/default.json`, the
    // same allow-list as `isOpenableUrl` (not `allow-default-urls`, which adds
    // `mailto:` and `tel:`).
    const linkListener = term.onLinkActivate?.((url) => {
      openUrl(url).catch((err) => {
        void logError(`opening a link failed: ${String(err)}`).catch(() => {})
        // Include the reason: a refused scope and a missing browser look alike.
        toast.error(`Could not open that link: ${String(err)}`)
      })
    })

    // A path names a file on the remote host; the caller resolves it.
    const pathListener = term.onPathActivate?.((path) => onOpenPathRef.current?.(path))

    // The single paste path for right-click, Ctrl+Shift+V and Shift+Insert, so
    // the multi-line guard applies to all of them.
    const pasteFromClipboard = () => {
      readText()
        .then((raw) => {
          if (!raw) return
          const text = stripTrailingNewline(raw)
          if (!text) return
          const lines = countLines(text)
          // Both have to agree: see pasteGuard.ts for why ours is not optional.
          const safe = pasteNeedsNoConfirm(text, term.isPasteSafe?.(text))
          if (safe) {
            term.paste(text)
            return
          }
          const multiLine = lines > 1
          // Give both reasons when both apply.
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
            // The fallback is currently unreachable.
            body: reasons.join(' ') || 'This text may not be safe to paste as typed.',
            confirmLabel: 'Paste',
          }).then((ok) => {
            if (ok) term.paste(text)
          })
        })
        .catch(() => {})
    }

    const onContextMenu = (e: MouseEvent) => {
      // Links take precedence over right-click paste.
      const url = term.linkAtPointer?.(e) ?? null
      if (url) {
        e.preventDefault()
        setLinkMenu({ x: e.clientX, y: e.clientY, url, kind: 'url' })
        return
      }
      const path = term.pathAtPointer?.(e) ?? null
      if (path) {
        e.preventDefault()
        setLinkMenu({ x: e.clientX, y: e.clientY, url: path, kind: 'path' })
        return
      }
      if (!settingsRef.current.rightClickPaste) return
      e.preventDefault()
      pasteFromClipboard()
    }
    container.addEventListener('contextmenu', onContextMenu)

    const onKeyDown = (e: KeyboardEvent) => {
      // Autocomplete only claims keys while a suggestion is showing; Tab is never
      // claimed. `GhosttyInputHandler` skips `preventDefault`ed events.
      if (autocompleteRef.current?.handleKey(e)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      // Configurable chords (lib/keybindings.ts), on capture. Every branch must
      // consume what it claims: the key encoder encodes even Ctrl+Shift+C, and a
      // program may be listening for it.
      if (isRecordingShortcut()) return
      const action = actionForEvent(e, settingsRef.current.keybindings, 'pane')
      if (action === 'copy') {
        const text = term.getSelection()
        // Nothing selected: let the key through.
        if (!text) return
        e.preventDefault()
        e.stopPropagation()
        writeText(text).catch(() => {})
      } else if (action === 'paste') {
        // Independent of `rightClickPaste`, which only governs the mouse.
        e.preventDefault()
        e.stopPropagation()
        pasteFromClipboard()
      } else if (action === 'find') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      } else if (action === 'markMode') {
        e.preventDefault()
        e.stopPropagation()
        term.toggleMarkMode?.()
      } else if (action === 'paneDump') {
        // Bound to a key so the dump captures the state the moment a copy fault
        // is noticed.
        e.preventDefault()
        e.stopPropagation()
        const dump = term.dumpState?.()
        if (!dump) {
          toast.error('This pane has no engine to dump.')
          return
        }
        sessionLog
          .writePaneDump(labelRef.current, dump)
          .then((path) => toast.success(`Pane dump written to ${path}`))
          .catch((err) => toast.error(`Could not write the pane dump: ${String(err)}`))
      } else if (action === 'hintMode') {
        // The only link gesture that works while a program holds the mouse.
        e.preventDefault()
        e.stopPropagation()
        term.toggleHintMode?.()
      }
      // Escape is handled by the dismiss stack and never preventDefault'd here;
      // it has to reach the engine.
    }
    container.addEventListener('keydown', onKeyDown, true)

    // One per session; it remembers the last size sent.
    const ptyResize = createPtyResizeSender((cols, rows) => {
      if (!sessionId) return
      conn.resize(source, sessionId, cols, rows).catch(() => {})
    })

    const onResize = () => {
      // A hidden tab is 0x0; fitting to it would shrink the PTY and back on every
      // tab switch, desyncing the cursor.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      // Fit immediately so the canvas tracks the container during a drag.
      const gridBefore = `${term.cols}x${term.rows}`
      term.fit()
      reportDimensions(term)
      // A reflow invalidates absolute rows held about the current line.
      if (`${term.cols}x${term.rows}` !== gridBefore) {
        promptInput.noteResized()
        autocomplete.reset()
        historyRepeats.reset()
        historyFlicker.stop()
      }
      // The far end is told once the drag settles (see ptyResize.ts): each
      // intermediate SIGWINCH makes status-line programs leave stray copies.
      if (sessionId) ptyResize.post(term.cols, term.rows)
      // Force a full repaint: moving a pane between tabs re-parents its canvas,
      // which can clear the drawing buffer while the renderer thinks it's valid.
      term.rebuildWebglRenderer?.()
      term.refresh(0, term.rows - 1)
      updateScrollbarGeometry()
      updateThumb()
      // A non-zero resize also means a hidden tab became visible (App's refit()
      // dispatches one); refocus if this is the tab's active pane.
      if (activeRef.current) term.focus()
    }
    window.addEventListener('resize', onResize)
    refitRef.current = onResize

    // Refocus the active pane when the native window regains focus (Alt-Tab, a
    // dialog, Windows Hello). WebView2 emits no DOM focus event for this and
    // won't refocus the hidden textarea itself. Hidden tabs (0x0) are skipped.
    let unlistenFocus: (() => void) | null = null
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return
        if (!activeRef.current) return
        if (container.clientWidth === 0 || container.clientHeight === 0) return
        // Defer past WebView2's own focus restore, then re-check.
        requestAnimationFrame(() => {
          if (disposed || !activeRef.current) return
          if (container.clientWidth === 0 || container.clientHeight === 0) return
          // A dangling selection swallows input.
          window.getSelection()?.removeAllRanges()
          const refocusTarget = termRef.current
          // WebView2 can sever the IME context on deactivation, leaving printable
          // keys dead; resetInputContext rebuilds it.
          if (refocusTarget?.resetInputContext) refocusTarget.resetInputContext()
          else refocusTarget?.focus()
        })
      })
      .then((un) => {
        if (disposed) un()
        else unlistenFocus = un
      })

    // The container can resize without the window (e.g. the status footer).
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(container)

    return () => {
      disposed = true
      ptyResize.cancel()
      // Before the engine goes, so nothing drains into a freed core.
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
      pathListener?.dispose()
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
      // Both hold timers.
      historyRepeats.reset()
      historyFlicker.stop()
      for (const listener of oscListeners) listener.dispose()
      // Reported directly: the trackers' resets would be no-ops, leaving a
      // spinner on the tab.
      onActivityRef.current?.(IDLE)
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
    // `label` is display-only and the callbacks are read through refs, so only
    // a new source reconnects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  // Shared by the failed and disconnected overlays.
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

  // Read at render time: cell size and scroll position change independently
  // of the suggestion.
  const gridAnchor = (() => {
    if (!suggestion) return null
    const term = termRef.current
    const cell = term?.cellSize?.()
    if (!term || !cell || cell.width <= 0 || cell.height <= 0) return null
    return { cell, viewportY: term.viewportY, rows: term.rows, cols: term.cols }
  })()

  return (
    <div
      className="relative h-full w-full px-1.5 pt-3"
      // Painted from the same theme as the engine, so the padding can't drift.
      style={{ background: backgroundWithOpacity(paneTheme(settings), settings.backgroundOpacity) }}
      // File drops from Explorer, via DOM events (Tauri's drag-drop is off; it
      // breaks tab dragging). Only `Files` drags are handled here.
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!dropTarget) setDropTarget(true)
      }}
      onDragLeave={(e) => {
        // Leave also fires when moving onto a child.
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
        // Already confirmed this directory; see `confirmedDestRef`.
        if (cwd && cwd === confirmedDestRef.current) {
          void uploadFile(file, cwd)
          return
        }
        // Otherwise ask, prefilled with the reported directory, then one guessed
        // from the window title, then the last one typed.
        setDropDest({
          file,
          path: cwd ?? titleCwdRef.current ?? lastDestRef.current ?? '',
          source: cwd ? 'reported' : titleCwdRef.current ? 'title' : 'unknown',
        })
      }}
    >
      {/* One layer at the pane's opacity over everything the grid doesn't cover
          (padding, gutter, partial column and row), so the surroundings match the
          grid's compositing. Border-only so corners aren't painted twice. Under
          the container, whose stacking context holds the scrollbar. */}
      <div
        ref={frameRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          borderStyle: 'solid',
          borderWidth: 0,
          borderColor: backgroundWithOpacity(
            paneTheme(settings),
            settings.backgroundOpacity,
          ),
        }}
      />
      {/* Every pane in a broadcast group gets a ring: typing goes to all of them. */}
      {broadcasting && (
        <div className="pointer-events-none absolute inset-0 z-30 rounded-sm ring-2 ring-inset ring-amber-400/70" />
      )}
      <div ref={containerRef} className="relative h-full w-full">
        {/* Positioned against the grid. `overflow-hidden` keeps the list inside
            the pane (never over the status bar or a neighbor). */}
        {suggestion && gridAnchor && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {suggestion.mode === 'inline' ? (
              <InlineSuggestion
                view={suggestion}
                cell={gridAnchor.cell}
                viewportY={gridAnchor.viewportY}
                rows={gridAnchor.rows}
                cols={gridAnchor.cols}
                fontFamily={settings.fontFamily}
                fontSize={settings.fontSize}
              />
            ) : (
              <SuggestionPopover
                view={suggestion}
                cell={gridAnchor.cell}
                viewportY={gridAnchor.viewportY}
                rows={gridAnchor.rows}
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
        // Otherwise a failed pane has no way back to the connect dialog.
        <div className="animate-in fade-in absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#16171d] px-8 text-center text-xs text-chrome/60 duration-fast">
          <AlertTriangle size={20} className="text-red-400" />
          <p className="max-w-xs text-chrome/70">{connectFailed}</p>
          {disconnectActions}
        </div>
      )}
      {reconnecting && (
        // A strip, not a cover: the scrollback is why the pane didn't remount.
        <div className="animate-in fade-in slide-in-from-top-1 pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-2 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200/90 duration-fast">
          <Unplug size={13} className="animate-pulse" />
          <span>
            Connection lost — reconnecting in {reconnecting.inSeconds}s
            {reconnecting.attempt > 1 && ` (attempt ${reconnecting.attempt})`}
          </span>
        </div>
      )}
      {disconnected && !connectFailed && (
        // A clean disconnect with auto-close off.
        <div className="animate-in fade-in absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#16171d] px-8 text-center text-xs text-chrome/60 duration-fast">
          <Unplug size={20} className="text-chrome/40" />
          <p className="max-w-xs text-chrome/70">Connection closed.</p>
          {disconnectActions}
        </div>
      )}
      {engineFailed && (
        // Last of the overlays so DOM order paints it on top. A failed WASM core
        // otherwise leaves a silently blank pane.
        <div className="animate-in fade-in absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#16171d] px-8 text-center text-xs text-chrome/60 duration-fast">
          <AlertTriangle size={20} className="text-red-400" />
          <p className="max-w-xs text-chrome/70">This pane's terminal renderer failed to start.</p>
          <p className="max-w-xs text-chrome/40">{engineFailed}</p>
          <p className="max-w-xs text-chrome/40">Details are in the application log.</p>
        </div>
      )}
      {markMode && (
        // Bottom-left, clear of the search bar; spells out the keys since the mode
        // swallows typing.
        <div className="animate-in fade-in slide-in-from-bottom-1 pointer-events-none absolute bottom-2 left-2 z-40 flex items-center gap-2 rounded-lg border border-chrome/10 bg-surface px-2 py-1.5 text-xs text-chrome/70 shadow-xl duration-fast ease-swift">
          <TextCursorInput size={13} className="text-emerald-400" />
          <span className="font-medium">Mark</span>
          <span className="text-chrome/40">Shift+arrows select · Enter copies · Esc exits</span>
        </div>
      )}
      {hintMode && (
        // Same as mark mode's indicator.
        <div className="animate-in fade-in slide-in-from-bottom-1 pointer-events-none absolute bottom-2 left-2 z-40 flex items-center gap-2 rounded-lg border border-chrome/10 bg-surface px-2 py-1.5 text-xs text-chrome/70 shadow-xl duration-fast ease-swift">
          <ExternalLink size={13} className="text-amber-400" />
          <span className="font-medium">Links</span>
          <span className="text-chrome/40">Type a label to open · Esc exits</span>
        </div>
      )}
      {dropTarget && canUpload && (
        // A ring, not a cover, so the prompt's directory stays visible.
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
        // Confirm the destination: once per directory, and again when it changes.
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
        // The URL is shown in full before anything opens it.
        <>
          {/* A click anywhere else closes it without reaching the terminal. */}
          <div className="fixed inset-0 z-40" onMouseDown={() => setLinkMenu(null)} />
          <div
            className="animate-in fade-in zoom-in-95 fixed z-50 max-w-xs origin-top-left rounded-md border border-chrome/10 bg-surface py-1 text-xs text-chrome/80 shadow-xl duration-100"
            style={{ left: linkMenu.x, top: linkMenu.y }}
          >
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 hover:bg-chrome/10"
              onClick={() => {
                if (linkMenu.kind === 'path') onOpenPathRef.current?.(linkMenu.url)
                else termRef.current?.openLink?.(linkMenu.url)
                setLinkMenu(null)
              }}
            >
              {linkMenu.kind === 'path' ? (
                <>
                  <FolderOpen size={13} />{' '}
                  {/* A local path opens here; a remote one can only be shown. */}
                  {canUpload ? 'Show in files' : 'Open'}
                </>
              ) : (
                <>
                  <ExternalLink size={13} /> Open link
                </>
              )}
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 hover:bg-chrome/10"
              onClick={() => {
                writeText(linkMenu.url).catch(() => {})
                setLinkMenu(null)
              }}
            >
              <Copy size={13} /> {linkMenu.kind === 'path' ? 'Copy path' : 'Copy link'}
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
              } else if (actionForEvent(e, settings.keybindings, 'pane') === 'find') {
                // The input is a sibling of the container, so the pane's capture handler
                // never sees this; repeat the binding so the chord also closes.
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
          {altScreen && (
            <span
              className="mr-1 shrink-0 whitespace-nowrap rounded bg-amber-400/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-amber-200/90"
              title="A full-screen program has the terminal, and its screen has no scrollback. Only what is on screen right now can be searched -- scrolling inside the program repaints these rows rather than keeping the old ones. Use the program's own search (tmux copy-mode, or / in vim and less)."
            >
              screen only
            </span>
          )}
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
          knownKeys={hostKeyPrompt.knownKeys}
          onAnswer={(accept) => {
            conn.respondHostKey(hostKeyPrompt.requestId, accept)
            setHostKeyPrompt(null)
            // The dialog's button took focus; return it to the terminal.
            termRef.current?.focus()
          }}
        />
      )}
      {authPrompt && (
        <AuthPrompt
          // Keyed per request so a multi-step exchange doesn't carry the previous
          // round's values into the next (e.g. a password into a code field).
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
            // Same focus handoff as the host-key dialog.
            termRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}
