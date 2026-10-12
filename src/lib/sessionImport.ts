/** Running a one-time import from another client (Settings > Import) and
 * reporting what it did. Both sources share this so their reporting agrees. */

import type { SessionImportSummary } from './profiles'
import { importPuttySessions, importSshConfigSessions } from './profiles'
import { toast } from './toast'

/** Runs one import and reports the outcome. Returns whether anything was
 * added, so the caller can re-read the list. Never throws (UI handlers). */
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
    // Said out loud, so a shrunken count isn't a mystery.
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
