/** Whether the one-time "we found PuTTY sessions" offer has been dealt with.
 *
 * The offer used to sit on the connect screen unconditionally, for as long as
 * PuTTY sessions existed on the machine. That is the screen you see most, and
 * an offer that reappears every time you open a pane — after you have already
 * decided not to take it — is nagging rather than helpful.
 *
 * So it is shown once and then never again: taking it or dismissing it both
 * settle the question permanently. Importing stays reachable from
 * Settings → Import, which is where a migration action belongs anyway, and
 * where someone who dismissed it can still find it months later.
 *
 * Kept out of `TerminalSettings` deliberately. That object is terminal
 * rendering and behaviour config, it is passed down into every pane, and a
 * one-shot flag about a migration banner has no business travelling with it.
 * Its own key, read and written in the two places that care.
 */

import { importPuttySessions } from './profiles'
import { toast } from './toast'

const STORAGE_KEY = 'wrustty.putty-import-offered'

/** True once the offer has been taken or dismissed. Treats a storage failure
 * as "not yet offered": a browser mode with no localStorage should still get
 * the migration path, and the cost of the offer reappearing there is far
 * lower than the cost of never showing it at all. */
export function isPuttyOfferSettled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** Called on both outcomes — imported, or dismissed. There is no separate
 * "dismissed" vs "imported" state because nothing needs to tell them apart:
 * either way the banner's job is done. */
export function settlePuttyOffer(): void {
  try {
    localStorage.setItem(STORAGE_KEY, 'true')
  } catch {
    // Non-fatal: the offer reappears next launch, which is a far better
    // failure than blocking the connect screen on a storage error.
  }
}

/** Runs the import and reports what it did.
 *
 * Shared by the one-time banner and Settings → Import so the two cannot drift:
 * they are the same action offered in two places, and the reporting — which is
 * the fiddly part — should not be written twice. Marks the offer settled on
 * success, so taking it from Settings also stops the banner appearing.
 *
 * Returns whether anything was added, so a caller can decide whether to
 * re-read the session list. Never throws: both call sites are UI handlers
 * where an unhandled rejection would be worse than a toast.
 */
export async function runPuttyImport(): Promise<boolean> {
  try {
    const summary = await importPuttySessions()
    settlePuttyOffer()
    if (summary.imported === 0) {
      toast.info('No new sessions to import — they are already saved here')
    } else {
      toast.success(
        `Imported ${summary.imported} ${summary.imported === 1 ? 'session' : 'sessions'} from PuTTY`,
      )
    }
    // Said out loud rather than leaving the user to wonder why forty sessions
    // became twelve.
    if (summary.skippedDuplicates > 0) {
      toast.info(`${summary.skippedDuplicates} were already saved and were left as they are`)
    }
    return summary.imported > 0
  } catch (err) {
    toast.error(`Could not import PuTTY sessions: ${String(err)}`)
    return false
  }
}
