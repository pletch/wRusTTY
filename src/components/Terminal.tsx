import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
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
import '@xterm/xterm/css/xterm.css'
import * as conn from '../lib/connection'
import type { ConnectionSource, ConnEvent } from '../lib/connection'
import * as sessionLog from '../lib/logging'
import type { TerminalSettings } from '../lib/settings'
import { findTheme, backgroundWithOpacity, hexToRgb } from '../lib/theme'
import { HostKeyPrompt } from './HostKeyPrompt'
import { LineEditor, parseHexLine } from '../lib/lineEditor'

interface Props {
  source: ConnectionSource
  label: string
  settings: TerminalSettings
  /** Overrides `settings.backspaceSendsCtrlH` for this pane. `null`/absent
   * follows the global setting — which is what every session did before the
   * option became per-session, so existing profiles keep their behaviour. */
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
  /** A failed connection (bad credential, unreachable host, etc.) otherwise
   * leaves this pane stuck showing a dead terminal with no way back to the
   * connect dialog short of closing the whole pane — this reopens it in
   * place instead. */
  onBackToConnect?: () => void
  /** Retry the same connection in place — surfaced on the failed/disconnected
   * overlays as a "Reconnect" action. */
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

function themeWithOpacity(themeName: string, opacity: number) {
  const theme = findTheme(themeName)
  return { ...theme, background: backgroundWithOpacity(theme, opacity) }
}

// Passing `decorations` to the search addon is what turns on highlight-*all*
// (every match painted, not just the one the viewport jumped to). Amber reads
// as "search hit" on any preset theme without colliding with the sky accent
// the app uses for focus/selection; the active match is the brighter fill.
// The overview-ruler fields are required by the addon whenever decorations
// are supplied — they mark hits in xterm's own right gutter, which this app's
// custom scrollbar overlay largely masks, but they're harmless to include.
const SEARCH_DECORATIONS = {
  matchBackground: '#5c4a1c',
  matchOverviewRuler: '#d9a441',
  activeMatchBackground: '#d9a441',
  activeMatchColorOverviewRuler: '#ffd479',
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
  onBackToConnect,
  onReconnect,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
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

  // Theme updates apply live to the existing terminal instance instead of
  // tearing down and reconnecting the session.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = themeWithOpacity(settings.themeName, settings.backgroundOpacity)
    }
    updateScrollbarColorsRef.current?.()
  }, [settings.themeName, settings.backgroundOpacity])

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
    const addon = searchAddonRef.current
    if (!addon) return
    if (!query) {
      addon.clearDecorations()
      setSearchResults({ index: -1, count: 0 })
      return
    }
    const options = {
      caseSensitive: opts.caseSensitive ?? searchCaseSensitive,
      regex: opts.regex ?? searchRegex,
      incremental: opts.incremental,
      decorations: SEARCH_DECORATIONS,
    }
    try {
      if (opts.back) addon.findPrevious(query, options)
      else addon.findNext(query, options)
    } catch {
      // A half-typed regex (e.g. an unclosed group) throws — treat it as
      // simply "no matches yet" until it becomes valid.
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
      searchAddonRef.current?.clearDecorations()
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

    const term = new XTerm({
      cursorBlink: true,
      // When this terminal isn't the focused one (e.g. the other half of a
      // split), xterm dims its cursor to a hollow outline instead of a solid
      // block — a zero-cost, natively-rendered reinforcement of which pane is
      // active that pairs with the sky focus ring drawn in Pane.tsx.
      cursorInactiveStyle: 'outline',
      fontFamily: 'ui-monospace, Consolas, monospace',
      fontSize: 14,
      // xterm.js defaults to 1000 — counted in wrapped rows, not logical
      // lines, so verbose output with long lines (dmesg, etc.) fills that
      // up in well under 1000 actual lines.
      scrollback: 10000,
      // Harmless at the default opacity of 1 (an alpha-1 color renders
      // identically either way) — always on so a live opacity change via
      // the settings effect above doesn't need to also recreate the
      // terminal just to flip this.
      allowTransparency: true,
      // Required by the search addon's highlight-all decorations: they call
      // the core registerDecoration API, which is gated behind this flag and
      // throws ("You must set the allowProposedApi option to true") without
      // it — which the search box's try/catch would otherwise swallow as a
      // silent "no results".
      allowProposedApi: true,
      theme: themeWithOpacity(settingsRef.current.themeName, settingsRef.current.backgroundOpacity),
    })
    termRef.current = term

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    searchAddonRef.current = searchAddon
    // Drives the "N/M" match count in the search box. resultIndex is -1 with
    // no matches; the UI turns that into "None".
    const searchResultsListener = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (disposed) return
      setSearchResults({ index: resultIndex, count: resultCount })
    })
    term.open(container)

    // A lost GPU context (driver reset, resource exhaustion — plausible with
    // several terminals' worth of WebGL contexts open at once, since every
    // tab's panes stay mounted regardless of visibility) otherwise leaves a
    // terminal rendering a blank/corrupted canvas forever, since nothing
    // else notices or recovers. Disposing on loss just drops back to
    // xterm's own canvas renderer for the rest of this session, matching
    // what happens when WebGL wasn't available to begin with. Pulled out
    // as its own function since onResize below needs to redo this same
    // setup when it tears down and rebuilds the addon after a move.
    //
    // Always attempted regardless of vibrancy/opacity settings: WebView2 on
    // Windows composites a hardware-accelerated canvas as opaque against a
    // transparent window no matter which xterm renderer draws it (confirmed
    // on real hardware — the opacity slider had zero visible effect on
    // these panes under Canvas 2D either), so there's no transparency
    // benefit left to trade WebGL's performance away for.
    function loadWebgl(): WebglAddon | null {
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          addon.dispose()
          if (webglAddon === addon) webglAddon = null
        })
        term.loadAddon(addon)
        return addon
      } catch {
        // WebGL unavailable — xterm falls back to its canvas renderer.
        return null
      }
    }
    let webglAddon = loadWebgl()

    fitAddon.fit()

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
    const updateScrollbarGeometry = () => {
      let canvasRight = 0
      for (const canvas of container.querySelectorAll('canvas')) {
        const rect = canvas.getBoundingClientRect()
        if (rect.width > 0) canvasRight = Math.max(canvasRight, rect.right)
      }
      if (canvasRight === 0) return
      const width = container.getBoundingClientRect().right - canvasRight
      if (width > 0) scrollbarEl.style.width = `${width}px`
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
      const total = term.buffer.active.length
      const rows = term.rows
      hasOverflow = total > rows
      applyScrollbarVisibility()
      if (!hasOverflow) return
      const trackHeight = track.clientHeight
      const thumbHeight = Math.max(20, (rows / total) * trackHeight)
      const maxScroll = total - rows
      const maxThumbTop = trackHeight - thumbHeight
      const thumbTop = maxScroll > 0 ? (term.buffer.active.viewportY / maxScroll) * maxThumbTop : 0
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
      const maxScroll = term.buffer.active.length - term.rows
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

    const onEvent = (event: ConnEvent) => {
      if (disposed) return
      setConnecting(false)
      switch (event.type) {
        case 'status':
          onStatusRef.current?.(event.status)
          if (event.status.startsWith('failed') || event.status === 'disconnected') {
            term.writeln(`\r\n[${event.status}]`)
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
    const onData = (bytes: Uint8Array) => {
      if (disposed) return
      setConnecting(false)
      term.write(bytes)
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

    conn
      .connect(source, onEvent, onData)
      .then((id) => {
        if (disposed) {
          conn.disconnect(source, id).catch(() => {})
          return
        }
        setConnecting(false)
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
      // on the wire. The per-session value wins when set; null means this
      // session never expressed a preference, so follow the global one.
      const ctrlH = backspaceRef.current ?? settingsRef.current.backspaceSendsCtrlH
      const out = ctrlH ? data.replaceAll('\x7f', '\b') : data
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
      fitAddon.fit()
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
      if (webglAddon) {
        webglAddon.dispose()
        webglAddon = loadWebgl()
      }
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
      window.removeEventListener('resize', onResize)
      resizeObserver.disconnect()
      container.removeEventListener('contextmenu', onContextMenu)
      container.removeEventListener('keydown', onKeyDown, true)
      selectionListener.dispose()
      dataListener.dispose()
      scrollListener.dispose()
      writeParsedListener.dispose()
      searchResultsListener.dispose()
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
      searchAddonRef.current = null
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
      <div ref={containerRef} className="h-full w-full" />
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
