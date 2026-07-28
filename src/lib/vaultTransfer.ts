import * as vault from './vault'
import { toast } from './toast'
import type { Ask } from '../components/confirmContext'

/** Backing up and restoring the whole encrypted bundle.
 *
 * Saved session profiles reference vault entries by id, and workspaces
 * reference session profiles by id — each is meaningless without the others,
 * so the bundle carries all three and these two functions move it as a unit.
 *
 * Extracted here because the actions now have two entry points:
 * Settings → Backup & import, which is where someone looks for "how do I back
 * this up", and the vault menu's locked/uninitialized states, which is where
 * someone who *cannot get in* needs to reach a restore. Two entry points are
 * fine; two implementations of a replace-everything action with its own
 * confirmation would rot, which is why the confirm is baked in here rather
 * than left to each caller to remember.
 *
 * `confirm` is passed in rather than imported because it comes from a React
 * context hook, which only a component can call.
 *
 * Both resolve `false` on cancel — of the confirmation *or* of the native file
 * dialog — and never throw: every caller is a UI handler where an unhandled
 * rejection is worse than a toast.
 */

/** Writes the encrypted bundle to a file the user picks. Returns whether one
 * was actually written. */
export async function exportVaultBundle(confirm: Ask): Promise<boolean> {
  // Stated before the file dialog, not after: only the credentials are
  // encrypted. Hostnames, usernames, ports, key paths and jump topology
  // travel as readable JSON, and "vault export" does not suggest that on its
  // own.
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

/** Replaces the vault, sessions and workspaces from a bundle the user picks.
 * Returns whether anything was replaced, so the caller can re-read what it
 * shows. */
export async function importVaultBundle(confirm: Ask): Promise<boolean> {
  // The second sentence is the security-relevant one. An imported session
  // carries a host *and* a key file path, both chosen by whoever wrote the
  // bundle, and connecting to one hands that host a signature from that key —
  // so a bundle from somewhere else can be a request to use your key against
  // someone else's server. Nothing on the Rust side can tell such a profile
  // from a legitimate one; the defence is the user recognising a session they
  // did not create, which needs them to know to look.
  const ok = await confirm({
    title: 'Replace vault and sessions?',
    body: "Importing replaces the current vault, saved sessions, and workspaces. You will need the imported file's master password to unlock it. Only import a file you created yourself: imported sessions can point at any host and any private key file on this machine, so connecting to one you don't recognise can expose that key to whoever wrote the file.",
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
