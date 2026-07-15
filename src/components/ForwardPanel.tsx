import { useState } from 'react'
import * as forward from '../lib/forward'
import type { ForwardSpec } from '../lib/forward'

interface ActiveForward {
  id: string
  spec: ForwardSpec
}

interface Props {
  sessionId: string
  onClose: () => void
}

const inputClass =
  'min-w-0 flex-1 rounded border border-white/10 bg-black/20 px-1.5 py-1 text-white/90 outline-none focus:border-white/30'

function describe(spec: ForwardSpec): string {
  if (spec.type === 'dynamic') return `SOCKS5 :${spec.bindPort}`
  const arrow = spec.type === 'local' ? '→' : '←'
  return `${spec.bindHost}:${spec.bindPort} ${arrow} ${spec.targetHost}:${spec.targetPort}`
}

export function ForwardPanel({ sessionId, onClose }: Props) {
  const [active, setActive] = useState<ActiveForward[]>([])
  const [type, setType] = useState<ForwardSpec['type']>('local')
  const [bindHost, setBindHost] = useState('127.0.0.1')
  const [bindPort, setBindPort] = useState('8080')
  const [targetHost, setTargetHost] = useState('')
  const [targetPort, setTargetPort] = useState('80')
  const [error, setError] = useState<string | null>(null)

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
      const id = await forward.addForward(sessionId, spec)
      setActive((prev) => [...prev, { id, spec }])
    } catch (err) {
      setError(String(err))
    }
  }

  async function remove(id: string) {
    await forward.removeForward(id).catch(() => {})
    setActive((prev) => prev.filter((f) => f.id !== id))
  }

  return (
    <div
      className="absolute right-2 top-8 z-40 w-72 rounded border border-white/10 bg-[#1f2028] p-3 text-xs shadow-lg"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium text-white/90">Port forwarding</h2>
        <button onClick={onClose} className="text-white/40 hover:text-white/80">
          ×
        </button>
      </div>

      {active.length > 0 && (
        <ul className="mb-2 space-y-1">
          {active.map((f) => (
            <li
              key={f.id}
              className="flex items-center justify-between gap-2 rounded bg-black/20 px-2 py-1"
            >
              <span className="truncate text-white/70">{describe(f.spec)}</span>
              <button
                onClick={() => remove(f.id)}
                className="shrink-0 text-white/40 hover:text-red-300"
              >
                stop
              </button>
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
              className={`flex-1 rounded py-0.5 uppercase ${
                type === t ? 'bg-white/15 text-white' : 'text-white/40 hover:text-white/70'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex gap-1">
          <input
            className={inputClass}
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
              className={inputClass}
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
          className="w-full rounded bg-white/10 py-1 text-white/90 hover:bg-white/20"
        >
          Add forward
        </button>
      </form>
    </div>
  )
}
