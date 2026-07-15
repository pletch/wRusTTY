import { invoke } from '@tauri-apps/api/core'

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked'

export type VaultSecret =
  | { type: 'Password'; password: string }
  | { type: 'Passphrase'; passphrase: string }

export function status() {
  return invoke<VaultStatus>('vault_status')
}

export function create(masterPassword: string) {
  return invoke<void>('vault_create', { masterPassword })
}

export function unlock(masterPassword: string) {
  return invoke<void>('vault_unlock', { masterPassword })
}

export function lock() {
  return invoke<void>('vault_lock')
}

export function setCredential(sessionId: string, secret: VaultSecret) {
  return invoke<void>('vault_set_credential', { sessionId, secret })
}

export function deleteCredential(sessionId: string) {
  return invoke<void>('vault_delete_credential', { sessionId })
}

export function hasCredential(sessionId: string) {
  return invoke<boolean>('vault_has_credential', { sessionId })
}

export function exportVault(destPath: string) {
  return invoke<void>('vault_export', { destPath })
}

export function importVault(srcPath: string) {
  return invoke<void>('vault_import', { srcPath })
}
