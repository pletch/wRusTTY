import { invoke } from '@tauri-apps/api/core'

export type DataBits = 'Five' | 'Six' | 'Seven' | 'Eight'
export type Parity = 'None' | 'Odd' | 'Even'
export type StopBits = 'One' | 'Two'
export type FlowControl = 'None' | 'Software' | 'Hardware'
export type LineEnding = 'Cr' | 'Lf' | 'CrLf'

// Frontend-only — never sent to Rust as-is (see connection.ts's 'serial'
// case), since only 'LocalEcho' has a backend-visible effect (translates to
// the existing `localEcho: boolean`). Readline/ReadlineHex are purely a
// client-side input-composition behavior: a local line editor buffers
// keystrokes and only hands a completed line to the wire on Enter, instead
// of sending each keystroke immediately.
export type InputMode = 'Normal' | 'LocalEcho' | 'Readline' | 'ReadlineHex'

export interface SerialConfig {
  portName: string
  baudRate: number
  dataBits: DataBits
  parity: Parity
  stopBits: StopBits
  flowControl: FlowControl
  inputMode: InputMode
  lineEnding: LineEnding
}

export interface PortInfo {
  name: string
  friendlyName: string | null
}

export function defaultSerialConfig(): SerialConfig {
  return {
    portName: '',
    baudRate: 9600,
    dataBits: 'Eight',
    parity: 'None',
    stopBits: 'One',
    flowControl: 'None',
    inputMode: 'Normal',
    lineEnding: 'Cr',
  }
}

export function listPorts() {
  return invoke<PortInfo[]>('serial_list_ports')
}

export function setDtr(sessionId: string, level: boolean) {
  return invoke<void>('serial_set_dtr', { sessionId, level })
}

export function setRts(sessionId: string, level: boolean) {
  return invoke<void>('serial_set_rts', { sessionId, level })
}
