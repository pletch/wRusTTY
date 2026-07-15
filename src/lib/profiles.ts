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
