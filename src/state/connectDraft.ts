import { defaultSerialConfig } from '../lib/serial'
import { serialConfigFrom } from '../lib/profiles'
import type { SerialConfig } from '../lib/serial'
import type { ConnectDialogInitial } from '../components/ConnectDialog'

export type Protocol = 'ssh' | 'telnet' | 'serial'

/** Terminal types offered in the session form, most useful first. Blank means
 * "send the default", so it heads the list rather than being a separate
 * concept. Not exhaustive — hence the Custom entry, since the set genuinely
 * isn't closed (vendor strings, `putty-256color`, and so on). */
export const TERM_TYPES: { value: string; label: string }[] = [
  // Labels stay short enough to fit the dialog's 20rem column alongside the
  // dropdown indicator. The qualifier in brackets is the whole reason a
  // caller would pick that row, so it earns its space; anything longer
  // belongs in the field's tooltip, not here.
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

/** Sentinel for the Custom row. Can't collide with a real TERM value — the
 * leading underscores aren't valid in a terminfo entry name. */
export const TERM_CUSTOM = '__custom__'

/** Two states, not three: there is no global preference to inherit from, so
 * the modern value is simply the default and a session either overrides it or
 * doesn't. A profile stored without the field reads as `^?` for the same
 * reason. */
export const BACKSPACE_OPTIONS: { value: string; label: string }[] = [
  { value: 'del', label: '^? (DEL) — modern Unix' },
  { value: 'ctrlh', label: '^H (Ctrl-H) — network / legacy gear' },
]

/** Telnet in 2026 is overwhelmingly network gear, console servers, and
 * legacy systems, so the form pre-selects the value that suits them. Set as
 * a *visible* form default rather than in the protocol's own defaults on the
 * Rust side: the user can see what will be sent and change it in one click,
 * instead of a silent downgrade they'd have to go looking for. */
export const TELNET_DEFAULT_TERM = 'vt100'

/** Sentinel for the "+ New folder..." row in the folder <select>. */
export const NEW_FOLDER_SENTINEL = '__new__'

/** A public-key profile with no keyPath and an existing vault credential
 * means the key itself already lives in the vault. */
export function isInitiallyVaulted(initial: ConnectDialogInitial | undefined): boolean {
  return initial?.authType === 'PublicKey' && initial?.keyPath === undefined && !!initial?.hasCredential
}

/** Everything the connect form's fields hold — one draft profile with
 * cross-field rules, rather than 20 independently-updated useState hooks.
 * Switching protocol resets the port default; authType gates which
 * credential fields are live and meaningful to save; those interactions are
 * reducer cases (and therefore tests) instead of scattered useEffects. */
export interface ConnectDraft {
  protocol: Protocol
  /** Seconds between SSH keepalives, as typed: '' means "use the default",
   * '0' means off. Kept as a string like `port` is, so the field can be
   * cleared while being edited without snapping to a number. */
  keepalive: string
  host: string
  port: string
  username: string
  authType: 'Password' | 'PublicKey' | 'Agent'
  keyPath: string
  keyStorage: 'path' | 'vault'
  passphrase: string
  password: string
  termType: string
  termCustom: boolean
  backspace: string
  label: string
  folder: string
  isNewFolder: boolean
  jumpProfileId: string
  serialConfig: SerialConfig
  logSession: boolean
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
    // Same default this used to be assigned a moment after mount by a
    // useEffect keyed on [protocol, initial?.termType] — folded in here so
    // there's no post-mount flash from '' to the protocol default.
    termType: initial?.termType ?? (protocol === 'telnet' ? TELNET_DEFAULT_TERM : ''),
    // A saved session carrying a value that isn't on the list opens straight
    // into the free-text field, rather than silently snapping to the default.
    termCustom: Boolean(initial?.termType) && !TERM_TYPES.some((t) => t.value === initial?.termType),
    backspace: initial?.backspaceSendsCtrlH ? 'ctrlh' : 'del',
    label: initial?.label ?? '',
    folder: initial?.folder ?? '',
    isNewFolder: false,
    jumpProfileId: initial?.jumpProfileId ?? '',
    keepalive: initial?.keepaliveSeconds == null ? '' : String(initial.keepaliveSeconds),
    // A saved serial session opens on its own stored line settings, same as a
    // saved SSH one opens on its host and user. `portName` here is the port
    // the adapter was last seen on — informational, since the actual port is
    // resolved from the USB identity at connect time.
    serialConfig: initial?.serial ? serialConfigFrom(initial.serial) : defaultSerialConfig(),
    // Ad-hoc "log this whole session from the start" — an alternative to the
    // toolbar toggle (which can only arm logging after a session is already
    // connected, so it can't catch the login banner/MOTD).
    logSession: false,
    // Defaults on whenever we're prefilled from a known profile (picked from
    // the sidebar, or via Edit) — connecting then naturally writes any
    // tweaks back to that same profile instead of leaving them stranded in
    // the form. Doesn't apply to a from-scratch manual connection, where
    // there's no profile yet to update.
    saveProfile: !!initial?.id,
    // On for a session that already has a stored credential: the user chose
    // that once, and an edit of some unrelated field shouldn't quietly read
    // as withdrawing it. Off for anything else, so storing a secret stays an
    // explicit act.
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
      // Only swaps the default — a port the user already customized away
      // from either protocol's default is left alone.
      if (next === 'telnet' && state.port === '22') port = '23'
      if (next === 'ssh' && state.port === '23') port = '22'
      // Switching protocol re-applies that protocol's default terminal
      // type, unless the form was prefilled from a saved session (which
      // carries its own) — deliberately overwrites a hand-picked value,
      // since changing protocol is a large enough context switch that
      // carrying the old terminal type across would be the surprising
      // behaviour, not this.
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
      // Clearing on entry to Custom avoids the free-text box opening
      // pre-filled with the value just replaced.
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
