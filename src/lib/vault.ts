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

/** How the vault's passwordless unlock method is protected.
 *
 * `hello-unattested` is deliberately distinct from `credential-manager`: the
 * key is still held by Windows Hello and still non-exportable, only the TPM
 * attestation is missing — which usually means Windows hasn't provisioned an
 * attestation key rather than that anything is unprotected. */
export type OsUnlockProtection = 'tpm-attested' | 'hello-unattested' | 'credential-manager'

export interface OsUnlockMethod {
  label: string
  protection: OsUnlockProtection
}

export function osUnlockAvailable() {
  return invoke<boolean>('vault_os_unlock_available')
}

export function osUnlockMethod() {
  return invoke<OsUnlockMethod | null>('vault_os_unlock_method')
}

/** Enrols the strongest method the machine supports — TPM-backed Windows
 * Hello where available, otherwise a key held in Credential Manager. */
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

/** The file dialog runs Rust-side, so the destination path never originates
 * in this process — see `vault_export`'s doc comment. Resolves `false` if the
 * user dismissed the dialog. */
export function exportVault() {
  return invoke<boolean>('vault_export')
}

/** As `exportVault`: the path is chosen Rust-side. Resolves `false` if the
 * user dismissed the dialog, in which case nothing was replaced. */
export function importVault() {
  return invoke<boolean>('vault_import')
}
