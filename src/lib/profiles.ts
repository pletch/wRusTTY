import { invoke } from '@tauri-apps/api/core'
import type { InputMode, SerialConfig } from './serial'

export interface SessionProfile {
  id: string
  label: string
  folder: string | null
  host: string
  port: number
  /** Which transport this profile opens. A discriminator rather than a union
   * type: the two share everything that matters (label, folder, host, port,
   * terminal behaviour) and differ only in whether the auth fields apply. */
  protocol: 'ssh' | 'telnet' | 'serial'
  /** SSH only — empty string for telnet. */
  username: string
  /** SSH only — empty string for telnet. */
  authType: 'password' | 'public_key' | 'agent' | 'keyboard_interactive' | ''
  keyPath: string | null
  // Whether a credential for this profile is stored in the vault. Tracked
  // here (not just inferred by asking the vault) because the vault can't
  // be queried at all while it's locked — this flag is what lets a locked
  // session's entry in the sidebar prompt "unlock to connect automatically"
  // instead of just silently falling back to the manual form.
  hasCredential: boolean
  /** Id of another saved profile to jump through (SSH ProxyJump) before
   * reaching this one — `null` connects directly. */
  jumpProfileId: string | null
  /** Overrides the `TERM` sent with the PTY request — `null` sends
   * `xterm-256color`. */
  termType: string | null
  /** Which byte Backspace sends: `true` = ^H, `false` = ^?, `null` = follow
   * the global terminal setting. */
  backspaceSendsCtrlH: boolean | null
  /** SSH only — seconds between keepalives, null for the 60s default and 0 to
   * disable. Per-profile because the idle timeout that makes it necessary
   * belongs to the network path to one host, not to this machine. */
  keepaliveSeconds: number | null
  /** How to wake this host before connecting, or null to just connect. */
  wakeOnLan: WakeOnLan | null
  /** Whether this session may reconnect itself when its transport drops.
   * `null` — which every profile saved before this field existed reads as —
   * follows the global `autoReconnect` setting, and `false` opts this one
   * session out of it.
   *
   * Opt-out only, deliberately: `true` cannot switch reconnect *on* for a
   * profile when the global setting is off, and neither value can make a
   * session reconnect whose credential has to be typed in each time. A
   * per-profile "always" would therefore be a promise the app cannot keep in
   * two of the three cases it appears to cover. See `reconnectPolicy`. */
  autoReconnect: boolean | null
  /** Serial only — null for SSH and telnet. */
  serial: SerialProfile | null
}

/** Whether connecting with this auth type needs a secret out of the vault.
 *
 * Two auth types don't have one, for opposite reasons: `agent` keeps the key
 * in the agent, which signs on our behalf, and `keyboard_interactive` gets its
 * credential typed in at connect time and never stores it. Both are resolved
 * by `resolve_auth` in ssh.rs before it ever takes the vault lock, so making
 * either wait on an unlock prompt would be asking for a secret that isn't
 * there. Shared so the "should we prompt to unlock?" check and the sidebar's
 * "can this connect directly?" check can't drift apart. */
export function authNeedsVault(authType: SessionProfile['authType']): boolean {
  return authType !== 'agent' && authType !== 'keyboard_interactive'
}

/** What to send to wake a sleeping host, and where.
 *
 * Everything but the MAC is optional and means "use the default" when absent,
 * so the common profile stores a MAC and nothing else. `broadcast` is the one
 * worth setting by hand: a magic packet doesn't route, so reaching a host on
 * another subnet — or picking which interface the packet leaves by on a
 * machine with several — means naming that subnet's directed broadcast
 * (`192.168.1.255`) rather than the default 255.255.255.255. */
export interface WakeOnLan {
  /** Any of `aa:bb:cc:dd:ee:ff`, `aa-bb-...`, `aabb.ccdd.eeff`, bare hex. */
  mac: string
  broadcast: string | null
  /** 9 by convention; 7 on some gear. */
  port: number | null
  /** How long to wait for the host to answer before giving up. Null is 60. */
  waitSeconds: number | null
}

/** The stable identity of a USB serial adapter: a COM number is a property of
 * the socket, not the cable, so it stops meaning anything the moment the
 * adapter is moved. These three don't. */
export interface UsbIdentity {
  vid: number
  pid: number
  /** Absent on cheap CH340/CP2102 clones, which program no serial number. */
  serialNumber: string | null
}

/** How a saved serial session finds its port again. */
export interface PortIdentity {
  /** The port name when the session was saved — the only identity a non-USB
   * port has, and the tiebreaker between identical adapters with no serial
   * number. */
  portName: string
  usb: UsbIdentity | null
}

/** A saved serial session: which adapter, and how to talk to it. There is no
 * `portName` here on purpose — the port is resolved from `identity` at connect
 * time, so storing one as well would let the two contradict each other. */
export interface SerialProfile {
  identity: PortIdentity
  baudRate: number
  dataBits: 'Five' | 'Six' | 'Seven' | 'Eight'
  parity: 'None' | 'Odd' | 'Even'
  stopBits: 'One' | 'Two'
  flowControl: 'None' | 'Software' | 'Hardware'
  localEcho: boolean
  lineEnding: 'Cr' | 'Lf' | 'CrLf'
  /** Frontend-only input mode, stored so it travels with the profile — the
   * backend never interprets it (see lib/serial.ts). */
  inputMode: InputMode | null
}

/** One-line endpoint description for a saved session. Shared by the sidebar
 * and the quick-connect palette so the two can't drift — and so adding a
 * third protocol later is one edit, not a hunt. */
export function profileSubtitle(p: SessionProfile): string {
  if (p.protocol === 'telnet') return `telnet ${p.host}:${p.port}`
  if (p.protocol === 'serial') {
    // Named by the adapter when we have one, because that is what the profile
    // actually points at — the COM number shown is only where it was last
    // seen, and may well not be where it is now.
    const serial = p.serial
    if (!serial) return 'serial'
    const label = serial.identity.usb?.serialNumber ?? serial.identity.portName
    return `${label} @ ${serial.baudRate}`
  }
  return `${p.username}@${p.host}`
}

/** Builds the stored form of a serial session from what the connect form holds.
 *
 * `identity` is the whole point: the form works in COM names, but the profile
 * records the adapter's USB identity so it can be found again after it moves
 * socket. `usb` comes from the port list at the moment the user picked the
 * port — it isn't derivable later, since by then the COM number may belong to
 * something else. */
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

/** The inverse, for populating the form when a saved serial session is edited.
 *
 * `portName` is the *last known* port, which is exactly right for a form the
 * user is about to look at — it shows where the adapter was, and re-picking
 * from the live list is what refreshes both the name and the identity. */
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

/** Sends this session's magic packet and returns — no probe, no connection.
 *
 * The deliberate half of Wake-on-LAN, for wanting the machine up without
 * opening a terminal on it. Rejects if the profile has no MAC saved, which is
 * why the menu item offering this is hidden in that case. */
export function wakeSession(profileId: string) {
  return invoke<void>('wake_host', { profileId })
}

export function saveSession(profile: SessionProfile) {
  return invoke<void>('save_session', { profile })
}

export function deleteSession(id: string) {
  return invoke<void>('delete_session', { id })
}

/** Persists a new display order — `orderedIds` must be the full list of
 * session ids in their desired order. */
export function reorderSessions(orderedIds: string[]) {
  return invoke<void>('reorder_sessions', { orderedIds })
}

/** What a PuTTY import did. */
export interface PuttyImportSummary {
  imported: number
  /** Sessions already present by label and host — the import is additive and
   * never overwrites, so re-running it is harmless. */
  skippedDuplicates: number
  /** Sessions this app can't represent: raw, rlogin, serial, or hostless. */
  skippedUnsupported: number
  labels: string[]
}

/** How many PuTTY sessions this app could open — what *would* import, not what
 * exists, so a machine whose only entry is PuTTY's hostless "Default Settings"
 * reports 0. Always 0 on non-Windows platforms and on Windows without PuTTY. */
export function puttySessionCount() {
  return invoke<number>('putty_sessions_available')
}

/** Appends PuTTY's saved sessions to the session list. Additive: an existing
 * profile with the same label and host is left exactly as it is. */
export function importPuttySessions() {
  return invoke<PuttyImportSummary>('putty_import_sessions')
}
