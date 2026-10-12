import { invoke } from '@tauri-apps/api/core'
import type { InputMode, SerialConfig } from './serial'

export interface SessionProfile {
  id: string
  label: string
  folder: string | null
  host: string
  port: number
  /** Which transport this profile opens. A discriminator rather than a union:
   * the protocols share most fields. */
  protocol: 'ssh' | 'telnet' | 'serial' | 'local'
  /** SSH only; empty string otherwise. */
  username: string
  /** SSH only; empty string otherwise. */
  authType: 'password' | 'public_key' | 'agent' | 'keyboard_interactive' | ''
  keyPath: string | null
  /** Whether the vault holds a credential for this profile. Stored here because
   * a locked vault can't be asked, and the sidebar uses it to offer "unlock to
   * connect automatically". */
  hasCredential: boolean
  /** Another saved profile to jump through (ProxyJump), or `null` to connect
   * directly. */
  jumpProfileId: string | null
  /** Overrides `TERM` in the PTY request; `null` sends `xterm-256color`. */
  termType: string | null
  /** Backspace byte: `true` = ^H, `false` = ^?, `null` = the global setting. */
  backspaceSendsCtrlH: boolean | null
  /** SSH only: seconds between keepalives; null for the 60s default, 0 to
   * disable. Per profile, since idle timeouts belong to the network path. */
  keepaliveSeconds: number | null
  /** How to wake this host before connecting, or null to just connect. */
  wakeOnLan: WakeOnLan | null
  /** Whether this session may reconnect itself when its transport drops. `null`
   * follows the global setting; `false` opts out. Opt-out only: it can't
   * override a global "off" or a credential that must be typed. See
   * `reconnectPolicy`. */
  autoReconnect: boolean | null
  /** Whether this host's shell history may be imported for autocomplete. `null`
   * follows the global setting; `false` opts out. */
  importRemoteHistory: boolean | null
  /** SSH only: `false` connects directly even when Settings names a proxy;
   * null/absent follows the global setting. */
  useProxy?: boolean | null
  /** Start a transcript on connect; null/absent follows the global setting. */
  logSession?: boolean | null
  /** Serial only; null otherwise. */
  serial: SerialProfile | null
  /** Local shells only; null otherwise. */
  local: LocalProfile | null
}

/** Whether this auth type needs a secret from the vault. `agent` (the agent
 * signs) and `keyboard_interactive` (typed at connect) don't; `resolve_auth` in
 * ssh.rs handles both before touching the vault. Shared so the unlock prompt
 * and the sidebar agree. */
export function authNeedsVault(authType: SessionProfile['authType']): boolean {
  return authType !== 'agent' && authType !== 'keyboard_interactive'
}

/** What to send to wake a sleeping host, and where. Only the MAC is required.
 * `broadcast` matters for another subnet (or picking an interface): use that
 * subnet's directed broadcast (`192.168.1.255`) instead of 255.255.255.255. */
export interface WakeOnLan {
  /** Any of `aa:bb:cc:dd:ee:ff`, `aa-bb-...`, `aabb.ccdd.eeff`, bare hex. */
  mac: string
  broadcast: string | null
  /** 9 by convention; 7 on some gear. */
  port: number | null
  /** Seconds to wait for the host to answer; null is 60. */
  waitSeconds: number | null
}

/** A USB serial adapter's stable identity (a COM number belongs to the socket,
 * not the cable). */
export interface UsbIdentity {
  vid: number
  pid: number
  /** Absent on cheap CH340/CP2102 clones. */
  serialNumber: string | null
}

/** How a saved serial session finds its port again. */
export interface PortIdentity {
  /** The port name when saved: the only identity for a non-USB port, and the
   * tiebreaker between identical adapters without serial numbers. */
  portName: string
  usb: UsbIdentity | null
}

/** A saved local shell. Mirrors `LocalProfile` in src-tauri/src/profiles.rs.
 * Stores the detected shell id, which a connect re-resolves (paths change on
 * upgrade), as well as the command. */
export interface LocalProfile {
  /** `pwsh`, `cmd`, `wsl:Ubuntu`; empty for a hand-typed path, used as written. */
  shellId: string
  command: string
  args: string[]
  cwd: string | null
  /** Opens as administrator via the elevated host; absent means no. */
  elevated?: boolean
}

/** A saved serial session: the adapter's identity and line settings. The port
 * is resolved from `identity` at connect time, so no `portName` is stored. */
export interface SerialProfile {
  identity: PortIdentity
  baudRate: number
  dataBits: 'Five' | 'Six' | 'Seven' | 'Eight'
  parity: 'None' | 'Odd' | 'Even'
  stopBits: 'One' | 'Two'
  flowControl: 'None' | 'Software' | 'Hardware'
  localEcho: boolean
  lineEnding: 'Cr' | 'Lf' | 'CrLf'
  /** Frontend-only input mode, stored with the profile (see lib/serial.ts). */
  inputMode: InputMode | null
}

/** One-line endpoint description, shared by the sidebar and the quick-connect
 * palette. */
export function profileSubtitle(p: SessionProfile): string {
  if (p.protocol === 'local') {
    const args = (p.local?.args ?? []).join(' ')
    const command = p.local?.command ?? ''
    // The executable's name only; the row is narrow.
    const exe = command.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? 'shell'
    const line = args ? `${exe} ${args}` : exe
    // Shown in the sidebar so the UAC prompt isn't a surprise.
    return p.local?.elevated ? `${line} · Administrator` : line
  }
  if (p.protocol === 'telnet') return `telnet ${p.host}:${p.port}`
  if (p.protocol === 'serial') {
    // The adapter, not the last-seen COM number.
    const serial = p.serial
    if (!serial) return 'serial'
    const label = serial.identity.usb?.serialNumber ?? serial.identity.portName
    return `${label} @ ${serial.baudRate}`
  }
  return `${p.username}@${p.host}`
}

/** Builds a stored serial session from the connect form. `usb` must come from
 * the port list when the port was picked; it can't be derived later. */
export function serialProfileFrom(config: SerialConfig, usb: UsbIdentity | null): SerialProfile {
  return {
    identity: { portName: config.portName, usb },
    baudRate: config.baudRate,
    dataBits: config.dataBits,
    parity: config.parity,
    stopBits: config.stopBits,
    flowControl: config.flowControl,
    localEcho: config.inputMode === 'LocalEcho',
    lineEnding: config.lineEnding,
    inputMode: config.inputMode,
  }
}

/** The inverse, for editing: shows the last-known port, and re-picking from
 * the live list refreshes the identity. */
export function serialConfigFrom(profile: SerialProfile): SerialConfig {
  return {
    portName: profile.identity.portName,
    baudRate: profile.baudRate,
    dataBits: profile.dataBits,
    parity: profile.parity,
    stopBits: profile.stopBits,
    flowControl: profile.flowControl,
    inputMode: profile.inputMode ?? (profile.localEcho ? 'LocalEcho' : 'Normal'),
    lineEnding: profile.lineEnding,
  }
}

export function listSessions() {
  return invoke<SessionProfile[]>('list_sessions')
}

/** Sends this session's magic packet without probing or connecting. Rejects if
 * no MAC is saved. */
export function wakeSession(profileId: string) {
  return invoke<void>('wake_host', { profileId })
}

export function saveSession(profile: SessionProfile) {
  return invoke<void>('save_session', { profile })
}

export function deleteSession(id: string) {
  return invoke<void>('delete_session', { id })
}

/** Persists a new display order (the full list of ids). */
export function reorderSessions(orderedIds: string[]) {
  return invoke<void>('reorder_sessions', { orderedIds })
}

/** What an import from another client did. */
export interface SessionImportSummary {
  imported: number
  /** Already present by label and host; imports are additive. */
  skippedDuplicates: number
  /** Sessions this app can't represent (for PuTTY: raw, rlogin or hostless). */
  skippedUnsupported: number
  labels: string[]
}

/** How many PuTTY sessions would import (0 without PuTTY or off Windows). */
export function puttySessionCount() {
  return invoke<number>('putty_sessions_available')
}

/** Appends PuTTY's saved sessions; existing label+host matches are left
 * alone. */
export function importPuttySessions() {
  return invoke<SessionImportSummary>('putty_import_sessions')
}

/** How many literal `Host` aliases in `~/.ssh/config` would import. */
export function sshConfigSessionCount() {
  return invoke<number>('ssh_config_sessions_available')
}

/** Appends `~/.ssh/config`'s hosts, additively. `ProxyJump` carries over when
 * the hop is itself a saved session. */
export function importSshConfigSessions() {
  return invoke<SessionImportSummary>('ssh_config_import_sessions')
}
