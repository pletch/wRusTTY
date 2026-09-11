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
      /** `false` connects directly even when Settings names a proxy. A saved
       * session's own opt-out is applied backend-side instead, where the
       * profile is. */
      useProxy?: boolean
    }
  | { protocol: 'sshProfile'; profileId: string }
  | { protocol: 'telnet'; config: TelnetConfig }
  | { protocol: 'serial'; config: SerialConfig }
  /** A saved serial session. The COM port is resolved backend-side from the
   * adapter's USB identity at connect time, so this deliberately carries no
   * port name — the one stored when the session was saved may well belong to
   * a different device now. */
  | { protocol: 'serialProfile'; profileId: string }
  /** A shell process on this machine. The only source with nothing on the far
   * end of a network — no host, no port, no credential — which is why it
   * carries its whole configuration inline and has no profile form yet. */
  | { protocol: 'local'; config: LocalConfig }
  /** A saved local shell. Carries the detected `shellId` alongside the id of
   * the profile because the two answer different questions: the profile is
   * what the backend re-resolves the command from, and the shell id is what
   * says whether this is a shell whose history is worth recording — a question
   * asked in the webview, on every keystroke, and not worth a round trip. */
  | { protocol: 'localProfile'; profileId: string; shellId: string }
  /** A local shell run as administrator, through the elevated host (see
   * docs/ELEVATED_TABS_PLAN.md). Carries a shell *id*, never a path: the
   * elevated host resolves the id itself, so nothing here can choose what runs
   * as administrator. `profileId` is the saved session it was opened from, if
   * any — for labelling only. */
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
      /** For 'changed' only: the fingerprint previously on record. */
      storedFingerprint: string | null
      /** For 'newKeyType' only: each key on record, as `algorithm fingerprint`. */
      knownKeys: string[]
    }
  | {
      type: 'authPrompt'
      requestId: string
      /** The server's own title and preamble for the exchange. Both are
       * routinely empty, and the dialog supplies its own heading then. */
      name: string
      instructions: string
      /** What to ask, in order. Responses go back in the same order and the
       * same number. */
      fields: AuthPromptField[]
      host: string
      port: number
      /** True when the jump host is asking rather than the destination. */
      isJump: boolean
    }

export interface AuthPromptField {
  /** The server's wording, shown verbatim — it is the only thing that
   * distinguishes a password from a one-time code. */
  prompt: string
  /** False means the server called this a secret, and the input is masked. */
  echo: boolean
}

/** What a reconnect run is allowed to spend, and whether it may run at all.
 *
 * Mirrors `ReconnectPolicy` in src-tauri/src/session_registry.rs, which clamps
 * both bounds on arrival — these are loop bounds and the webview is not a
 * trusted source of one. Sent on every connect command; a command that receives
 * none uses the backend's own defaults. */
export interface ReconnectPolicy {
  enabled: boolean
  maxAttempts: number
  maxElapsedSeconds: number
}

/** Resolves the two halves of the user's intent — the global setting and the
 * profile's own opt-out — into the policy a connect command carries.
 *
 * Both halves subtract and neither adds, which is why this is an `&&` rather
 * than a precedence table: a profile cannot switch reconnect on when the global
 * setting is off, because the global setting is the one place someone turns the
 * whole behaviour off and expecting them to then audit every saved session
 * would make it useless.
 *
 * The third subtraction is not here and cannot be: the backend refuses to
 * reconnect a session whose credential has to be typed in, and that check stays
 * where the credential is — this can only ever ask. */
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
        // Sent explicitly as null rather than omitted: every argument here is
        // named in the command's signature, and leaving one out relies on the
        // IPC layer's treatment of a missing key rather than on this file
        // saying what it means.
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
      // inputMode is frontend-only (see lib/serial.ts) — Rust only ever
      // needs to know whether it should echo written bytes back itself,
      // which is exactly what 'LocalEcho' means; Readline/ReadlineHex are
      // handled entirely client-side and look like 'Normal' to the backend.
      const { inputMode, ...rest } = source.config
      const config = { ...rest, localEcho: inputMode === 'LocalEcho' }
      return invoke<string>('serial_connect', { config, channel, dataChannel, reconnect })
    }
    case 'serialProfile':
      // No config sent: the backend resolves the adapter's USB identity to
      // whatever COM number it holds right now, which is the entire reason a
      // serial session can be saved at all.
      return invoke<string>('serial_connect_profile', {
        profileId: source.profileId,
        channel,
        dataChannel,
        reconnect,
      })
    case 'elevated':
      // No reconnect policy: an elevated tab is never rebuilt unattended,
      // because every rebuild would be a UAC prompt nobody asked for. The
      // command has no parameter for one.
      return invoke<string>('elevated_connect', {
        shellId: source.shellId,
        channel,
        dataChannel,
        cols,
        rows,
      })
    case 'localProfile':
      // No config sent: the backend re-resolves the shell id against what is
      // installed right now, which is the entire reason a local session can be
      // saved without its path going stale when the shell is upgraded.
      return invoke<string>('local_connect_profile', {
        profileId: source.profileId,
        channel,
        dataChannel,
        cols,
        rows,
        reconnect,
      })
    case 'local':
      // Sends the size, which telnet and serial do not. A pseudoconsole is
      // given its dimensions when it is created and there is no deciding
      // later, so without this the shell draws its first prompt at 80 columns
      // and reflows the moment the real size arrives.
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

/** Which transport's command family a source belongs to.
 *
 * The `*Profile` variants differ from their plain counterparts only in how the
 * connection is *established* — once a session id exists, it is an ordinary
 * session of that transport. Centralised because this was three separate
 * ternaries defaulting to `ssh_*`, which meant every new source variant
 * silently routed its writes and disconnects to the SSH commands until someone
 * noticed. */
export function transportOf(
  source: ConnectionSource,
): 'ssh' | 'telnet' | 'serial' | 'local' | 'elevated' {
  switch (source.protocol) {
    // Its own command family: an elevated session lives in a separate session
    // registry, so `local_write` would never find it.
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

/** Answers one round of keyboard-interactive auth: one response per field, in
 * order, or `null` to cancel. Cancelling abandons the connection rather than
 * sending blanks — an empty answer is a wrong answer, and burns one of the
 * server's limited attempts. */
export function respondAuthPrompt(requestId: string, responses: string[] | null) {
  return invoke<void>('ssh_respond_auth_prompt', { requestId, responses })
}

/** An auto-reconnect in progress, parsed out of the backend's status string.
 *
 * The wire format is `status_label` in src-tauri/src/connection_status.rs —
 * `"reconnecting: <attempt> in <seconds>"`. Keep the two in step; this is the
 * only place that knows the shape. */
export type Reconnecting = { attempt: number; inSeconds: number }

export function parseReconnecting(status: string): Reconnecting | null {
  const match = /^reconnecting: (\d+) in (\d+)$/.exec(status)
  if (!match) return null
  return { attempt: Number(match[1]), inSeconds: Number(match[2]) }
}

/** Whether a status means the session is over — as opposed to merely between
 * connections.
 *
 * `disconnected` is a clean close (the shell exited, the server hung up) and
 * `lost` is the transport going away without being asked to. Both end the
 * session as it was; the difference is that only `lost` may be followed by a
 * `reconnecting` status, which is why the two are separate words at all. */
export function isDisconnect(status: string): boolean {
  return status === 'disconnected' || status === 'lost'
}

/** A connection that *ended*, as opposed to one that was taken away.
 *
 * The remote shell exited, or the server hung up. Nothing is coming back on its
 * own, and nothing should try. */
export function isCleanDisconnect(status: string): boolean {
  return status === 'disconnected'
}

/** Whether the `closeOnDisconnect` setting should close this pane now.
 *
 * **Only a clean end counts.** This used to fire on `lost` as well, which made
 * the setting silently switch auto-reconnect off altogether: closing the pane
 * removes the session id, and removing the session id is precisely what stops a
 * reconnect run. Anyone with the box ticked — it is on by default — got none of
 * the reconnect behaviour, and there was no way to have both.
 *
 * They were never in conflict. The setting's own description is "when a
 * connection ends cleanly (the remote shell exits or the server hangs up)", and
 * that is a different event from the transport dying under a live session. One
 * closes the pane because the work is over; the other is the case auto-reconnect
 * exists for. `disconnected` and `lost` are separate words on the wire for
 * exactly this reason (see `status_label` in connection_status.rs) — this simply
 * stopped throwing the distinction away.
 *
 * A `lost` transport that cannot come back — a session whose credential must be
 * typed, or a retry run that exhausts its budget — therefore leaves the pane
 * open on its disconnect overlay rather than closing it. That is deliberate:
 * the pane is the only place the failure is visible, and the Reconnect button
 * there is the answer to it. */
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
    // The path lives in the saved profile, so the id is all this has — the
    // same position `sshProfile` and `serialProfile` are in, and the status
    // bar resolves it to the profile's own label the same way.
    case 'localProfile':
      return source.profileId
    case 'elevated':
      return shellDisplayName(source.shellId) ?? source.shellId
    // The port isn't known here — it's resolved backend-side at connect
    // time — so the id is all this has. App's status bar resolves it to the
    // profile's own label, the same way it does for sshProfile.
    case 'serialProfile':
      return source.profileId
  }
}
