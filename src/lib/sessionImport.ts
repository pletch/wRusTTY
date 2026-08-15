/** Running a one-time import from another client, and saying what it did.
 *
 * Importing is deliberately something you go and ask for, once, from
 * Settings → Import — not something the app offers you. It used to prompt: a
 * banner appeared on the connect screen when PuTTY sessions were found, which
 * meant the screen you see most had an offer on it about a decision you make
 * once in the app's whole lifetime. Even settled-once-and-never-again, that is
 * an interruption placed in front of everyone to serve the first five minutes
 * of a migrating user's time here. A button in settings is where a migration
 * action belongs, it is findable months later, and it never appears in front of
 * someone who didn't ask for it.
 *
 * Both sources share this module so their reporting cannot drift: they are the
 * same action against two files, and the fiddly part — what to say when nothing
 * was new — should not be written twice.
 */

import type { SessionImportSummary } from './profiles'
import { importPuttySessions, importSshConfigSessions } from './profiles'
import { toast } from './toast'

/** Runs one import and reports the outcome.
 *
 * Returns whether anything was added, so a caller can decide whether to re-read
 * the session list. Never throws: every call site is a UI handler where an
 * unhandled rejection would be worse than a toast.
 */
async function runImport(source: string, run: () => Promise<SessionImportSummary>) {
  try {
    const summary = await run()
    if (summary.imported === 0) {
      toast.info(`No new sessions to import from ${source} — they are already saved here`)
    } else {
      toast.success(
        `Imported ${summary.imported} ${summary.imported === 1 ? 'session' : 'sessions'} from ${source}`,
      )
    }
    // Said out loud rather than leaving the user to wonder why forty sessions
    // became twelve.
    if (summary.skippedDuplicates > 0) {
      toast.info(`${summary.skippedDuplicates} were already saved and were left as they are`)
    }
    return summary.imported > 0
  } catch (err) {
    toast.error(`Could not import sessions from ${source}: ${String(err)}`)
    return false
  }
}

export function runPuttyImport(): Promise<boolean> {
  return runImport('PuTTY', importPuttySessions)
}

export function runSshConfigImport(): Promise<boolean> {
  return runImport('your SSH config', importSshConfigSessions)
}
