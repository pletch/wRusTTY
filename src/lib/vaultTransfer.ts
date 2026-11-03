import * as vault from './vault'
import { toast } from './toast'
import type { Ask } from '../components/confirmContext'

/** Backing up and restoring the whole encrypted bundle: vault entries, the
 * sessions that reference them, and the workspaces that reference sessions,
 * moved as a unit.
 *
 * Shared by Settings > Backup & import and the vault menu's locked and
 * uninitialized states, with the confirmation built in. `confirm` comes from a
 * React context hook, so it's passed in.
 *
 * Both resolve `false` on any cancel and never throw, since every caller is a
 * UI handler.
 */

/** Writes the encrypted bundle to a file the user picks. Returns whether one
 * was written. */
export async function exportVaultBundle(confirm: Ask): Promise<boolean> {
  const ok = await confirm({
    title: 'Export vault and sessions',
    body: "The whole file is encrypted, including hostnames and usernames. Opening it takes this vault's master password as it is now, and nothing can recover a lost one.",
    confirmLabel: 'Export',
  })
  if (!ok) return false
  try {
    if (!(await vault.exportVault())) return false
    toast.success('Vault, saved sessions, and workspaces exported')
    return true
  } catch (err) {
    toast.error(String(err))
    return false
  }
}

/** Replaces the vault, sessions and workspaces from a picked bundle. Returns
 * whether anything was replaced. */
export async function importVaultBundle(confirm: Ask): Promise<boolean> {
  // The second sentence matters: an imported session names both a host and a
  // key file, so a foreign bundle can make your key sign for someone else's
  // server. Only the user can recognize a session they didn't create.
  const ok = await confirm({
    title: 'Replace vault and sessions?',
    body: "Importing replaces the current vault, saved sessions, and workspaces. You will need the imported file's master password. Only import a file you created yourself: imported sessions can point at any host and any private key file on this machine, so connecting to one you don't recognize can expose that key to whoever wrote the file.",
    confirmLabel: 'Import and replace',
  })
  if (!ok) return false
  try {
    if (!(await vault.pickImport())) return false
    const imported = await confirm({
      title: 'Enter the master password',
      body: 'The master password this backup was exported with.',
      confirmLabel: 'Import',
      checkPassword: async (password) => {
        try {
          await vault.finishImport(password)
          return null
        } catch (err) {
          return String(err)
        }
      },
    })
    if (!imported) {
      await vault.cancelImport()
      return false
    }
    toast.success('Vault, saved sessions, and workspaces imported')
    return true
  } catch (err) {
    toast.error(String(err))
    return false
  }
}
