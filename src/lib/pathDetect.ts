/**
 * Finding file paths in a line of terminal output.
 *
 * The sibling of `urlDetect.ts`, with the same contract: one logical line in,
 * half-open offsets out, no knowledge of rows or cells. And the same threat
 * model — every line is attacker-supplied. On an SSH pane the stakes are low:
 * the path is looked up over the SFTP session that pane already has, so the
 * worst a hostile line can do is point the files panel somewhere. On a local
 * pane it is opened on this machine, and the guards for that — no network
 * paths, nothing that runs — live beside the opener, in `local_open.rs`,
 * because this file only finds text.
 *
 * What it is strict about instead is *noise*. Paths are far more common in
 * output than URLs, and far less self-announcing, so only text that is
 * unmistakably a path is offered:
 *
 * - absolute: `/etc/nginx/nginx.conf`
 * - home-relative: `~/src`, and `~` alone
 * - explicitly relative: `./build.sh`, `../lib`
 * - relative with a separator in it: `src/main.rs`
 *
 * A bare name — `README.md` in a listing — is not. Every word of prose would
 * otherwise be a candidate, and there is no way to tell `make` the file from
 * `make` the verb.
 *
 * **No regex does the scanning.** A candidate is a run of non-delimiter
 * characters, found by one pass over the line, and each run is then examined
 * with fixed-cost checks. The obvious pattern for "a word, then a slash" has a
 * greedy class followed by a literal, which backtracks through every start
 * position of a long slash-less run — quadratic on exactly the hostile line
 * `urlDetect` is shaped to survive.
 */

/**
 * Which path syntax the pane's host speaks.
 *
 * `'posix'` for an SSH host. `'windows'` for a local shell, which adds drive
 * letters and backslashes to everything POSIX accepts — Git Bash, and most
 * cross-platform tools, print forward slashes on Windows too.
 */
export type PathFlavor = 'posix' | 'windows'

export interface PathMatch {
  start: number
  end: number
  /** The path as written, with any `:line:col` suffix removed. Not resolved:
   *  that needs the pane's directory, which this file has no business
   *  knowing. */
  path: string
}

/**
 * What ends a candidate. Whitespace; the quotes and brackets shells and prose
 * wrap paths in; and the shell's own operators. Brackets and parentheses are
 * legal in a filename, but a path in `(see /etc/hosts)` is far more common
 * than one with a parenthesis in it.
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
 * Cuts the path off at a `:line` position — `src/main.rs:42:7` from a
 * compiler, `/var/log/syslog:120:kernel: …` from grep. The file is the link;
 * the position, and whatever grep printed after it, are not somewhere the
 * files panel can go.
 *
 * The first `:` followed by digits and then another `:` or the end is the cut.
 * Linear: the digits after one colon are never rescanned from another, since a
 * colon is not a digit.
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

/**
 * The part of a run that is a path, as an offset into it and a length, or
 * null.
 */
function examine(run: string, flavor: PathFlavor): { at: number; text: string } | null {
  // `--config=/etc/x.conf`, `PATH=/usr/bin`: the path is what follows the
  // first `=`. Taken before anything else looks at the run, because the
  // option name in front is not part of anything.
  let at = 0
  const eq = run.indexOf('=')
  if (eq >= 0) at = eq + 1
  let text = run.slice(at)

  // A URL is `urlDetect`'s, and `host:/path` is a path on some *other*
  // machine — `scp` and `rsync` syntax — which this session cannot reach.
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
    // `/` alone is a path, but nearly always a separator in prose ("and / or")
    // or a stray division sign; a path worth clicking has something after it.
    if (text.length < 2) return null
    // `//` opens a network path in some notations and a comment in most
    // languages; neither is a place on this host.
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
  // Needs a separator with something on both sides of it: `foo/` alone is how
  // `ls -F` marks a directory, but it is also the end of "and/" in a wrapped
  // sentence, and a bare name is not offered anyway.
  if (slash <= 0 || slash === text.length - 1) return null
  // A colon before the first separator is `host:path` again.
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
    // `hit.text` may be shorter than what is left of the run — trailing
    // punctuation and a position suffix were dropped from its end — but it
    // always begins where the run (or the part after `=`) does.
    out.push({ start: from, end: from + hit.text.length, path: hit.text })
  }
  return out
}

/**
 * Where a path found by `findPaths` points, as an absolute remote path, or
 * null if there is nothing to resolve it against.
 *
 * `cwd` is the pane's directory as the app last heard it, and may itself be
 * `~`-relative (it can come from a window title). `home` is the remote home
 * directory, needed for either kind of `~`.
 *
 * Normalised lexically — `.` dropped, `..` popped — because SFTP resolves
 * neither reliably and because the files panel shows the path it was given.
 * Lexical `..` is not what the kernel does through a symlink, and that is
 * accepted: the result is looked up before anything is done with it, so the
 * cost of a disagreement is "not found" rather than the wrong file.
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

/** The parent directory of an absolute path from `resolveRemotePath`, and the
 *  name in it. The root has no parent and comes back as its own. */
export function splitRemotePath(abs: string): { dir: string; name: string | null } {
  if (abs === '/') return { dir: '/', name: null }
  const idx = abs.lastIndexOf('/')
  return { dir: idx === 0 ? '/' : abs.slice(0, idx), name: abs.slice(idx + 1) }
}
