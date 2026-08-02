import { invoke, Channel } from '@tauri-apps/api/core'
import type { SshConfig } from './ssh'
import type { TelnetConfig } from './telnet'
import type { SerialConfig } from './serial'

export type ConnectionSource =
  | { protocol: 'ssh'; config: SshConfig; jumpProfileId?: string | null }
  | { protocol: 'sshProfile'; profileId: string }
  | { protocol: 'telnet'; config: TelnetConfig }
  | { protocol: 'serial'; config: SerialConfig }
  /** A saved serial session. The COM port is resolved backend-side from the
   * adapter's USB identity at connect time, so this deliberately carries no
   * port name — the one stored when the session was saved may well belong to
   * a different device now. */
  | { protocol: 'serialProfile'; profileId: string }

export type ConnEvent =
  | { type: 'status'; status: string }
  | {
      type: 'hostKeyPrompt'
      requestId: string
      host: string
      port: number
      fingerprint: string
      status: 'unknown' | 'changed'
      /** For 'changed' only: the fingerprint previously on record. */
      storedFingerprint: string | null
    }

export function connect(
  source: ConnectionSource,
  onEvent: (event: ConnEvent) => void,
  onData: (bytes: Uint8Array) => void,
  cols: number,
  rows: number,
) {
  const channel = new Channel<ConnEvent>()
  channel.onmessage = onEvent

  // PTY output travels on its own raw-bytes channel instead of base64-in-
  // JSON on `channel` above — cheaper both in bytes over the wire (no 33%
  // base64 inflation) and in per-chunk encode/decode cost. Tauri delivers
  // the payload as an ArrayBuffer either way (small or large), so no
  // shape-sniffing is needed here.
  const dataChannel = new Channel<ArrayBuffer>()
  dataChannel.onmessage = (buf) => onData(new Uint8Array(buf))

  switch (source.protocol) {
    case 'ssh':
      return invoke<string>('ssh_connect', {
        config: source.config,
        jumpProfileId: source.jumpProfileId ?? null,
        channel,
        dataChannel,
        cols,
        rows,
      })
    case 'sshProfile':
      return invoke<string>('ssh_connect_profile', {
        profileId: source.profileId,
        channel,
        dataChannel,
        cols,
        rows,
      })
    case 'telnet':
      return invoke<string>('telnet_connect', { config: source.config, channel, dataChannel })
    case 'serial': {
      // inputMode is frontend-only (see lib/serial.ts) — Rust only ever
      // needs to know whether it should echo written bytes back itself,
      // which is exactly what 'LocalEcho' means; Readline/ReadlineHex are
      // handled entirely client-side and look like 'Normal' to the backend.
      const { inputMode, ...rest } = source.config
      const config = { ...rest, localEcho: inputMode === 'LocalEcho' }
      return invoke<string>('serial_connect', { config, channel, dataChannel })
    }
    case 'serialProfile':
      // No config sent: the backend resolves the adapter's USB identity to
      // whatever COM number it holds right now, which is the entire reason a
      // serial session can be saved at all.
      return invoke<string>('serial_connect_profile', {
        profileId: source.profileId,
        channel,
        dataChannel,
      })
  }
}

/** Which transport's command family a source belongs to.
 *
 * The `*Profile` variants differ from their plain counterparts only in how the
 * connection is *established* — once a session id exists, it is an ordinary
 * session of that transport. Centralised because this was three separate
 * ternaries defaulting to `ssh_*`, which meant every new source variant
 * silently routed its writes and disconnects to the SSH commands until someone
 * noticed. */
export function transportOf(source: ConnectionSource): 'ssh' | 'telnet' | 'serial' {
  switch (source.protocol) {
    case 'telnet':
      return 'telnet'
    case 'serial':
    case 'serialProfile':
      return 'serial'
    case 'ssh':
    case 'sshProfile':
      return 'ssh'
  }
}

export function write(source: ConnectionSource, sessionId: string, data: Uint8Array) {
  return invoke<void>(`${transportOf(source)}_write`, { sessionId, data: Array.from(data) })
}

/**
 * Tells the backend how many delivered bytes have now been written to the
 * engine, so it can send more.
 *
 * IPC gives the sender no backpressure of its own — a successful send means the
 * message was queued for the webview, not that anything read it — so without
 * this report the coalescer cannot tell a frontend keeping up from one falling
 * tens of megabytes behind. Measured on a 100 MB flood, the backend finished
 * sending 1.1 s before the frontend finished draining, with ~50 MB of buffers
 * resident in the webview at peak and no bound on it beyond how long the
 * producer ran.
 *
 * Protocol-independent: the flow control is keyed by session id in
 * `coalesce.rs`, which every transport shares. Fire-and-forget by design — a
 * lost ack costs a little throughput at worst, and the backend's credit timeout
 * covers a frontend that stops acking entirely.
 */
export function ackDelivery(sessionId: string, bytes: number) {
  return invoke<void>('ack_delivery', { sessionId, bytes })
}

/**
 * Retunes the backpressure window and returns the value it was clamped to.
 *
 * Exists to be driven from a keyboard shortcut rather than the console: the
 * balance being tuned is between the backend's send rate and the frontend's
 * parse rate, and an attached inspector makes the latter ~2.75x slower, so a
 * value chosen with DevTools open would be chosen against the wrong frontend.
 */
export function setInflightWindow(bytes: number) {
  return invoke<number>('set_inflight_window', { bytes })
}

/** No-op for serial — it has no concept of terminal size to negotiate. */
export function resize(source: ConnectionSource, sessionId: string, cols: number, rows: number) {
  const transport = transportOf(source)
  if (transport === 'serial') return Promise.resolve()
  return invoke<void>(`${transport}_resize`, { sessionId, cols, rows })
}

export function disconnect(source: ConnectionSource, sessionId: string) {
  return invoke<void>(`${transportOf(source)}_disconnect`, { sessionId })
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
    // The port isn't known here — it's resolved backend-side at connect
    // time — so the id is all this has. App's status bar resolves it to the
    // profile's own label, the same way it does for sshProfile.
    case 'serialProfile':
      return source.profileId
  }
}
