import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import * as serial from '../lib/serial'
import type { SerialConfig } from '../lib/serial'

const inputClass =
  'w-full rounded border border-chrome/10 bg-black/20 px-2 py-1 text-sm text-chrome/90 outline-none transition-colors duration-100 focus:border-sky-400/50'
const selectClass = inputClass

interface Props {
  config: SerialConfig
  onChange: (config: SerialConfig) => void
  /** The picked port's USB identity, or null for a non-USB port.
   *
   * Reported separately from `config` because it isn't a *setting* — it's what
   * makes a saved serial session findable again after the adapter moves
   * socket, and it can only be read here, while the port list and the COM name
   * still refer to the same device. */
  onIdentityChange?: (usb: serial.PortInfo['usb']) => void
}

export function SerialFields({ config, onChange, onIdentityChange }: Props) {
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
          onChange={(e) => {
            set('portName', e.target.value)
            onIdentityChange?.(ports.find((p) => p.name === e.target.value)?.usb ?? null)
          }}
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
          className="flex items-center justify-center rounded border border-chrome/10 px-2 text-chrome/70 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
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

      <div className="flex items-center gap-2 text-xs text-chrome/70">
        <select
          className={`${selectClass} min-w-0 flex-1`}
          value={config.inputMode}
          onChange={(e) => set('inputMode', e.target.value as SerialConfig['inputMode'])}
          title={inputModeHints[config.inputMode]}
        >
          <option value="Normal">Normal input</option>
          <option value="LocalEcho">Local echo</option>
          <option value="Readline">Readline</option>
          <option value="ReadlineHex">Readline (hex)</option>
        </select>
        <select
          className="rounded border border-chrome/10 bg-black/20 px-1.5 py-1 text-chrome/90 outline-none transition-colors duration-100 focus:border-sky-400/50"
          value={config.lineEnding}
          onChange={(e) => set('lineEnding', e.target.value as SerialConfig['lineEnding'])}
        >
          <option value="Cr">CR</option>
          <option value="Lf">LF</option>
          <option value="CrLf">CRLF</option>
        </select>
      </div>
      <p className="text-[11px] leading-relaxed text-chrome/40">{inputModeHints[config.inputMode]}</p>
    </>
  )
}

const inputModeHints: Record<SerialConfig['inputMode'], string> = {
  Normal: 'Each keystroke is sent immediately, as-is.',
  LocalEcho: "Each keystroke is sent immediately and echoed locally — for devices that don't echo their own input.",
  Readline:
    'Compose a line locally (with editing, history via ↑/↓) and send it only on Enter.',
  ReadlineHex:
    'Like Readline, but the composed line is parsed as hex bytes (e.g. "AA 0x1B FF") and sent raw.',
}
