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

export function osUnlockAvailable() {
  return invoke<boolean>('vault_os_unlock_available')
}

export function enableOsUnlock() {
  return invoke<void>('vault_enable_os_unlock')
}

export function disableOsUnlock() {
  return invoke<void>('vault_disable_os_unlock')
}

export function unlockWithOs() {
  return invoke<void>('vault_unlock_with_os')
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
