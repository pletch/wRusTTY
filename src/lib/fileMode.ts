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
