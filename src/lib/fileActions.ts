/**
 * What the Files panel will and won't do to a remote entry — and what to call
 * it once it lands on local disk.
 *
 * The same idea as `dropUpload.ts`, for the other direction: the rules are the
 * feature, and they are worth reading in one place rather than inferred from a
 * context-menu handler. A menu item that is offered and then silently does
 * nothing is the failure mode both files exist to prevent.
 */

import { guessCwdFromTitle } from './remoteIdentity'

/**
 * Where the Files panel should open for a pane, or null to use the remote home.
 *
 * Two sources, in order of how much they can be trusted:
 *
 * 1. **What the host reported** — OSC 7, OSC 133/633's `P;Cwd=`, OSC 1337's
 *    `CurrentDir=`. This is a fact, and it is the same one a file dropped on
 *    the pane uses as its destination.
 * 2. **What the window title implies.** A stock bash on Debian or RHEL sets
 *    `\[\e]0;\u@\h: \w\a\]` and *nothing else* — no OSC 7 at all — which is a
 *    large share of the hosts this app talks to. Without this the panel opens
 *    at the home directory for all of them, however plainly the title says
 *    otherwise.
 *
 * The drop deliberately refuses to act on (2): it prefills a prompt and makes
 * the user confirm, because a title is a guess and putting a file somewhere the
 * user did not choose is not undoable. Browsing has no such asymmetry — landing
 * in the wrong directory costs one click of the up arrow — so the panel takes
 * the guess where the drop will not. That difference is the whole reason this
 * function exists rather than the two sharing one rule.
 */
export function startDirFor(
  reported: string | null | undefined,
  title: string | null | undefined,
): string | null {
  return reported || guessCwdFromTitle(title ?? null)
}

/**
 * Resolves a leading `~` against the remote home.
 *
 * `\w` in a bash prompt renders the home directory as `~` and its children as
 * `~/src`, so the titles [`startDirFor`] reads are full of them — and SFTP has
 * no tilde expansion. Sent as-is, `~/src` asks for a directory literally called
 * `~`, and the panel falls back to home having been told exactly where to go.
 *
 * Anything without a leading `~` is returned untouched, including a path that
 * merely contains one.
 */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (!path.startsWith('~/')) return path
  const rest = path.slice(2)
  return home === '/' ? `/${rest}` : `${home.replace(/\/+$/, '')}/${rest}`
}

/** Everything about an entry and the panel that decides whether it can be sent
 *  or fetched. */
export interface TransferState {
  /** Directories need the recursive queue neither direction has yet. */
  isDir: boolean
  /** A transfer is already running in this panel. */
  busy: boolean
}

export type TransferVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Ordered the same way `verdictForDrop` is, and for the same reason: the first
 * true refusal is the one worth reporting. Being told "pick a file, not a
 * folder" while the real obstacle is the transfer already running would send
 * someone off solving the wrong problem — and unlike the folder limit, that one
 * clears on its own.
 */
export function verdictForDownload(state: TransferState): TransferVerdict {
  if (state.busy) {
    return { ok: false, reason: 'One transfer at a time — wait for the current one to finish.' }
  }
  if (state.isDir) {
    return { ok: false, reason: 'Downloading a folder is not supported yet — pick a file.' }
  }
  return { ok: true }
}

/**
 * Whether a file can be renamed or deleted — the two things a live edit watch
 * makes unsafe.
 *
 * A watch holds the remote path it re-uploads to and nothing re-targets it, so
 * renaming a watched file means the next save recreates the old name beside the
 * new one, and deleting one means the next save brings it back. Minutes later,
 * triggered by the user saving in an editor they have every reason to think is
 * still pointed at the right file, and reported as a success.
 *
 * The backend refuses these too — it owns the authoritative watch list, and this
 * one is seeded from it. Checked here as well so the menu item can be greyed out
 * with the reason attached, rather than offered and then rejected.
 */
export function verdictForMutation(state: { watched: boolean }): TransferVerdict {
  if (state.watched) {
    return {
      ok: false,
      reason: 'This file is open for editing — stop watching it first.',
    }
  }
  return { ok: true }
}

/**
 * What's wrong with a name the user typed, or null if nothing is.
 *
 * The remote host is POSIX whatever this client is running on, so the rules are
 * narrower than `safeSuggestedName`'s: a separator or a `..` is the hazard,
 * because the name gets joined onto the directory the user is looking at and
 * anything else would act somewhere they did not choose.
 *
 * Returns a sentence rather than a boolean because it is shown as the user
 * types — the point is to say what to fix before a round trip does.
 */
export function nameError(name: string): string | null {
  if (!name) return 'Name cannot be empty.'
  if (name === '.' || name === '..') return `"${name}" is not a name.`
  if (name.includes('/') || name.includes('\\')) return 'A name cannot contain a slash.'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return 'A name cannot contain control characters.'
  return null
}

/**
 * Characters Windows forbids in a filename, plus the two separators that would
 * make the "name" a path. A remote host is entitled to use any of them; a save
 * dialog opened on one is not.
 *
 * A set rather than a regex character class on purpose. Escaping a class
 * containing both slashes and a literal hyphen is the kind of thing that reads
 * as correct and silently becomes a *range* — `* -\` spans most of ASCII — and
 * the failure would be a suggested filename with its letters replaced.
 */
const FORBIDDEN = new Set(['<', '>', ':', '"', '|', '?', '*', '/', '\\'])

/** Names that are devices, not files, whatever extension follows. */
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * A remote filename, made safe to hand a save dialog as its starting suggestion.
 *
 * The backend refuses these names outright — writing to `NUL` opens the null
 * device and reports success, which would cost the user the download while
 * telling them it worked. That refusal is the guarantee and stays where it is.
 * This is the courtesy in front of it: the dialog opens already showing a name
 * the user can accept, rather than one they are told is invalid only after they
 * have picked a folder for it.
 *
 * Deliberately lossy and deliberately not clever. It is a *suggestion* in an
 * editable field; the user has the final say, and a mangled default costs far
 * less than a guess at what they meant.
 */
export function safeSuggestedName(remoteName: string): string {
  const scrubbed = Array.from(remoteName)
    .map((c) => (FORBIDDEN.has(c) || c.codePointAt(0)! < 0x20 ? '_' : c))
    .join('')
  // Trailing dots and spaces are stripped during Windows path normalisation,
  // so a name ending in one is not the name that would get written.
  const cleaned = scrubbed.replace(/[. ]+$/, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'download'
  // `NUL.txt` is still `NUL`, hence the test against the stem rather than the
  // whole name.
  return RESERVED.test(cleaned.split('.')[0]) ? `_${cleaned}` : cleaned
}
