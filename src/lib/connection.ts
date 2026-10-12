import { invoke, Channel } from '@tauri-apps/api/core'
import type { ProxyConfig, SshConfig } from './ssh'
import type { TelnetConfig } from './telnet'
import type { SerialConfig } from './serial'
import { localTitle, shellDisplayName, type LocalConfig } from './local'
import type { WakeOnLan } from './profiles'

export type ConnectionSource =
  | {
      protocol: 'ssh'
      config: SshConfig
      jumpProfileId?: string | null
      wake?: WakeOnLan | null
      /** `false` connects directly even when Settings names a proxy (a saved
       * session's opt-out is applied backend-side). */
      useProxy?: boolean
    }
  | { protocol: 'sshProfile'; profileId: string }
  | { protocol: 'telnet'; config: TelnetConfig }
  | { protocol: 'serial'; config: SerialConfig }
  /** A saved serial session. The COM port is resolved backend-side from the
   * adapter's USB identity at connect time, so no port name is carried. */
  | { protocol: 'serialProfile'; profileId: string }
  /** A shell process on this machine, configured inline. */
  | { protocol: 'local'; config: LocalConfig }
  /** A saved local shell. `shellId` is carried so the webview can decide
   * whether to record history without a round trip; the backend re-resolves the
   * command from the profile. */
  | { protocol: 'localProfile'; profileId: string; shellId: string }
  /** A local shell run as administrator via the elevated host (see
   * docs/ELEVATED_TABS_PLAN.md). Carries a shell id, never a path, so nothing
   * here can choose what runs elevated. `profileId` is for labeling only. */
  | { protocol: 'elevated'; shellId: string; profileId: string | null }

export type ConnEvent =
  | { type: 'status'; status: string }
  | {
      type: 'hostKeyPrompt'
      requestId: string
      host: string
      port: number
      fingerprint: string
      status: 'unknown' | 'changed' | 'newKeyType'
      /** For 'changed': the fingerprint on record. */
      storedFingerprint: string | null
      /** For 'newKeyType': each key on record, as `algorithm fingerprint`. */
      knownKeys: string[]
    }
  | {
      type: 'authPrompt'
      requestId: string
      /** The server's title and preamble; often empty. */
      name: string
      instructions: string
      /** What to ask, in order; responses go back in the same order. */
      fields: AuthPromptField[]
      host: string
      port: number
      /** True when the jump host is asking rather than the destination. */
      isJump: boolean
    }

export interface AuthPromptField {
  /** The server's wording, shown verbatim. */
  prompt: string
  /** False means a secret; the input is masked. */
  echo: boolean
}

/** What a reconnect run may spend, and whether it may run. Mirrors
 * `ReconnectPolicy` in src-tauri/src/session_registry.rs, which clamps both
 * bounds. */
export interface ReconnectPolicy {
  enabled: boolean
  maxAttempts: number
  maxElapsedSeconds: number
}

/** Combines the global setting and the profile's opt-out: either can disable
 * reconnect, neither can enable it. (The backend also refuses sessions whose
 * credential must be typed.) */
export function reconnectPolicy(
  settings: { autoReconnect: boolean; reconnectMaxAttempts: number; reconnectMaxSeconds: number },
  profileAutoReconnect: boolean | null | undefined,
): ReconnectPolicy {
  return {
    enabled: settings.autoReconnect && profileAutoReconnect !== false,
    maxAttempts: settings.reconnectMaxAttempts,
    maxElapsedSeconds: settings.reconnectMaxSeconds,
  }
}

export function connect(
  source: ConnectionSource,
  onEvent: (event: ConnEvent) => void,
  onData: (bytes: Uint8Array) => void,
  cols: number,
  rows: number,
  reconnect: ReconnectPolicy,
  /** The global proxy from Settings (`proxyConfigFrom`), or null. SSH only. */
  proxy: ProxyConfig | null = null,
) {
  const channel = new Channel<ConnEvent>()
  channel.onmessage = onEvent

  // PTY output arrives as raw bytes on its own channel (always an
  // ArrayBuffer), avoiding base64-in-JSON.
  const dataChannel = new Channel<ArrayBuffer>()
  dataChannel.onmessage = (buf) => onData(new Uint8Array(buf))

  switch (source.protocol) {
    case 'ssh':
      return invoke<string>('ssh_connect', {
        config: source.config,
        jumpProfileId: source.jumpProfileId ?? null,
        // Sent explicitly as null rather than omitted.
        wake: source.wake ?? null,
        proxy: source.useProxy === false ? null : proxy,
        channel,
        dataChannel,
        cols,
        rows,
        reconnect,
      })
    case 'sshProfile':
      return invoke<string>('ssh_connect_profile', {
        profileId: source.profileId,
        proxy,
        channel,
        dataChannel,
        cols,
        rows,
        reconnect,
      })
    case 'telnet':
      return invoke<string>('telnet_connect', {
        config: source.config,
        channel,
        dataChannel,
        reconnect,
      })
    case 'serial': {
      // `inputMode` is frontend-only (see lib/serial.ts); the backend only needs
      // to know whether to echo locally.
      const { inputMode, ...rest } = source.config
      const config = { ...rest, localEcho: inputMode === 'LocalEcho' }
      return invoke<string>('serial_connect', { config, channel, dataChannel, reconnect })
    }
    case 'serialProfile':
      // The backend resolves the adapter's current COM port.
      return invoke<string>('serial_connect_profile', {
        profileId: source.profileId,
        channel,
        dataChannel,
        reconnect,
      })
    case 'elevated':
      // No reconnect policy: rebuilding an elevated tab would mean a UAC prompt.
      return invoke<string>('elevated_connect', {
        shellId: source.shellId,
        channel,
        dataChannel,
        cols,
        rows,
      })
    case 'localProfile':
      // The backend re-resolves the shell id against what's installed now.
      return invoke<string>('local_connect_profile', {
        profileId: source.profileId,
        channel,
        dataChannel,
        cols,
        rows,
        reconnect,
      })
    case 'local':
      // Sends the size: a pseudoconsole is sized at creation, or the first
      // prompt is drawn at 80 columns.
      return invoke<string>('local_connect', {
        config: source.config,
        channel,
        dataChannel,
        cols,
        rows,
        reconnect,
      })
  }
}

/** Which transport's command family a source belongs to. The `*Profile`
 * variants differ only in how the connection is established. */
export function transportOf(
  source: ConnectionSource,
): 'ssh' | 'telnet' | 'serial' | 'local' | 'elevated' {
  switch (source.protocol) {
    // A separate registry, so `local_write` would never find it.
    case 'elevated':
      return 'elevated'
    case 'telnet':
      return 'telnet'
    case 'local':
    case 'localProfile':
      return 'local'
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
 * Tells the backend how many delivered bytes have been written to the engine,
 * so it can send more (IPC success only means "queued"). Keyed by session id in
 * `coalesce.rs`, shared by every transport. Fire-and-forget: a lost ack costs
 * a little throughput, and the backend's credit timeout covers a frontend that
 * stops acking.
 */
export function ackDelivery(sessionId: string, bytes: number) {
  return invoke<void>('ack_delivery', { sessionId, bytes })
}

/**
 * Retunes the backpressure window and returns the clamped value. Driven from a
 * keyboard shortcut because DevTools slows the frontend ~2.75x.
 */
export function setInflightWindow(bytes: number) {
  return invoke<number>('set_inflight_window', { bytes })
}

/** No-op for serial, which has no terminal size. */
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

/** Answers one keyboard-interactive round: one response per field, in order,
 * or `null` to cancel (rather than sending blanks, which spend an attempt). */
export function respondAuthPrompt(requestId: string, responses: string[] | null) {
  return invoke<void>('ssh_respond_auth_prompt', { requestId, responses })
}

/** An auto-reconnect in progress, parsed from the status string
 * `"reconnecting: <attempt> in <seconds>"` (`status_label` in
 * src-tauri/src/connection_status.rs; keep them in step). */
export type Reconnecting = { attempt: number; inSeconds: number }

export function parseReconnecting(status: string): Reconnecting | null {
  const match = /^reconnecting: (\d+) in (\d+)$/.exec(status)
  if (!match) return null
  return { attempt: Number(match[1]), inSeconds: Number(match[2]) }
}

/** Whether a status means the session is over: `disconnected` (a clean close)
 * or `lost` (the transport dropped; only this may be followed by
 * `reconnecting`). */
export function isDisconnect(status: string): boolean {
  return status === 'disconnected' || status === 'lost'
}

/** A connection that ended cleanly: the shell exited or the server hung up. */
export function isCleanDisconnect(status: string): boolean {
  return status === 'disconnected'
}

/** Whether `closeOnDisconnect` should close this pane now: only on a clean
 * end. A `lost` transport is auto-reconnect's case; if it can't come back,
 * the pane stays open on its disconnect overlay with a Reconnect button. */
export function shouldAutoClosePane(status: string, closeOnDisconnect: boolean): boolean {
  return closeOnDisconnect && isCleanDisconnect(status)
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
    case 'local':
      return localTitle(source.config)
    // The id; the status bar resolves the label.
    case 'localProfile':
      return source.profileId
    case 'elevated':
      return shellDisplayName(source.shellId) ?? source.shellId
    // The id; the port is resolved at connect time.
    case 'serialProfile':
      return source.profileId
  }
}
