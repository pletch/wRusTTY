import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { Search, ChevronUp, ChevronDown, X, Loader2 } from 'lucide-react'
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager'
import '@xterm/xterm/css/xterm.css'
import * as conn from '../lib/connection'
import type { ConnectionSource, ConnEvent } from '../lib/connection'
import * as sessionLog from '../lib/logging'
import type { TerminalSettings } from '../lib/settings'
import { findTheme, backgroundWithOpacity } from '../lib/theme'
import { HostKeyPrompt } from './HostKeyPrompt'
import { LineEditor, parseHexLine } from '../lib/lineEditor'

interface Props {
  source: ConnectionSource
  label: string
  settings: TerminalSettings
  logging?: boolean
  /** Whether this is the focused pane within its (possibly split) tab. */
  active?: boolean
  onStatus?: (status: string) => void
  onSessionId?: (id: string | null) => void
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

export function Terminal({
  source,
  label,
  settings,
  logging,
  active,
  onStatus,
  onSessionId,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const [hostKeyPrompt, setHostKeyPrompt] = useState<PendingHostKey | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // Reinitializes to true on every mount, which is what we want — Pane.tsx
  // remounts this component (via a `key` bump) on every reconnect.
  const [connecting, setConnecting] = useState(true)

  // Settings can change without reconnecting the session, so they're read
  // through a ref rather than added to the effect's dependency array.
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const loggingRef = useRef(logging)
  loggingRef.current = logging

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

  // Theme updates apply live to the existing terminal instance instead of
  // tearing down and reconnecting the session.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = themeWithOpacity(settings.themeName, settings.backgroundOpacity)
    }
  }, [settings.themeName, settings.backgroundOpacity])

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    let sessionId: string | null = null
    let loggingActive = false

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, Consolas, monospace',
      fontSize: 14,
      // Harmless at the default opacity of 1 (an alpha-1 color renders
      // identically either way) — always on so a live opacity change via
      // the settings effect above doesn't need to also recreate the
      // terminal just to flip this.
      allowTransparency: true,
      theme: themeWithOpacity(settingsRef.current.themeName, settingsRef.current.backgroundOpacity),
    })
    termRef.current = term

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    searchAddonRef.current = searchAddon
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

    const onEvent = (event: ConnEvent) => {
      if (disposed) return
      setConnecting(false)
      switch (event.type) {
        case 'status':
          onStatusRef.current?.(event.status)
          if (event.status.startsWith('failed') || event.status === 'disconnected') {
            term.writeln(`\r\n[${event.status}]`)
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
        onSessionIdRef.current?.(id)
        const { cols, rows } = term
        conn.resize(source, id, cols, rows).catch(() => {})
        // So you can start typing immediately instead of having to click
        // into the pane first — this is the point a new connection is
        // actually usable.
        term.focus()
        lineEditor?.start()
        if (loggingRef.current) {
          sessionLog
            .start(id, label)
            .then(() => {
              loggingActive = true
            })
            .catch(() => {})
        }
      })
      .catch((err) => {
        if (!disposed) {
          setConnecting(false)
          term.writeln(`\r\n[connect error] ${String(err)}`)
        }
      })

    const dataListener = term.onData((data) => {
      if (lineEditor) {
        lineEditor.handleData(data)
        return
      }
      if (sessionId) conn.write(source, sessionId, new TextEncoder().encode(data))
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
      if (sessionId) {
        conn.disconnect(source, sessionId).catch(() => {})
        if (loggingActive) sessionLog.stop(sessionId).catch(() => {})
      }
      onSessionIdRef.current?.(null)
      termRef.current = null
      searchAddonRef.current = null
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
      {searchOpen && (
        <div className="animate-in fade-in slide-in-from-top-1 absolute right-2 top-2 z-40 flex items-center gap-0.5 rounded-lg border border-white/10 bg-[#1f2028] px-2 py-1.5 text-xs shadow-xl duration-100">
          <Search size={13} className="mr-1 text-white/40" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              searchAddonRef.current?.findNext(e.target.value, { incremental: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.shiftKey) searchAddonRef.current?.findPrevious(searchQuery)
                else searchAddonRef.current?.findNext(searchQuery)
              } else if (e.key === 'Escape') {
                setSearchOpen(false)
              }
            }}
            placeholder="Find..."
            className="w-40 bg-transparent text-white/90 outline-none placeholder:text-white/30"
          />
          <button
            onClick={() => searchAddonRef.current?.findPrevious(searchQuery)}
            className="flex items-center justify-center rounded p-1 text-white/50 transition-colors duration-100 hover:bg-white/10 hover:text-white/90"
            title="Previous (Shift+Enter)"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={() => searchAddonRef.current?.findNext(searchQuery)}
            className="flex items-center justify-center rounded p-1 text-white/50 transition-colors duration-100 hover:bg-white/10 hover:text-white/90"
            title="Next (Enter)"
          >
            <ChevronDown size={14} />
          </button>
          <button
            onClick={() => setSearchOpen(false)}
            className="flex items-center justify-center rounded p-1 text-white/50 transition-colors duration-100 hover:bg-white/10 hover:text-white/90"
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
