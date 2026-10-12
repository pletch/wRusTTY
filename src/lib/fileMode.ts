/**
 * Unix permission bits, as `rwxr-xr-x` (the column, scannable) and `755` (the
 * field, what people type). One module so the two agree. Only the low twelve
 * bits, matching `wr-sftp`; the file type is in `isDir`/`isSymlink`.
 */

/** The three special bits, which live above the nine ordinary ones. */
const SETUID = 0o4000
const SETGID = 0o2000
const STICKY = 0o1000

/**
 * `0o755` to `rwxr-xr-x`. Setuid, setgid and sticky fold into the execute
 * column as `ls` does (`s`, `s`, `t`), capitalized when the execute bit is
 * off: `rwSr--r--` is setuid on a non-executable file, usually a mistake.
 */
export function formatMode(mode: number): string {
  const triad = (shift: number, special: number, letter: string) => {
    const bits = (mode >> shift) & 0o7
    const exec = (bits & 1) !== 0
    const has = (mode & special) !== 0
    return (
      (bits & 4 ? 'r' : '-') +
      (bits & 2 ? 'w' : '-') +
      (has ? (exec ? letter : letter.toUpperCase()) : exec ? 'x' : '-')
    )
  }
  return triad(6, SETUID, 's') + triad(3, SETGID, 's') + triad(0, STICKY, 't')
}

/** `0o755` to `755`, `0o1777` to `1777`. What the input field starts from. */
export function formatOctal(mode: number): string {
  // Three digits unless a special bit is set: `644`, but `1777`.
  const special = mode >> 9
  return (special ? special.toString(8) : '') + ((mode & 0o777).toString(8).padStart(3, '0'))
}

/**
 * `"755"` to `0o755`, or null if that's not a mode. Strict, since a wrong
 * chmod over SSH is costly. Leading `0` and `0o` are allowed.
 */
export function parseOctal(input: string): number | null {
  const trimmed = input.trim().replace(/^0o/i, '')
  if (!/^[0-7]{1,4}$/.test(trimmed)) return null
  const mode = parseInt(trimmed, 8)
  return mode <= 0o7777 ? mode : null
}

/** Who the session is connected as. A null `uid` means the host wouldn't say,
 *  so nothing is predicted. */
export interface RemoteIdentity {
  uid: number | null
  gids: number[]
  /** Display only. */
  user: string | null
}

/** The two facts a mode is judged against. Numeric, because SFTP v3 carries
 *  no owner names. */
export interface Ownership {
  mode: number | null
  uid: number | null
  gid: number | null
}

/**
 * Whether this user could write this file, or `null` when there's no way to
 * tell.
 *
 * `false` lets the panel skip a doomed attempt and go to sudo; `null` must
 * not, or a root password dialog would front a file the user could write. So
 * every uncertainty (no mode, no owner, no `id`) is `null`.
 *
 * ACLs, immutable bits, read-only mounts, SELinux and NFS root-squash can
 * refuse what the bits permit, so `false` is a strong signal and `true` a
 * weak one: a predicted success may still fail and offer sudo afterward.
 */
export function canWrite(entry: Ownership, identity: RemoteIdentity | null): boolean | null {
  return judge(entry, identity, 0o200, 0o020, 0o002)
}

/** The same for reading, which decides whether the open needs root. */
export function canRead(entry: Ownership, identity: RemoteIdentity | null): boolean | null {
  return judge(entry, identity, 0o400, 0o040, 0o004)
}

/** Picks the triad that applies to this user and tests one bit of it. */
function judge(
  entry: Ownership,
  identity: RemoteIdentity | null,
  owner: number,
  group: number,
  other: number,
): boolean | null {
  if (!identity || identity.uid === null || entry.mode === null) return null
  // uid 0 isn't constrained by the bits.
  if (identity.uid === 0) return true

  if (entry.uid === null) return null
  if (entry.uid === identity.uid) return (entry.mode & owner) !== 0
  // No group: the user might be in it.
  if (entry.gid === null) return null
  if (identity.gids.includes(entry.gid)) return (entry.mode & group) !== 0
  // Neither owner nor group member: `/etc/*` (`0644 root:root`) lands here.
  return (entry.mode & other) !== 0
}

/**
 * Whether opening this file for editing definitely needs root (an edit reads
 * and writes). Only `true` when the bits say so; unknown is `false`, so the
 * panel tries the ordinary way first.
 */
export function needsRootToEdit(entry: Ownership, identity: RemoteIdentity | null): boolean {
  return canWrite(entry, identity) === false || canRead(entry, identity) === false
}
