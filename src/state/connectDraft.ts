import { defaultSerialConfig } from '../lib/serial'
import { serialConfigFrom } from '../lib/profiles'
import type { SerialConfig } from '../lib/serial'
import { defaultLocalConfig, type LocalConfig } from '../lib/local'
import type { WakeOnLan } from '../lib/profiles'
import type { ConnectDialogInitial } from '../components/ConnectDialog'

export type Protocol = 'ssh' | 'telnet' | 'serial' | 'local'

/** Terminal types offered in the session form, most useful first. Blank sends
 * the default. Custom covers the rest (vendor strings, `putty-256color`). */
export const TERM_TYPES: { value: string; label: string }[] = [
  // Labels fit the dialog's 20rem column; longer explanations go in the tooltip.
  { value: '', label: 'xterm-256color (default)' },
  { value: 'xterm-direct', label: 'xterm-direct (24-bit)' },
  { value: 'xterm', label: 'xterm (PuTTY default)' },
  { value: 'vt100', label: 'vt100 (legacy gear)' },
  { value: 'vt220', label: 'vt220' },
  { value: 'ansi', label: 'ansi' },
  { value: 'linux', label: 'linux' },
  { value: 'screen-256color', label: 'screen-256color' },
  { value: 'tmux-256color', label: 'tmux-256color' },
]

/** Sentinel for the Custom row; underscores can't start a terminfo name. */
export const TERM_CUSTOM = '__custom__'

/** Two states: there's no global preference, so a session overrides the
 * modern default or doesn't. */
export const BACKSPACE_OPTIONS: { value: string; label: string }[] = [
  { value: 'del', label: '^? (DEL) — modern Unix' },
  { value: 'ctrlh', label: '^H (Ctrl-H) — network / legacy gear' },
]

/** Telnet today is mostly network gear and console servers, so the form
 * pre-selects vt100. Set visibly in the form rather than as a hidden backend
 * default. */
export const TELNET_DEFAULT_TERM = 'vt100'

/** Sentinel for the "+ New folder..." row in the folder <select>. */
export const NEW_FOLDER_SENTINEL = '__new__'

/** What the MAC field accepts, as an input `pattern`: `aa:bb:cc:dd:ee:ff`,
 * `aa-bb-...`, Cisco's `aabb.ccdd.eeff`, or bare hex. An empty field (no wake)
 * passes, as it should. Rust re-parses it (`wake::parse_mac`). */
export const MAC_PATTERN =
  '([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}|([0-9A-Fa-f]{4}\\.){2}[0-9A-Fa-f]{4}|[0-9A-Fa-f]{12}'

/** The longest wake wait the backend honors (`wake::MAX_WAIT_SECONDS`),
 * mirrored so the form's `max` refuses it on screen. */
export const MAX_WAKE_WAIT_SECONDS = 600

/** The six bytes as `aa:bb:cc:dd:ee:ff`, or null if that isn't a MAC. Stored
 * canonically so the same address reads the same however it was typed. */
export function normalizeMac(text: string): string | null {
  const hex = text.replace(/[:.\-\s]/g, '')
  if (!/^[0-9A-Fa-f]{12}$/.test(hex)) return null
  return (hex.toLowerCase().match(/../g) ?? []).join(':')
}

/** The wake config a draft describes, or null for "don't wake". An empty MAC
 * is the off switch; an unparseable one is also null (the `pattern` should
 * have stopped it). */
export function wakeOnLanFrom(draft: ConnectDraft): WakeOnLan | null {
  const mac = normalizeMac(draft.wakeMac)
  if (!mac) return null
  return {
    mac,
    // '' means "use the default" for both, as with keepalive.
    broadcast: draft.wakeBroadcast.trim() || null,
    // Not on the form: port 9 vs 7 only matters for unusual NIC firmware.
    port: null,
    // Clamped too: `save_session` refuses anything past the ceiling.
    waitSeconds:
      draft.wakeWait === '' ? null : Math.min(Number(draft.wakeWait), MAX_WAKE_WAIT_SECONDS),
  }
}

/** A public-key profile with no keyPath and an existing vault credential
 * means the key itself already lives in the vault. */
export function isInitiallyVaulted(initial: ConnectDialogInitial | undefined): boolean {
  return initial?.authType === 'PublicKey' && initial?.keyPath === undefined && !!initial?.hasCredential
}

/** Everything the connect form's fields hold: one draft profile with
 * cross-field rules as reducer cases (and tests) rather than scattered
 * useState hooks and effects. */
export interface ConnectDraft {
  protocol: Protocol
  /** Seconds between SSH keepalives, as typed: '' is the default, '0' is off.
   * A string, like `port`, so the field can be cleared while editing. */
  keepalive: string
  /** MAC to wake this host, as typed; '' turns waking off. */
  wakeMac: string
  /** Directed broadcast to send it to; '' is 255.255.255.255. */
  wakeBroadcast: string
  /** Seconds to wait for the host; '' is the backend's 60. */
  wakeWait: string
  host: string
  port: string
  username: string
  authType: 'Password' | 'PublicKey' | 'Agent' | 'Interactive'
  keyPath: string
  keyStorage: 'path' | 'vault'
  passphrase: string
  password: string
  termType: string
  termCustom: boolean
  backspace: string
  /** Whether this session may reconnect itself. Stored only as `false` (opt
   * out) or `null` (follow global); see `savedAutoReconnect` in ConnectDialog. */
  autoReconnect: boolean
  /** Three-state, unlike `autoReconnect`: the global setting is off by default,
   * so allowing per host is as useful as forbidding. `null` follows global. */
  importRemoteHistory: boolean | null
  label: string
  folder: string
  isNewFolder: boolean
  jumpProfileId: string
  serialConfig: SerialConfig
  localConfig: LocalConfig
  /** Open the local shell as administrator (docs/ELEVATED_TABS_PLAN.md). */
  localElevated: boolean
  logSession: boolean
  /** Whether an SSH session uses the Settings proxy; stored only as the
   * opt-out. */
  useProxy: boolean
  saveProfile: boolean
  saveCredential: boolean
}

export function initialConnectDraft(initial: ConnectDialogInitial | undefined): ConnectDraft {
  const protocol: Protocol = initial?.protocol ?? 'ssh'
  const vaulted = isInitiallyVaulted(initial)
  return {
    protocol,
    host: initial?.host ?? '',
    port: String(initial?.port ?? (protocol === 'telnet' ? 23 : 22)),
    username: initial?.username ?? '',
    authType: initial?.authType ?? 'Password',
    keyPath: initial?.keyPath ?? (vaulted ? '' : '~/.ssh/id_ed25519'),
    keyStorage: vaulted ? 'vault' : 'path',
    passphrase: '',
    password: '',
    // The protocol's default, set here so there's no post-mount flash.
    termType: initial?.termType ?? (protocol === 'telnet' ? TELNET_DEFAULT_TERM : ''),
    // A saved value not on the list opens in the free-text field.
    termCustom: Boolean(initial?.termType) && !TERM_TYPES.some((t) => t.value === initial?.termType),
    backspace: initial?.backspaceSendsCtrlH ? 'ctrlh' : 'del',
    autoReconnect: initial?.autoReconnect !== false,
    importRemoteHistory: initial?.importRemoteHistory ?? null,
    label: initial?.label ?? '',
    folder: initial?.folder ?? '',
    isNewFolder: false,
    jumpProfileId: initial?.jumpProfileId ?? '',
    keepalive: initial?.keepaliveSeconds == null ? '' : String(initial.keepaliveSeconds),
    wakeMac: initial?.wakeOnLan?.mac ?? '',
    wakeBroadcast: initial?.wakeOnLan?.broadcast ?? '',
    wakeWait:
      initial?.wakeOnLan?.waitSeconds == null ? '' : String(initial.wakeOnLan.waitSeconds),
    // A saved serial session opens on its stored line settings. `portName` is
    // where the adapter was last seen; the real port is resolved at connect.
    serialConfig: initial?.serial ? serialConfigFrom(initial.serial) : defaultSerialConfig(),
    // Seeded from the profile so re-saving keeps the detected id.
    localConfig: initial?.local
      ? {
          ...defaultLocalConfig(),
          command: initial.local.command,
          args: initial.local.args,
          cwd: initial.local.cwd,
        }
      : defaultLocalConfig(),
    // Seeded from the profile, or from a restored administrator tab, so reopening
    // is one deliberate click (decision 4).
    localElevated: initial?.local?.elevated ?? false,
    // Log from the start, catching the login banner the toolbar toggle can't.
    logSession: initial?.logSession === true,
    useProxy: initial?.useProxy !== false,
    // On when prefilled from a saved profile, so tweaks are written back to it.
    saveProfile: !!initial?.id,
    // On for a session that already has a credential, so editing another field
    // doesn't withdraw it. Otherwise storing a secret stays explicit.
    saveCredential: Boolean(initial?.hasCredential),
  }
}

export type ConnectDraftAction =
  | { type: 'protocolSwitched'; protocol: Protocol; hasInitialTermType: boolean }
  | { type: 'termTypeSelected'; value: string }
  | { type: 'folderSelected'; value: string }
  | { type: 'newFolderCancelled'; initialFolder: string }
  | { [K in keyof ConnectDraft]: { type: 'fieldSet'; field: K; value: ConnectDraft[K] } }[keyof ConnectDraft]

export function connectDraftReducer(state: ConnectDraft, action: ConnectDraftAction): ConnectDraft {
  switch (action.type) {
    case 'protocolSwitched': {
      const next = action.protocol
      let port = state.port
      // Only swaps the default; a customized port is left alone.
      if (next === 'telnet' && state.port === '22') port = '23'
      if (next === 'ssh' && state.port === '23') port = '22'
      // Switching protocol re-applies its default terminal type (unless prefilled
      // from a saved session), overwriting a hand-picked value.
      if (action.hasInitialTermType) {
        return { ...state, protocol: next, port }
      }
      return {
        ...state,
        protocol: next,
        port,
        termCustom: false,
        termType: next === 'telnet' ? TELNET_DEFAULT_TERM : '',
      }
    }

    case 'termTypeSelected': {
      const custom = action.value === TERM_CUSTOM
      // Clear on entering Custom so the free-text box starts empty.
      return { ...state, termCustom: custom, termType: custom ? '' : action.value }
    }

    case 'folderSelected':
      if (action.value === NEW_FOLDER_SENTINEL) return { ...state, isNewFolder: true, folder: '' }
      return { ...state, folder: action.value }

    case 'newFolderCancelled':
      return { ...state, isNewFolder: false, folder: action.initialFolder }

    case 'fieldSet':
      return { ...state, [action.field]: action.value }
  }
}
