import { useEffect, useState } from 'react'
import * as serial from '../lib/serial'
import type { SerialConfig } from '../lib/serial'

const inputClass =
  'w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-sm text-white/90 outline-none focus:border-white/30'
const selectClass = inputClass

interface Props {
  config: SerialConfig
  onChange: (config: SerialConfig) => void
}

export function SerialFields({ config, onChange }: Props) {
  const [ports, setPorts] = useState<serial.PortInfo[]>([])
  const [loading, setLoading] = useState(false)

  function refresh() {
    setLoading(true)
    serial
      .listPorts()
      .then(setPorts)
      .catch(() => setPorts([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    refresh()
  }, [])

  function set<K extends keyof SerialConfig>(key: K, value: SerialConfig[K]) {
    onChange({ ...config, [key]: value })
  }

  return (
    <>
      <div className="flex gap-2">
        <select
          className={`${selectClass} min-w-0 flex-1`}
          value={config.portName}
          onChange={(e) => set('portName', e.target.value)}
          required
        >
          <option value="" disabled>
            {loading ? 'Scanning...' : 'select port'}
          </option>
          {ports.map((p) => (
            <option key={p.name} value={p.name}>
              {p.friendlyName ? `${p.name} (${p.friendlyName})` : p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={refresh}
          title="Refresh ports"
          className="rounded border border-white/10 px-2 text-sm text-white/70 hover:bg-white/10"
        >
          ↻
        </button>
      </div>

      <div className="flex gap-2">
        <input
          className={`${inputClass} min-w-0 flex-1`}
          placeholder="baud rate"
          type="number"
          value={config.baudRate}
          onChange={(e) => set('baudRate', Number(e.target.value) || 9600)}
          list="baud-presets"
        />
        <datalist id="baud-presets">
          {[300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <select
          className={selectClass}
          value={config.dataBits}
          onChange={(e) => set('dataBits', e.target.value as SerialConfig['dataBits'])}
        >
          {(['Five', 'Six', 'Seven', 'Eight'] as const).map((v) => (
            <option key={v} value={v}>
              {v} data bits
            </option>
          ))}
        </select>
        <select
          className={selectClass}
          value={config.parity}
          onChange={(e) => set('parity', e.target.value as SerialConfig['parity'])}
        >
          {(['None', 'Odd', 'Even'] as const).map((v) => (
            <option key={v} value={v}>
              {v} parity
            </option>
          ))}
        </select>
        <select
          className={selectClass}
          value={config.stopBits}
          onChange={(e) => set('stopBits', e.target.value as SerialConfig['stopBits'])}
        >
          {(['One', 'Two'] as const).map((v) => (
            <option key={v} value={v}>
              {v} stop bit{v === 'Two' ? 's' : ''}
            </option>
          ))}
        </select>
        <select
          className={selectClass}
          value={config.flowControl}
          onChange={(e) => set('flowControl', e.target.value as SerialConfig['flowControl'])}
        >
          {(['None', 'Software', 'Hardware'] as const).map((v) => (
            <option key={v} value={v}>
              {v} flow
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3 text-xs text-white/70">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={config.localEcho}
            onChange={(e) => set('localEcho', e.target.checked)}
          />
          Local echo
        </label>
        <select
          className="rounded border border-white/10 bg-black/20 px-1 py-0.5 text-white/90 outline-none"
          value={config.lineEnding}
          onChange={(e) => set('lineEnding', e.target.value as SerialConfig['lineEnding'])}
        >
          <option value="Cr">CR</option>
          <option value="Lf">LF</option>
          <option value="CrLf">CRLF</option>
        </select>
      </div>
    </>
  )
}
