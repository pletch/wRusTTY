import { invoke, Channel } from '@tauri-apps/api/core'
import type { SshConfig } from './ssh'
import { decodeBase64 } from './ssh'
import type { TelnetConfig } from './telnet'
import type { SerialConfig } from './serial'

export type ConnectionSource =
  | { protocol: 'ssh'; config: SshConfig }
  | { protocol: 'sshProfile'; profileId: string }
  | { protocol: 'telnet'; config: TelnetConfig }
  | { protocol: 'serial'; config: SerialConfig }

export type ConnEvent =
  | { type: 'data'; bytesBase64: string }
  | { type: 'status'; status: string }
  | {
      type: 'hostKeyPrompt'
      requestId: string
      host: string
      port: number
      fingerprint: string
      status: 'unknown' | 'changed'
    }

export { decodeBase64 }

export function connect(source: ConnectionSource, onEvent: (event: ConnEvent) => void) {
  const channel = new Channel<ConnEvent>()
  channel.onmessage = onEvent

  switch (source.protocol) {
    case 'ssh':
      return invoke<string>('ssh_connect', { config: source.config, channel })
    case 'sshProfile':
      return invoke<string>('ssh_connect_profile', { profileId: source.profileId, channel })
    case 'telnet':
      return invoke<string>('telnet_connect', { config: source.config, channel })
    case 'serial': {
      // inputMode is frontend-only (see lib/serial.ts) — Rust only ever
      // needs to know whether it should echo written bytes back itself,
      // which is exactly what 'LocalEcho' means; Readline/ReadlineHex are
      // handled entirely client-side and look like 'Normal' to the backend.
      const { inputMode, ...rest } = source.config
      const config = { ...rest, localEcho: inputMode === 'LocalEcho' }
      return invoke<string>('serial_connect', { config, channel })
    }
  }
}

export function write(source: ConnectionSource, sessionId: string, data: Uint8Array) {
  const command = source.protocol === 'telnet' ? 'telnet_write' : source.protocol === 'serial' ? 'serial_write' : 'ssh_write'
  return invoke<void>(command, { sessionId, data: Array.from(data) })
}

/** No-op for serial — it has no concept of terminal size to negotiate. */
export function resize(source: ConnectionSource, sessionId: string, cols: number, rows: number) {
  if (source.protocol === 'serial') return Promise.resolve()
  const command = source.protocol === 'telnet' ? 'telnet_resize' : 'ssh_resize'
  return invoke<void>(command, { sessionId, cols, rows })
}

export function disconnect(source: ConnectionSource, sessionId: string) {
  const command =
    source.protocol === 'telnet'
      ? 'telnet_disconnect'
      : source.protocol === 'serial'
        ? 'serial_disconnect'
        : 'ssh_disconnect'
  return invoke<void>(command, { sessionId })
}

export function respondHostKey(requestId: string, accept: boolean) {
  return invoke<void>('ssh_respond_host_key', { requestId, accept })
}

export function sourceLabel(source: ConnectionSource): string {
  switch (source.protocol) {
    case 'ssh':
      return `${source.config.username}@${source.config.host}`
    case 'sshProfile':
      return source.profileId
    case 'telnet':
      return `${source.config.host}:${source.config.port}`
    case 'serial':
      return source.config.portName
  }
}
