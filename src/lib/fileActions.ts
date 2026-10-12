/**
 * What the Files panel will and won't do to a remote entry, and what to name
 * it on local disk. Like `dropUpload.ts`, the rules live in one place so menu
 * items are never offered and then silently do nothing.
 */

import { guessCwdFromTitle } from './remoteIdentity'

/**
 * Where the Files panel should open for a pane, or null for the remote home:
 * the reported directory (OSC 7, OSC 133/633 `P;Cwd=`, OSC 1337), else a guess
 * from the window title (stock Debian/RHEL bash sets only the title).
 *
 * Drops don't act on the title guess without confirmation, since misplacing a
 * file isn't undoable; browsing to the wrong directory costs one click.
 */
export function startDirFor(
  reported: string | null | undefined,
  title: string | null | undefined,
): string | null {
  return reported || guessCwdFromTitle(title ?? null)
}

/**
 * Resolves a leading `~` against the remote home (SFTP has no tilde
 * expansion, and bash titles use `~/src`). Other paths are returned as-is.
 */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (!path.startsWith('~/')) return path
  const rest = path.slice(2)
  return home === '/' ? `/${rest}` : `${home.replace(/\/+$/, '')}/${rest}`
}

/**
 * Whether an operation failed for lack of privilege, the one failure sudo can
 * fix. Matched on the message (OpenSSH's wording for `EACCES`). Deliberately
 * narrow: missing files, full disks and read-only mounts aren't helped by root.
 */
export function isPermissionDenied(error: unknown): boolean {
  return /permission denied/i.test(String(error))
}

export type TransferVerdict = { ok: true } | { ok: false; reason: string }

/**
 * "341 files in 27 directories": what a recursive delete will remove, for a
 * sentence in the confirmation. Zero parts are omitted.
 */
export function describeTree(count: {
  files: number
  dirs: number
  links: number
}): string {
  const parts: string[] = []
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  if (count.files) parts.push(plural(count.files, 'file', 'files'))
  if (count.dirs) parts.push(plural(count.dirs, 'directory', 'directories'))
  if (count.links) parts.push(plural(count.links, 'symbolic link', 'symbolic links'))
  if (parts.length === 0) return 'nothing'
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

// A dropped folder is still refused by `verdictForDrop` (a drop has no path
// to walk); the picker can send folders.

/**
 * Whether a file can be renamed or deleted: not while an edit is watching it
 * (the next save would recreate it). The backend refuses too; this grays out
 * the menu item with the reason.
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
 * What's wrong with a typed name, or null. The remote is POSIX, so separators
 * and `.`/`..` are the hazards. A sentence, shown as the user types.
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
 * Characters Windows forbids in a filename, plus both separators. A set rather
 * than a regex class, where an unescaped hyphen would silently form a range.
 */
const FORBIDDEN = new Set(['<', '>', ':', '"', '|', '?', '*', '/', '\\'])

/** Device names, whatever extension follows. */
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * A remote filename made safe as a save dialog's suggestion. The backend's
 * refusal of such names is the real guard; this just suggests something
 * acceptable. Deliberately simple and lossy, since the field is editable.
 */
export function safeSuggestedName(remoteName: string): string {
  const scrubbed = Array.from(remoteName)
    .map((c) => (FORBIDDEN.has(c) || c.codePointAt(0)! < 0x20 ? '_' : c))
    .join('')
  // Windows strips trailing dots and spaces.
  const cleaned = scrubbed.replace(/[. ]+$/, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'download'
  // `NUL.txt` is still `NUL`.
  return RESERVED.test(cleaned.split('.')[0]) ? `_${cleaned}` : cleaned
}
