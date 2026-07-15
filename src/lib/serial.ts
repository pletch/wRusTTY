import { invoke } from '@tauri-apps/api/core'

export type DataBits = 'Five' | 'Six' | 'Seven' | 'Eight'
export type Parity = 'None' | 'Odd' | 'Even'
export type StopBits = 'One' | 'Two'
export type FlowControl = 'None' | 'Software' | 'Hardware'
export type LineEnding = 'Cr' | 'Lf' | 'CrLf'

export interface SerialConfig {
  portName: string
  baudRate: number
  dataBits: DataBits
  parity: Parity
  stopBits: StopBits
  flowControl: FlowControl
  localEcho: boolean
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
    localEcho: false,
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
