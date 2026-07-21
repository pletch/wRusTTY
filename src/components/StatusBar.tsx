import { useEffect, useState } from 'react'
import { ScrollText, Zap } from 'lucide-react'
import * as serial from '../lib/serial'
import { toast } from '../lib/toast'

/** Same status→color mapping as the tab dot (TabBar.statusDotColor), plus a
 * muted resting color for "no active connection" so the bar reads as a stable
 * anchor rather than blinking in and out. */
function statusDotColor(status: string | undefined): string {
  if (status === 'connected') return 'bg-emerald-400'
  if (!status) return 'bg-white/25'
  if (status.startsWith('failed') || status === 'disconnected') return 'bg-red-400'
  return 'bg-amber-400'
}

function statusLabel(status: string | undefined): string {
  if (!status) return 'Not connected'
  // The backend sends "failed: <reason>" — the reason already surfaces as a
  // toast (see App.tsx), so the bar just needs the short state word.
  if (status.startsWith('failed')) return 'Failed'
  return status.charAt(0).toUpperCase() + status.slice(1)
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

  return (
    <footer className="flex h-6 shrink-0 items-center gap-2 border-t border-white/10 bg-black/20 px-3 text-xs text-white/45">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-base ease-swift ${statusDotColor(status)}`}
      />
      {protocol && (
        <span className="shrink-0 font-medium tracking-wide text-white/55">{protocol}</span>
      )}
      {target && (
        <span className="min-w-0 truncate text-white/70" title={target}>
          {target}
        </span>
      )}
      <span className="shrink-0">{statusLabel(status)}</span>

      {/* Serial line controls. Placed here rather than in a menu because on a
          console cable these are used mid-session, often urgently — a break
          has to land inside a boot window measured in seconds. */}
      {serialSessionId && (
        <span className="flex shrink-0 items-center gap-1.5 border-l border-white/10 pl-2">
          <button
            onClick={doSendBreak}
            disabled={breaking}
            title="Send a break condition (Cisco password recovery, ROMMON, bootloader entry)"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-white/60 transition-colors duration-100 hover:bg-white/10 hover:text-amber-300 disabled:opacity-40"
          >
            <Zap size={11} strokeWidth={2} />
            BRK
          </button>
          <button
            onClick={() => toggleLine('dtr')}
            title={`Data Terminal Ready — currently ${dtr ? 'asserted' : 'deasserted'}`}
            className={`rounded px-1.5 py-0.5 transition-colors duration-100 hover:bg-white/10 ${
              dtr ? 'text-emerald-400/80' : 'text-white/35'
            }`}
          >
            DTR
          </button>
          <button
            onClick={() => toggleLine('rts')}
            title={`Request To Send — currently ${rts ? 'asserted' : 'deasserted'}`}
            className={`rounded px-1.5 py-0.5 transition-colors duration-100 hover:bg-white/10 ${
              rts ? 'text-emerald-400/80' : 'text-white/35'
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
        {paneCount > 1 && <span title="Active pane in this tab">{`pane ${paneIndex}/${paneCount}`}</span>}
        <span title="Open tabs">{tabCount === 1 ? '1 tab' : `${tabCount} tabs`}</span>
      </span>
    </footer>
  )
}
