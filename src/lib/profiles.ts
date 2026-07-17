import { invoke } from '@tauri-apps/api/core'

export interface SessionProfile {
  id: string
  label: string
  folder: string | null
  host: string
  port: number
  username: string
  authType: 'password' | 'public_key'
  keyPath: string | null
  // Whether a credential for this profile is stored in the vault. Tracked
  // here (not just inferred by asking the vault) because the vault can't
  // be queried at all while it's locked — this flag is what lets a locked
  // session's entry in the sidebar prompt "unlock to connect automatically"
  // instead of just silently falling back to the manual form.
  hasCredential: boolean
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
