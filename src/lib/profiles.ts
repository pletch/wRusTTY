import { invoke } from '@tauri-apps/api/core'

export interface SessionProfile {
  id: string
  label: string
  folder: string | null
  host: string
  port: number
  /** Which transport this profile opens. A discriminator rather than a union
   * type: the two share everything that matters (label, folder, host, port,
   * terminal behaviour) and differ only in whether the auth fields apply. */
  protocol: 'ssh' | 'telnet'
  /** SSH only — empty string for telnet. */
  username: string
  /** SSH only — empty string for telnet. */
  authType: 'password' | 'public_key' | 'agent' | ''
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
}

/** One-line endpoint description for a saved session. Shared by the sidebar
 * and the quick-connect palette so the two can't drift — and so adding a
 * third protocol later is one edit, not a hunt. */
export function profileSubtitle(p: SessionProfile): string {
  return p.protocol === 'telnet' ? `telnet ${p.host}:${p.port}` : `${p.username}@${p.host}`
}

export function listSessions() {
  return invoke<SessionProfile[]>('list_sessions')
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
