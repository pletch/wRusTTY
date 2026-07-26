import { useEffect, useRef, useState } from 'react'
import type { TerminalEngine } from '../lib/terminalEngine'
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
} from 'lucide-react'
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager'
import { error as logError } from '@tauri-apps/plugin-log'
import { getCurrentWindow } from '@tauri-apps/api/window'
import * as conn from '../lib/connection'
import type { ConnectionSource, ConnEvent } from '../lib/connection'
import * as sessionLog from '../lib/logging'
import type { TerminalSettings } from '../lib/settings'
import { findTheme, backgroundWithOpacity, hexToRgb } from '../lib/theme'
import { HostKeyPrompt } from './HostKeyPrompt'
import { LineEditor, parseHexLine } from '../lib/lineEditor'
import * as deliveryStats from '../lib/deliveryStats'
import { createWriteScheduler } from '../lib/writeScheduler'
import { CommandTracker, IDLE } from '../lib/shellIntegration'
import type { CommandActivity, CommandResult } from '../lib/shellIntegration'

/** Matches .term-scrollbar-inner's width in index.css. */
const SCROLLBAR_WIDTH = 8

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
  logging?: boolean
  /** Whether this is the focused pane within its (possibly split) tab. */
  active?: boolean
  /** This pane's id, so a targeted searchRequest can address exactly it. */
  paneId: string
  /** Set by App's toolbar search button. When it targets this pane's id with
   * a nonce not seen before, the search box opens (the box is per-Terminal
   * local state, so this is how an App-level control reaches into it). */
  searchRequest?: { nonce: number; paneId: string } | null
  onStatus?: (status: string) => void
  onSessionId?: (id: string | null) => void
  /** Whether a command is currently running, per the remote shell's own OSC
   * 133 reports — silent (permanently idle) against a shell with no
   * integration set up. See lib/shellIntegration.ts. */
  onActivity?: (activity: CommandActivity) => void
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

function countLines(text: string): number {
  return text.split(/\r\n|\r|\n/).length
}

export function Terminal({
  source,
  label,
  settings,
  backspaceSendsCtrlH,
  logging,
  active,
  paneId,
  searchRequest,
  onStatus,
  onSessionId,
  onActivity,
  onCommandComplete,
  onBell,
  onBackToConnect,
  onReconnect,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const termRef = useRef<TerminalEngine | null>(null)
  const [hostKeyPrompt, setHostKeyPrompt] = useState<PendingHostKey | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // Result position for the "N/M" count, fed by the addon's onDidChangeResults
  // (set up in the connect effect). index is 0-based, -1 when there are none.
  const [searchResults, setSearchResults] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0,
  })
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

  // Same live-ref treatment as onStatus/onSessionId above — App passes these
  // as fresh inline closures every render, and the connect effect must not
  // list anything that changes per-render in its dependencies.
  const onActivityRef = useRef(onActivity)
  onActivityRef.current = onActivity

  const onCommandCompleteRef = useRef(onCommandComplete)
  onCommandCompleteRef.current = onCommandComplete

  const onBellRef = useRef(onBell)
  onBellRef.current = onBell

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
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.setFont(settings.fontFamily, settings.fontSize)
    // term.options.fontFamily = settings.fontFamily
        term.setScrollback( settings.scrollback)
    term.setCursorStyle(settings.cursorStyle, settings.cursorBlink)
    refitRef.current?.()
  }, [
    settings.fontFamily,
    settings.fontSize,
    settings.scrollback,
    settings.cursorStyle,
    settings.cursorBlink,
  ])

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
    }
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
    term.setFont(settingsRef.current.fontFamily, settingsRef.current.fontSize)
    term.setScrollback(settingsRef.current.scrollback)
    term.setCursorStyle(settingsRef.current.cursorStyle, settingsRef.current.cursorBlink)

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

    // Custom scrollbar overlay — xterm.js's own scrollbar widget explicitly
    // doesn't support arrow buttons (its bundled source throws if
    // `verticalHasArrows` is ever set), so this rebuilds one that does,
    // styled to match native Windows console scrollbars. See the
    // .term-scrollbar-* rules in index.css, which also hide xterm's own
    // scrollbar entirely so the two don't overlap.
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
      const width = Math.min(Math.max(gap, SCROLLBAR_WIDTH), SCROLLBAR_WIDTH * 8)
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

    const scrollListener = term.onScroll(() => updateThumb())
    const writeParsedListener = term.onWriteParsed(() => updateThumb())

    // Shell integration. Nothing here fires unless the far end is actually
    // emitting OSC 133/633 — an un-integrated shell (or a switch console,
    // which will never have one) simply leaves the tracker idle forever, so
    // there's no setting gating the tracking itself, only the notifications
    // it can produce. Both identifiers get the same handler: OSC 633 is
    // VS Code's superset of the same letters, and a shell configured for
    // one commonly emits the other alongside it.
    const tracker = new CommandTracker({
      onChange: (activity) => {
        if (!disposed) onActivityRef.current?.(activity)
      },
      onComplete: (result) => {
        if (!disposed) onCommandCompleteRef.current?.(result)
      },
    })
    const oscListeners = [133, 633].map((ident) =>
      term.registerOscHandler(ident, (data) => tracker.handleOsc(data)),
    )
    // Entering the alternate screen mid-command means a full-screen program
    // took over (vim, top, less). Recorded on the run so the completion it
    // eventually reports can be recognized as "you quit an editor", not "a
    // batch job you were waiting on has landed".
    const bufferListener = term.onBufferChange((isAlternate) => {
      tracker.setAltScreen(isAlternate)
    })
    const bellListener = term.onBell(() => {
      if (!disposed) onBellRef.current?.()
    })

    const onEvent = (event: ConnEvent) => {
      if (disposed) return
      setConnecting(false)
      switch (event.type) {
        case 'status':
          onStatusRef.current?.(event.status)
          if (event.status.startsWith('failed') || event.status === 'disconnected') {
            term.writeln(`\r\n[${event.status}]`)
            // Whatever was running went down with the connection. Its real
            // outcome is unknowable from here, so drop it silently rather
            // than leaving the tab spinning or claiming a completion.
            tracker.reset()
          }
          if (event.status.startsWith('failed')) {
            setConnectFailed(event.status.replace(/^failed: /, ''))
          } else if (event.status === 'disconnected' && !settingsRef.current.closeOnDisconnect) {
            // When auto-close is on, App closes the pane instead — no overlay
            // (it'd only flash for the ~800ms before the pane vanishes).
            setDisconnected(true)
          }
          break
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
      .connect(source, onEvent, onData, cols, rows)
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
            const { cols, rows } = termRef.current
            conn.resize(source, id, cols, rows).catch(() => {})
          }
        }, 100)
      
        sessionId = id
        sessionIdRef.current = id
        onSessionIdRef.current?.(id)
        const { cols, rows } = term
        conn.resize(source, id, cols, rows).catch(() => {})
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
        // Not translated: the line editor is local and matches on xterm's own
        // ^? for its own editing. What it eventually sends is a finished
        // line, which never contains a backspace anyway.
        lineEditor.handleData(data)
        return
      }
      // Applied here rather than via a key handler so it covers every route
      // xterm takes to produce the byte, and only on what actually goes out
      // on the wire. Null means the session never expressed a preference,
      // which is ^? — what modern Unix expects.
      const out = backspaceRef.current ? data.replaceAll('\x7f', '\b') : data
      if (sessionId) conn.write(source, sessionId, new TextEncoder().encode(out))
    })

    const selectionListener = term.onSelectionChange(() => {
      if (!settingsRef.current.copyOnSelect) return
      const text = term.getSelection()
      if (text) writeText(text).catch(() => {})
    })

    const onContextMenu = (e: MouseEvent) => {
      if (!settingsRef.current.rightClickPaste) return
      e.preventDefault()
      readText()
        .then((text) => {
          if (!text) return
          const lines = countLines(text)
          if (lines > 1) {
            const ok = window.confirm(`Paste ${lines} lines into the terminal?`)
            if (!ok) return
          }
          term.paste(text)
        })
        .catch(() => {})
    }
    container.addEventListener('contextmenu', onContextMenu)

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      } else if (e.key === 'Escape') {
        setSearchOpen(false)
      }
    }
    container.addEventListener('keydown', onKeyDown, true)

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
      term.fit()
      if (sessionId) conn.resize(source, sessionId, term.cols, term.rows).catch(() => {})
      // Guarding against the 0x0 fit stopped the PTY-side desync, but the
      // canvas can still end up visually stale after this — most sharply
      // when a pane is dragged between tabs, since that detaches and
      // reattaches its DOM node elsewhere (React portal retargeting), and
      // detaching/reattaching a WebGL canvas can silently clear its actual
      // drawing buffer even though the JS-level context survives. xterm's
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
          const term = termRef.current
          // Window deactivation can sever the input element's IME/input context
          // in WebView2 so a plain focus() leaves printable input dead (only
          // Enter/arrows work). resetInputContext rebuilds it; fall back to
          // focus() for engines that don't need it.
          if (term?.resetInputContext) term.resetInputContext()
          else term?.focus()
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
    // xterm's row count stale and its rendering overlapping whatever
    // ends up occupying the space it no longer actually has.
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(container)

    return () => {
      disposed = true
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
      dataListener.dispose()
      scrollListener.dispose()
      writeParsedListener.dispose()
      searchResultsListener.dispose()
      initErrorListener?.dispose()
      bellListener.dispose()
      bufferListener.dispose()
      for (const listener of oscListeners) listener.dispose()
      // Reported directly rather than through the tracker (whose own reset
      // is a no-op when nothing was running) so a pane torn down mid-command
      // can't leave a spinner behind on a tab that no longer has a session.
      onActivityRef.current?.(IDLE)
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
          className="rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium text-white/80 transition-colors duration-fast ease-swift hover:bg-white/15 hover:text-white"
        >
          Connection settings
        </button>
      )}
    </div>
  )

  return (
    <div
      className="relative h-full w-full px-1.5 pt-3"
      // Painted here, from the exact same findTheme() call that configures
      // xterm's own theme a few lines up, rather than duplicated in a
      // separate wrapper — one source of truth means this padding can
      // never drift out of sync with whatever the terminal itself paints,
      // which a previous attempt at this (matching color one level up, in
      // App.tsx) did the moment a non-default theme was actually tested.
      style={{ background: backgroundWithOpacity(findTheme(settings.themeName), settings.backgroundOpacity) }}
    >
      <div ref={containerRef} className="relative h-full w-full" />
      {connecting && (
        <div className="animate-in fade-in pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#16171d] text-xs text-white/50 duration-150">
          <Loader2 size={20} className="animate-spin text-sky-400" />
          Connecting to {label}...
        </div>
      )}
      {connectFailed && (
        // Otherwise a failed connection (bad credential, unreachable host,
        // etc.) leaves this pane stuck showing a dead terminal with no way
        // back to the connect dialog short of closing the whole pane —
        // which, in a split, takes any sibling panes down with it too.
        <div className="animate-in fade-in absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#16171d] px-8 text-center text-xs text-white/60 duration-fast">
          <AlertTriangle size={20} className="text-red-400" />
          <p className="max-w-xs text-white/70">{connectFailed}</p>
          {disconnectActions}
        </div>
      )}
      {disconnected && !connectFailed && (
        // A clean remote-initiated disconnect with auto-close turned off:
        // offer to reconnect or reopen the connect dialog rather than leaving
        // a dead terminal behind.
        <div className="animate-in fade-in absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#16171d] px-8 text-center text-xs text-white/60 duration-fast">
          <Unplug size={20} className="text-white/40" />
          <p className="max-w-xs text-white/70">Connection closed.</p>
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
        <div className="animate-in fade-in absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#16171d] px-8 text-center text-xs text-white/60 duration-fast">
          <AlertTriangle size={20} className="text-red-400" />
          <p className="max-w-xs text-white/70">This pane's terminal renderer failed to start.</p>
          <p className="max-w-xs text-white/40">{engineFailed}</p>
          <p className="max-w-xs text-white/40">Details are in the application log.</p>
        </div>
      )}
      {searchOpen && (
        <div className="animate-in fade-in slide-in-from-top-1 absolute right-2 top-2 z-40 flex items-center gap-0.5 rounded-lg border border-white/10 bg-[#1f2028] px-2 py-1.5 text-xs shadow-xl duration-fast ease-swift">
          <Search size={13} className="mr-1 text-white/40" />
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
              } else if (e.key === 'Escape') {
                setSearchOpen(false)
              }
            }}
            placeholder="Find..."
            className="w-40 bg-transparent text-white/90 outline-none placeholder:text-white/30"
          />
          <span className="mx-1 min-w-[3.25rem] shrink-0 text-right tabular-nums text-white/40">
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
                : 'text-white/50 hover:bg-white/10 hover:text-white/90'
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
                : 'text-white/50 hover:bg-white/10 hover:text-white/90'
            }`}
            title="Use regular expression"
          >
            <Regex size={14} />
          </button>
          <button
            onClick={() => runSearch(searchQuery, { back: true })}
            className="flex items-center justify-center rounded p-1 text-white/50 transition-colors duration-fast ease-swift hover:bg-white/10 hover:text-white/90"
            title="Previous (Shift+Enter)"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={() => runSearch(searchQuery)}
            className="flex items-center justify-center rounded p-1 text-white/50 transition-colors duration-fast ease-swift hover:bg-white/10 hover:text-white/90"
            title="Next (Enter)"
          >
            <ChevronDown size={14} />
          </button>
          <button
            onClick={() => setSearchOpen(false)}
            className="flex items-center justify-center rounded p-1 text-white/50 transition-colors duration-fast ease-swift hover:bg-white/10 hover:text-white/90"
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
    </div>
  )
}
