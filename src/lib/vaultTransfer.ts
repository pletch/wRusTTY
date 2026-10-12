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
  // Stated before the file dialog: only credentials are encrypted; hostnames,
  // usernames, ports, key paths and jump topology are readable JSON.
  const ok = await confirm({
    title: 'Export vault and sessions',
    body: "The export protects your saved credentials with the vault's master password. Session details — hostnames, usernames, ports, key file paths — are stored in the file as plain text. Keep it somewhere you would keep that list.",
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
    body: "Importing replaces the current vault, saved sessions, and workspaces. You will need the imported file's master password to unlock it. Only import a file you created yourself: imported sessions can point at any host and any private key file on this machine, so connecting to one you don't recognize can expose that key to whoever wrote the file.",
    confirmLabel: 'Import and replace',
  })
  if (!ok) return false
  try {
    if (!(await vault.importVault())) return false
    toast.info(
      'Vault, saved sessions, and workspaces imported — unlock the vault with its master password',
    )
    return true
  } catch (err) {
    toast.error(String(err))
    return false
  }
}
