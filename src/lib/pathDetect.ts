/**
 * Finding file paths in a line of terminal output.
 *
 * The sibling of `urlDetect.ts`: one logical line in, half-open offsets out,
 * and every line attacker-supplied. On SSH a path is looked up over the
 * pane's SFTP session; on a local pane it's opened on this machine, with the
 * guards (no network paths, nothing that runs) in `local_open.rs`.
 *
 * Strict about noise, offering only unmistakable paths:
 *
 * - absolute: `/etc/nginx/nginx.conf`
 * - home-relative: `~/src`, and `~` alone
 * - explicitly relative: `./build.sh`, `../lib`
 * - relative with a separator: `src/main.rs`
 *
 * A bare name (`README.md`) isn't: `make` the file is indistinguishable from
 * `make` the verb.
 *
 * No regex does the scanning: candidates are runs of non-delimiters found in
 * one pass, then checked at fixed cost. "A word, then a slash" as a regex
 * backtracks quadratically on a long slash-less run.
 */

/**
 * Which path syntax the pane's host speaks: `'posix'` for SSH, `'windows'`
 * for a local shell (POSIX plus drive letters and backslashes).
 */
export type PathFlavor = 'posix' | 'windows'

export interface PathMatch {
  start: number
  end: number
  /** The path as written, minus any `:line:col` suffix. Unresolved. */
  path: string
}

/**
 * What ends a candidate: whitespace, wrapping quotes and brackets, and shell
 * operators. Parentheses are legal in filenames, but `(see /etc/hosts)` is far
 * more common.
 */
function isDelimiter(c: number): boolean {
  return (
    c <= 0x20 ||
    c === 0x22 /* " */ ||
    c === 0x27 /* ' */ ||
    c === 0x60 /* ` */ ||
    c === 0x3c /* < */ ||
    c === 0x3e /* > */ ||
    c === 0x7c /* | */ ||
    c === 0x3b /* ; */ ||
    c === 0x28 /* ( */ ||
    c === 0x29 /* ) */ ||
    c === 0x5b /* [ */ ||
    c === 0x5d /* ] */ ||
    c === 0x7b /* { */ ||
    c === 0x7d /* } */ ||
    c === 0x2c /* , */ ||
    c === 0x7f
  )
}

/** Punctuation the sentence owns rather than the path. */
const TRAILING_PUNCT = '.:!?'

/**
 * Cuts the path at a `:line` position (`src/main.rs:42:7`,
 * `/var/log/syslog:120:kernel: ...`): the first `:` followed by digits and
 * then `:` or the end. Linear.
 */
function stripPosition(s: string): string {
  for (let i = s.indexOf(':'); i >= 0; i = s.indexOf(':', i + 1)) {
    let j = i + 1
    while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x39) j++
    if (j > i + 1 && (j === s.length || s[j] === ':')) return s.slice(0, i)
  }
  return s
}

/** Whether a first character can begin a relative path like `src/main.rs`. */
function startsRelative(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x5f /* _ */ ||
    c === 0x2e /* . */ ||
    c >= 0x80
  )
}

/** `C:\` or `C:/` followed by something. */
function isDriveAbsolute(text: string): boolean {
  const c = text.charCodeAt(0)
  const letter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
  return letter && text[1] === ':' && (text[2] === '\\' || text[2] === '/') && text.length > 3
}

/** The first separator in `text`, or -1. */
function firstSeparator(text: string, flavor: PathFlavor): number {
  const slash = text.indexOf('/')
  if (flavor === 'posix') return slash
  const back = text.indexOf('\\')
  if (slash < 0) return back
  if (back < 0) return slash
  return Math.min(slash, back)
}

/** The part of a run that's a path, as an offset and text, or null. */
function examine(run: string, flavor: PathFlavor): { at: number; text: string } | null {
  // `--config=/etc/x.conf`, `PATH=/usr/bin`: the path follows the first `=`.
  let at = 0
  const eq = run.indexOf('=')
  if (eq >= 0) at = eq + 1
  let text = run.slice(at)

  // A URL is `urlDetect`'s; `host:/path` (scp, rsync) is on another machine.
  if (text.includes('://')) return null

  let end = text.length
  while (end > 0 && TRAILING_PUNCT.includes(text[end - 1])) end--
  text = stripPosition(text.slice(0, end))
  while (text.length > 0 && TRAILING_PUNCT.includes(text[text.length - 1])) {
    text = text.slice(0, -1)
  }
  if (text.length === 0) return null

  if (text === '~') return { at, text }
  const first = text.charCodeAt(0)
  if (first === 0x2f /* / */) {
    // `/` alone is nearly always prose ("and / or") or division.
    if (text.length < 2) return null
    // `//` is a network path or a comment, not a place on this host.
    if (text.charCodeAt(1) === 0x2f) return null
    return { at, text }
  }
  if (text.startsWith('~/') || text.startsWith('./') || text.startsWith('../')) {
    return { at, text }
  }
  if (flavor === 'windows') {
    if (isDriveAbsolute(text)) return { at, text }
    if (text.startsWith('~\\') || text.startsWith('.\\') || text.startsWith('..\\')) {
      return { at, text }
    }
  }
  if (!startsRelative(first)) return null
  const slash = firstSeparator(text, flavor)
  // Needs a separator with something on both sides (`foo/` is often a wrapped
  // "and/").
  if (slash <= 0 || slash === text.length - 1) return null
  // A colon before the first separator is `host:path`.
  const colon = text.indexOf(':')
  if (colon >= 0 && colon < slash) return null
  return { at, text }
}

/** Every path in `line`, in the order they appear. */
export function findPaths(line: string, flavor: PathFlavor = 'posix'): PathMatch[] {
  const out: PathMatch[] = []
  let i = 0
  while (i < line.length) {
    while (i < line.length && isDelimiter(line.charCodeAt(i))) i++
    const start = i
    while (i < line.length && !isDelimiter(line.charCodeAt(i))) i++
    if (i === start) continue
    const hit = examine(line.slice(start, i), flavor)
    if (!hit) continue
    const from = start + hit.at
    // `hit.text` may be shorter than the run (trailing punctuation and position
    // dropped), but starts where the run or the part after `=` does.
    out.push({ start: from, end: from + hit.text.length, path: hit.text })
  }
  return out
}

/**
 * Where a path from `findPaths` points, as an absolute remote path, or null.
 * `cwd` is the pane's last-known directory (possibly `~`-relative); `home` is
 * the remote home.
 *
 * Normalized lexically (SFTP resolves neither `.` nor `..` reliably). Lexical
 * `..` differs from the kernel through symlinks; the result is looked up
 * before use, so a disagreement is "not found", not the wrong file.
 */
export function resolveRemotePath(path: string, cwd: string | null, home: string): string | null {
  const expand = (p: string) => (p === '~' ? home : p.startsWith('~/') ? `${home}/${p.slice(2)}` : p)
  let full: string
  if (path.startsWith('/')) full = path
  else if (path === '~' || path.startsWith('~/')) full = expand(path)
  else {
    if (!cwd) return null
    const base = expand(cwd)
    if (!base.startsWith('/')) return null
    full = `${base}/${path}`
  }
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Splits an absolute path into its parent and name; the root is its own
 *  parent. */
export function splitRemotePath(abs: string): { dir: string; name: string | null } {
  if (abs === '/') return { dir: '/', name: null }
  const idx = abs.lastIndexOf('/')
  return { dir: idx === 0 ? '/' : abs.slice(0, idx), name: abs.slice(idx + 1) }
}
