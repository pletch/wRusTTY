import { useCallback, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { X, ArrowLeftRight, Square, RotateCw, AlertTriangle } from 'lucide-react'
import * as forward from '../lib/forward'
import type { ForwardInfo, ForwardSpec } from '../lib/forward'
import { toast } from '../lib/toast'
import { useConfirm } from './confirmContext'
import { useDismissable } from '../hooks/useDismissable'

interface Props {
  sessionId: string
  /** The pane's connection status. Watched rather than displayed: a reconnect
   *  re-establishes this session's forwards in the backend, and one that could
   *  not be re-established is exactly what this panel now has to show. Without
   *  this the list would keep claiming a forward was live until the panel
   *  happened to be closed and reopened. */
  status?: string
  onClose: () => void
}

// Deliberately excludes `flex-1`/`flex-none` — baking `flex-1` in here and
// overriding it with `flex-none` on port fields relies on Tailwind's
// generated-CSS order to resolve the conflicting `flex` shorthand, which
// isn't guaranteed to match className order (see ConnectDialog's inputClass
// for the same issue with `w-full`/`w-16`, caught via manual testing).
const inputClass =
  'min-w-0 rounded border border-chrome/10 bg-black/20 px-1.5 py-1 text-chrome/90 outline-none transition-colors duration-100 focus:border-sky-400/50'

function describe(spec: ForwardSpec): string {
  if (spec.type === 'dynamic') return `SOCKS5 :${spec.bindPort}`
  const arrow = spec.type === 'local' ? '→' : '←'
  return `${spec.bindHost}:${spec.bindPort} ${arrow} ${spec.targetHost}:${spec.targetPort}`
}

export function ForwardPanel({ sessionId, status, onClose }: Props) {
  const confirm = useConfirm()
  // Rendered only while open, so it is always dismissable while mounted.
  useDismissable(true, onClose, { within: '[data-forward-panel], [data-forward-toggle]' })
  const [active, setActive] = useState<ForwardInfo[]>([])
  const [type, setType] = useState<ForwardSpec['type']>('local')
  const [bindHost, setBindHost] = useState('127.0.0.1')
  const [bindPort, setBindPort] = useState('8080')
  const [targetHost, setTargetHost] = useState('')
  const [targetPort, setTargetPort] = useState('80')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setActive(await forward.listForwards(sessionId))
    } catch {
      // A session that has gone has no forwards to list, and the pane is
      // already saying so far more clearly than a line in here could.
    }
  }, [sessionId])

  // On open, and again on every status change.
  //
  // The status change alone is *not* enough, and relying on it was a real bug:
  // `connected` is emitted from inside the SSH handshake, before the backend
  // has re-established anything, so refetching on it reads the list as it stood
  // a moment before the reconnect touched it — and nothing afterwards said to
  // look again. Kept anyway because it costs one cheap call and covers first
  // mount; the event below is what makes the answer right.
  useEffect(() => {
    void refresh()
  }, [refresh, status])

  // Emitted by the backend once it has finished writing, at both ends of an
  // outage: the forwards being marked dead, and the attempt to bring them back.
  useEffect(() => {
    const pending = listen<string>('ssh-forwards-changed', (event) => {
      // Every pane's session emits on the same channel.
      if (event.payload === sessionId) void refresh()
    })
    return () => {
      void pending.then((unlisten) => unlisten())
    }
  }, [sessionId, refresh])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const spec: ForwardSpec =
      type === 'dynamic'
        ? { type: 'dynamic', bindHost, bindPort: Number(bindPort) || 0 }
        : {
            type,
            bindHost,
            bindPort: Number(bindPort) || 0,
            targetHost,
            targetPort: Number(targetPort) || 0,
          }
    try {
      const id = await addForwardConfirmingIfNeeded(spec)
      if (id === null) return
      setActive((prev) => [...prev, { id, spec, active: true, error: null }])
      toast.success(`Forwarding ${describe(spec)}`)
    } catch (err) {
      setError(String(err))
    }
  }

  // A non-loopback bind host (0.0.0.0, a LAN IP, ...) exposes the forward
  // beyond this machine — for a SOCKS5 dynamic forward that's an
  // unauthenticated proxy onto whatever the SSH server can reach, so this
  // asks first rather than silently standing one up.
  async function addForwardConfirmingIfNeeded(spec: ForwardSpec): Promise<string | null> {
    try {
      return await forward.addForward(sessionId, spec)
    } catch (err) {
      if (String(err) !== forward.NON_LOOPBACK_BIND_ERROR) throw err
      // Spelled out rather than summarised: this is the one prompt in the app
      // where the consequence isn't obvious from the action. "Bind to 0.0.0.0"
      // does not read as "stand up an open proxy", and for a dynamic forward
      // that is exactly what it does — anyone who can reach this machine's
      // port gets to make connections from the SSH server, authenticated as
      // this session.
      const ok = await confirm({
        title: 'Expose this forward to your network?',
        body:
          `${spec.bindHost} isn't a loopback address, so anything that can reach this ` +
          `machine on port ${spec.bindPort} can use the forward — not just programs ` +
          `running here. ` +
          (spec.type === 'dynamic'
            ? 'For a dynamic forward that is an unauthenticated SOCKS proxy onto every host your SSH server can reach.'
            : `Connections will arrive at ${spec.targetHost}:${spec.targetPort} as though they came from the SSH server.`),
        confirmLabel: 'Expose it',
      })
      if (!ok) return null
      return await forward.addForward(sessionId, spec, true)
    }
  }

  async function remove(id: string) {
    const f = active.find((a) => a.id === id)
    await forward.removeForward(id).catch(() => {})
    setActive((prev) => prev.filter((a) => a.id !== id))
    // "Stopped" would be a lie for a forward that was already down — that row
    // was dismissed, not stopped.
    if (f) toast.info(`${f.active ? 'Stopped' : 'Dismissed'} ${describe(f.spec)}`)
  }

  async function retry(id: string) {
    setError(null)
    try {
      await forward.retryForward(id)
      toast.success('Forward re-established')
    } catch (err) {
      setError(String(err))
    }
    // Either way — the backend records the outcome on the entry, so the list
    // is the truth about what happened rather than what was hoped for.
    await refresh()
  }

  return (
    <div
      data-forward-panel
      className="animate-in fade-in slide-in-from-top-1 absolute right-2 top-10 z-40 w-72 rounded-lg border border-chrome/10 bg-[#1f2028] p-3 text-xs shadow-xl duration-100"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 font-medium text-chrome/90">
          <ArrowLeftRight size={13} /> Port forwarding
        </h2>
        <button
          onClick={onClose}
          className="flex items-center justify-center rounded p-1 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/80"
        >
          <X size={13} />
        </button>
      </div>

      {active.length > 0 && (
        <ul className="mb-2 space-y-1">
          {active.map((f) => (
            <li key={f.id} className="rounded bg-black/20 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`flex min-w-0 items-center gap-1.5 truncate ${
                    f.active ? 'text-chrome/70' : 'text-amber-300/80'
                  }`}
                >
                  {!f.active && <AlertTriangle size={11} className="shrink-0" />}
                  <span className="truncate">{describe(f.spec)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {!f.active && (
                    <button
                      onClick={() => retry(f.id)}
                      className="flex items-center gap-1 text-chrome/40 transition-colors duration-100 hover:text-sky-300"
                    >
                      <RotateCw size={10} /> retry
                    </button>
                  )}
                  <button
                    onClick={() => remove(f.id)}
                    className="flex items-center gap-1 text-chrome/40 transition-colors duration-100 hover:text-red-300"
                  >
                    <Square size={10} /> {f.active ? 'stop' : 'dismiss'}
                  </button>
                </span>
              </div>
              {/* The reason, not just the state. In practice it is "the local
                  port is taken", which is the difference between something the
                  user can fix in ten seconds and a mystery. */}
              {!f.active && (
                <p className="mt-1 break-words text-[11px] leading-snug text-amber-300/60">
                  {f.error ?? 'not connected'}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={add} className="space-y-1.5">
        <div className="flex gap-1 rounded bg-black/20 p-0.5">
          {(['local', 'remote', 'dynamic'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`flex-1 rounded py-1 uppercase transition-colors duration-100 ${
                type === t ? 'bg-chrome/15 text-chrome' : 'text-chrome/40 hover:text-chrome/70'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex gap-1">
          <input
            className={`${inputClass} flex-1`}
            placeholder="bind host"
            value={bindHost}
            onChange={(e) => setBindHost(e.target.value)}
          />
          <input
            className={`${inputClass} w-16 flex-none`}
            placeholder="port"
            value={bindPort}
            onChange={(e) => setBindPort(e.target.value)}
          />
        </div>

        {type !== 'dynamic' && (
          <div className="flex gap-1">
            <input
              className={`${inputClass} flex-1`}
              placeholder="target host"
              value={targetHost}
              onChange={(e) => setTargetHost(e.target.value)}
              required
            />
            <input
              className={`${inputClass} w-16 flex-none`}
              placeholder="port"
              value={targetPort}
              onChange={(e) => setTargetPort(e.target.value)}
            />
          </div>
        )}

        {error && <p className="text-red-400">{error}</p>}

        <button
          type="submit"
          className="w-full rounded bg-sky-500/90 py-1.5 font-medium text-white transition-colors duration-100 hover:bg-sky-500"
        >
          Add forward
        </button>
      </form>
    </div>
  )
}
