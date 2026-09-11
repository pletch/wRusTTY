import { useEffect, useState } from 'react'
import { ScrollText, Zap } from 'lucide-react'
import * as serial from '../lib/serial'
import { parseReconnecting } from '../lib/connection'
import { toast } from '../lib/toast'
import { estimateScrollbackRows } from '../lib/ghostty/GhosttyEngine'

/** Same status→color mapping as the tab dot (TabBar.statusDotColor), plus a
 * muted resting color for "no active connection" so the bar reads as a stable
 * anchor rather than blinking in and out. */
function statusDotColor(status: string | undefined): string {
  if (status === 'connected') return 'bg-emerald-400'
  if (!status) return 'bg-chrome/25'
  if (status.startsWith('failed') || status === 'disconnected' || status === 'lost') {
    return 'bg-red-400'
  }
  return 'bg-amber-400'
}

function statusLabel(status: string | undefined): string {
  if (!status) return 'Not connected'
  // The backend sends "failed: <reason>" — the reason already surfaces as a
  // toast (see App.tsx), so the bar just needs the short state word.
  if (status.startsWith('failed')) return 'Failed'
  // ...but the countdown is the whole content of this one: "this will come
  // back on its own in 8 seconds" is a different thing to be told than "this
  // is hung", which is the distinction the status exists to draw.
  const retry = parseReconnecting(status)
  if (retry) return `Reconnecting in ${retry.inSeconds}s`
  if (status === 'lost') return 'Connection lost'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

/** Rows at a glance. The estimate is ±7% at worst, so more than two
 *  significant digits would be false precision — hence `~` wherever it's
 *  rendered. */
function formatRows(rows: number): string {
  if (rows >= 10000) return `${Math.round(rows / 1000)}k`
  if (rows >= 1000) return `${(rows / 1000).toFixed(1)}k`
  return String(rows)
}

/** Spelled out in full on hover, because the bar itself can't afford to be.
 *  `120×40` is ambiguous without naming the axes, and `~13k` means nothing at
 *  all until you know it's scrollback and that it moves when you resize. */
function sizeTitle(dimensions: { cols: number; rows: number }, depth: number | null): string {
  const size = `Terminal size: ${dimensions.cols} columns x ${dimensions.rows} rows — what the remote end has been told`
  if (depth === null) return size
  return `${size}\nScrollback: roughly ${depth.toLocaleString()} rows at this width. A wider pane holds fewer; the limit is memory, set in Settings.`
}

function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

interface Props {
  /** Display-ready protocol tag ("SSH"/"TELNET"/"SERIAL") for the active
   * pane, or null when it has no connection source (a blank ConnectDialog). */
  protocol: string | null
  /** Host/target detail already resolved for display (user@host, port name +
   * framing, etc.). */
  target: string | null
  status: string | undefined
  /** Epoch ms when the active pane reached 'connected', or null. Drives the
   * live uptime readout. */
  connectedAt: number | null
  logging: boolean
  /** What the active pane's far end calls itself (OSC 0/2), and the directory
   * it last reported (OSC 7) — null until it says, which is the resting state
   * for anything that never does.
   *
   * Shown beside the connection's own identifiers rather than in place of
   * them, and styled below them: this is text the remote end chose, sharing a
   * bar with the fields that say what you are actually connected to. It must
   * not be able to pass itself off as one of those. See lib/remoteIdentity.ts. */
  remoteTitle: string | null
  remoteCwd: string | null
  /** The active pane's grid in cells, or null before its engine has fitted.
   *
   * Worth a permanent slot rather than a transient overlay on resize (the
   * usual idiom): on network gear you set `terminal width`/`terminal length`
   * by hand to match the client, and you need the numbers at the moment you
   * type them, not at the moment you resized. It is also the only place the
   * width is visible, and width decides scrollback depth — see
   * `scrollbackBudgetBytesFor`. */
  dimensions: { cols: number; rows: number } | null
  /** Bytes of scrollback the active pane's engine was built with, or null
   * before it has reported. Paired with `dimensions` to estimate depth — both
   * are needed, since the same budget is worth very different depths at
   * different widths, which is the whole reason the setting is memory. */
  scrollbackBudgetBytes: number | null
  /** 1-based position of the active pane among its tab's panes, and the total.
   * The pane readout is only shown when the tab is actually split. */
  paneIndex: number
  paneCount: number
  tabCount: number
  /** Backend session id of the active pane when it is a *connected serial*
   * session, else null. Gates the line-control cluster below — these are
   * physical signals on a real port, so there must be no way to reach them
   * for an SSH pane or a serial pane that isn't open. */
  serialSessionId: string | null
}

export function StatusBar({
  protocol,
  target,
  status,
  connectedAt,
  logging,
  remoteTitle,
  remoteCwd,
  dimensions,
  scrollbackBudgetBytes,
  paneIndex,
  paneCount,
  tabCount,
  serialSessionId,
}: Props) {
  // DTR and RTS are level-triggered and the port has no way to report their
  // current state back, so this tracks what we last asserted. Both idle high,
  // which is what opening a port leaves them at.
  const [dtr, setDtr] = useState(true)
  const [rts, setRts] = useState(true)
  const [breaking, setBreaking] = useState(false)

  useEffect(() => {
    setDtr(true)
    setRts(true)
  }, [serialSessionId])

  async function toggleLine(line: 'dtr' | 'rts') {
    if (!serialSessionId) return
    const next = line === 'dtr' ? !dtr : !rts
    try {
      if (line === 'dtr') {
        await serial.setDtr(serialSessionId, next)
        setDtr(next)
      } else {
        await serial.setRts(serialSessionId, next)
        setRts(next)
      }
    } catch (err) {
      toast.error(String(err))
    }
  }

  async function doSendBreak() {
    if (!serialSessionId || breaking) return
    setBreaking(true)
    try {
      await serial.sendBreak(serialSessionId)
      toast.info('Break sent')
    } catch (err) {
      toast.error(String(err))
    } finally {
      setBreaking(false)
    }
  }
  // Re-render once a second to advance the uptime clock — but only while
  // there's a connection to measure, so an idle bar never spins a timer.
  const [, tick] = useState(0)
  useEffect(() => {
    if (connectedAt == null) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [connectedAt])

  const uptime = connectedAt != null ? formatUptime(Date.now() - connectedAt) : null

  // Needs both halves: a budget with no width has no depth to report yet.
  const scrollbackDepth =
    dimensions && scrollbackBudgetBytes != null
      ? estimateScrollbackRows(scrollbackBudgetBytes, dimensions.cols)
      : null

  // A running local shell says nothing about its connection, because it has
  // none: the process is either running — in which case this pane exists — or
  // gone, in which case the pane closes. "● Connected" there restates the
  // pane's own existence. Same rule as the tab badge (TabBar.statusDotColor),
  // and for the same reason it stops at `connected`: a shell that failed to
  // start keeps its red dot and its "Failed", since that pane stays open
  // precisely so the reason can be read.
  const quietLocal = protocol === 'LOCAL' && status === 'connected'

  return (
    <footer className="flex h-6 shrink-0 items-center gap-2 border-t border-chrome/10 bg-black/20 px-3 text-xs text-chrome/45">
      {!quietLocal && (
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-base ease-swift ${statusDotColor(status)}`}
        />
      )}
      {protocol && (
        <span className="shrink-0 font-medium tracking-wide text-chrome/55">{protocol}</span>
      )}
      {target && (
        <span className="min-w-0 truncate text-chrome/70" title={target}>
          {target}
        </span>
      )}
      {!quietLocal && <span className="shrink-0">{statusLabel(status)}</span>}

      {/* Both absent for any host that reports neither, so the bar reads
          exactly as it always did until one opts in. `shrink` rather than
          `shrink-0`: these are the first things that should give up room when
          the bar is tight, ahead of anything the app itself is saying. */}
      {remoteCwd && (
        <span
          className="min-w-0 shrink truncate border-l border-chrome/10 pl-2 text-chrome/50"
          title={`Working directory reported by the remote host: ${remoteCwd}`}
        >
          {remoteCwd}
        </span>
      )}
      {remoteTitle && (
        <span
          className="min-w-0 shrink truncate text-chrome/40"
          title={`Title set by the remote host: ${remoteTitle}`}
        >
          {remoteTitle}
        </span>
      )}

      {/* Serial line controls. Placed here rather than in a menu because on a
          console cable these are used mid-session, often urgently — a break
          has to land inside a boot window measured in seconds. */}
      {serialSessionId && (
        <span className="flex shrink-0 items-center gap-1.5 border-l border-chrome/10 pl-2">
          <button
            onClick={doSendBreak}
            disabled={breaking}
            title="Send a break condition (Cisco password recovery, ROMMON, bootloader entry)"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-chrome/60 transition-colors duration-100 hover:bg-chrome/10 hover:text-amber-300 disabled:opacity-40"
          >
            <Zap size={11} strokeWidth={2} />
            BRK
          </button>
          <button
            onClick={() => toggleLine('dtr')}
            title={`Data Terminal Ready — currently ${dtr ? 'asserted' : 'deasserted'}`}
            className={`rounded px-1.5 py-0.5 transition-colors duration-100 hover:bg-chrome/10 ${
              dtr ? 'text-emerald-400/80' : 'text-chrome/35'
            }`}
          >
            DTR
          </button>
          <button
            onClick={() => toggleLine('rts')}
            title={`Request To Send — currently ${rts ? 'asserted' : 'deasserted'}`}
            className={`rounded px-1.5 py-0.5 transition-colors duration-100 hover:bg-chrome/10 ${
              rts ? 'text-emerald-400/80' : 'text-chrome/35'
            }`}
          >
            RTS
          </button>
        </span>
      )}

      {/* Right-aligned cluster: live details that don't identify the target. */}
      <span className="ml-auto flex shrink-0 items-center gap-3">
        {uptime && (
          <span title="Connection uptime" className="tabular-nums">
            {uptime}
          </span>
        )}
        {logging && (
          <span className="flex items-center gap-1 text-red-400/80" title="Session logging on">
            <ScrollText size={11} strokeWidth={2} />
            REC
          </span>
        )}
        {dimensions && (
          <span title={sizeTitle(dimensions, scrollbackDepth)} className="tabular-nums">
            {`${dimensions.cols}×${dimensions.rows}`}
            {/* One item, not two. The depth is a consequence of the width
                sitting next to it — reading them as a pair is the point, and
                two separate figures about the same pane read as clutter. */}
            {scrollbackDepth !== null && (
              <span className="text-chrome/30">{` · ~${formatRows(scrollbackDepth)}`}</span>
            )}
          </span>
        )}
        {paneCount > 1 && <span title="Active pane in this tab">{`pane ${paneIndex}/${paneCount}`}</span>}
        <span title="Open tabs">{tabCount === 1 ? '1 tab' : `${tabCount} tabs`}</span>
      </span>
    </footer>
  )
}
