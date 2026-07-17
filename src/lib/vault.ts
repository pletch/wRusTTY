import { invoke } from '@tauri-apps/api/core'

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked'

export type VaultSecret =
  | { type: 'Password'; password: string }
  | { type: 'Passphrase'; passphrase: string }
  | { type: 'PrivateKey'; keyMaterial: string; passphrase: string | null }

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

/** Permanently deletes the vault file (every stored credential with it),
 * the OS-unlock keyring entry, and clears `hasCredential` on every saved
 * session profile — done together on the Rust side so nothing is left
 * pointing at a credential that no longer exists. */
export function deleteVault() {
  return invoke<void>('vault_delete')
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

/** Reads and validates a key file server-side and vaults it whole — the
 * plaintext key never crosses into this (webview) process at all. */
export function importKey(profileId: string, keyPath: string, passphrase: string | null) {
  return invoke<void>('vault_import_key', { profileId, keyPath, passphrase })
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
