/**
 * Unix permission bits, in the two shapes a user reads and writes them.
 *
 * `rwxr-xr-x` is what the column shows, because it is scannable — you can see
 * at a glance which of nine bits is missing. `755` is what the field takes,
 * because it is what anyone types and what every piece of documentation they
 * will consult is written in. One module so the two can never disagree about
 * what a mode is.
 *
 * Only the low twelve bits, matching `wr-sftp`: the file-type bits are carried
 * separately by `isDir`/`isSymlink`, and a mode that renders as `100755` is a
 * bug report waiting to happen.
 */

/** The three special bits, which live above the nine ordinary ones. */
const SETUID = 0o4000
const SETGID = 0o2000
const STICKY = 0o1000

/**
 * `0o755` → `rwxr-xr-x`.
 *
 * Setuid, setgid and the sticky bit are folded into the execute column the way
 * `ls` does it — `s`, `s`, `t`, and their capitalised forms when the underlying
 * execute bit is *off*. That capital is not decoration: `rwSr--r--` means
 * setuid is set on a file nobody can execute, which is almost always a mistake,
 * and a renderer that showed it as plain `s` would hide exactly the case worth
 * noticing.
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

/** `0o755` → `755`, `0o1777` → `1777`. What the input field starts from. */
export function formatOctal(mode: number): string {
  // Three digits unless a special bit is set, matching how modes are written:
  // `644`, not `0644`, and `1777` rather than `777` for a sticky directory.
  const special = mode >> 9
  return (special ? special.toString(8) : '') + ((mode & 0o777).toString(8).padStart(3, '0'))
}

/**
 * `"755"` → `0o755`, or null if that is not a mode.
 *
 * Deliberately strict. A field that silently accepts `abc` as `0`, or `8` as
 * something, would hand the host a permission the user did not ask for — and
 * `chmod 000` on the wrong file over SSH is a genuinely bad afternoon. Leading
 * `0` and `0o` are allowed because both are ways people write octal;
 * everything else is refused.
 */
export function parseOctal(input: string): number | null {
  const trimmed = input.trim().replace(/^0o/i, '')
  if (!/^[0-7]{1,4}$/.test(trimmed)) return null
  const mode = parseInt(trimmed, 8)
  return mode <= 0o7777 ? mode : null
}

/** Who the session is connected as, on the host's own terms. A null `uid`
 *  means the host would not say, which is a reason to predict nothing. */
export interface RemoteIdentity {
  uid: number | null
  gids: number[]
  /** Display only. Nothing here decides anything from a name. */
  user: string | null
}

/** What the panel is asking about: the two facts a mode is judged against.
 *
 *  Numeric, and that is the whole point of this revision. SFTP v3 — what
 *  OpenSSH speaks — carries no owner *names* in its attributes, and the
 *  library decodes those fields as null unconditionally. The first version of
 *  this predicate compared names, so it returned "no idea" for every file on
 *  every host and the feature it gated never once fired. */
export interface Ownership {
  mode: number | null
  uid: number | null
  gid: number | null
}

/**
 * Whether this user could write this file — `null` when there is no way to
 * tell.
 *
 * Three states rather than a boolean, and the third is the important one.
 * `false` licenses the panel to skip an attempt it knows will be refused and go
 * straight to sudo; `null` must not, because acting on a guess would put a root
 * password dialog in front of a file the user could have written all along.
 *
 * So every uncertainty resolves to `null`: a host that reported no mode, one
 * that reported no owner, one that would not run `id`.
 *
 * What this cannot see, and why `false` from here is a strong signal while
 * `true` is only a weak one: ACLs, immutable bits, read-only mounts, SELinux
 * and NFS root-squash can all refuse a write the bits permit. That asymmetry is
 * the whole design — a predicted refusal routes to sudo up front, and a
 * predicted success is still allowed to fail and offer sudo afterwards.
 */
export function canWrite(entry: Ownership, identity: RemoteIdentity | null): boolean | null {
  return judge(entry, identity, 0o200, 0o020, 0o002)
}

/** The same question for reading, which decides whether the *open* needs root
 *  rather than only the save. */
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
  // uid 0 is not constrained by the permission bits at all, so there is
  // nothing here to predict a refusal from.
  if (identity.uid === 0) return true

  if (entry.uid === null) return null
  if (entry.uid === identity.uid) return (entry.mode & owner) !== 0
  // A listing with no group cannot be judged against a group list — the file
  // might well belong to one the user is in.
  if (entry.gid === null) return null
  if (identity.gids.includes(entry.gid)) return (entry.mode & group) !== 0
  // Neither the owner nor in its group. This is the case that makes the whole
  // feature worth having: `/etc/*` is typically `0644 root:root`, which lands
  // here as a definite no.
  return (entry.mode & other) !== 0
}

/**
 * Whether opening this file for editing definitely needs root.
 *
 * Editing is read *and* write — the panel downloads a copy and uploads it back
 * — so either being refused is enough. Only ever `true` when the bits say so
 * outright; anything unknown is `false`, so the panel tries the ordinary way
 * and finds out.
 */
export function needsRootToEdit(entry: Ownership, identity: RemoteIdentity | null): boolean {
  return canWrite(entry, identity) === false || canRead(entry, identity) === false
}
