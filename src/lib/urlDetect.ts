/**
 * Finding URLs in a line of terminal output. Pure string work over one
 * logical line (wrapped rows joined; see `ghostty/logicalLines.ts`), returning
 * offsets into it.
 *
 * Every line is attacker-supplied, so two properties are load-bearing: the
 * scan is linear in the line's length, and a host that doesn't read as what
 * it is never becomes a link.
 */

/** One detected URL. `[start, end)` is half-open; the matched text can differ
 *  from `url`, since trailing punctuation is trimmed. */
export interface UrlMatch {
  start: number
  end: number
  url: string
}

/**
 * The scan. `https` and `http` only, since the scheme is handed to the OS
 * opener; bare `www.` isn't matched (it fires on log hostnames).
 *
 * Linear on purpose: one character class under one quantifier, nothing that
 * can backtrack, so hostile output can't hang a frame. Keep that shape.
 *
 * Excluded are characters that delimit URLs in text: whitespace, `<>`,
 * quotes, and RFC 3986's excluded set. Square brackets stay for IPv6
 * literals. Control characters can't come from cells; `isOpenableUrl`
 * rejects them anyway.
 */
const URL_RE = /https?:\/\/[^\s<>"`^{}|\\]+/gi

/** Trailing characters that are punctuation of the sentence, not of the URL. */
const TRAILING_PUNCT = '.,;:!?\'"'

/** Closers that may or may not belong to the URL, and their openers. */
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/**
 * A scheme can't begin mid-word (`xhttps://evil.example`).
 */
function isBoundary(line: string, at: number): boolean {
  if (at === 0) return true
  const prev = line.charCodeAt(at - 1)
  const alpha = (prev >= 0x41 && prev <= 0x5a) || (prev >= 0x61 && prev <= 0x7a)
  const digit = prev >= 0x30 && prev <= 0x39
  return !alpha && !digit
}

/**
 * Drops punctuation the surrounding text owns: `(see https://x/y)` and
 * `https://x/y.` lose the closer and full stop, while
 * `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its parentheses. A closer is
 * dropped only when unmatched. Bracket counts are maintained incrementally so
 * a long run of `)` stays linear.
 */
function trimTrailing(match: string): string {
  const counts = new Map<string, number>()
  for (let i = 0; i < match.length; i++) {
    const ch = match[i]
    if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}') {
      counts.set(ch, (counts.get(ch) ?? 0) + 1)
    }
  }

  let end = match.length
  while (end > 0) {
    const ch = match[end - 1]
    if (TRAILING_PUNCT.includes(ch)) {
      end--
      continue
    }
    const opener = CLOSERS[ch]
    if (opener !== undefined) {
      const closes = counts.get(ch) ?? 0
      const opens = counts.get(opener) ?? 0
      // Balanced or opener-heavy: the closer is the URL's own.
      if (closes <= opens) break
      counts.set(ch, closes - 1)
      end--
      continue
    }
    break
  }
  return match.slice(0, end)
}

/** The authority (userinfo, host, port), or null if there's none. */
function authorityOf(url: string): string | null {
  const at = url.indexOf('://')
  if (at < 0) return null
  const from = at + 3
  let to = url.length
  for (let i = from; i < url.length; i++) {
    const ch = url[i]
    if (ch === '/' || ch === '?' || ch === '#') {
      to = i
      break
    }
  }
  return url.slice(from, to)
}

/**
 * Whether the host reads as what it is. A non-ASCII authority
 * (`https://аpple.com` with a Cyrillic `а`) isn't linked; the text stays
 * readable and copyable. Punycode (`xn--`) is ASCII and offered, as browsers
 * do. The checks before the loop catch all-ASCII authorities that still
 * mislead.
 */
function authorityIsSafe(authority: string | null): boolean {
  if (authority === null || authority.length === 0) return false
  // Userinfo: `https://google.com@evil.example/login` goes to `evil.example`.
  // Deprecated in http(s) and discarded by browsers, so refusing costs nothing.
  if (authority.includes('@')) return false
  // Percent-encoding would smuggle the homoglyphs rejected below
  // (`%D0%B0pple.com` decodes to Cyrillic).
  if (authority.includes('%')) return false
  for (let i = 0; i < authority.length; i++) {
    if (authority.charCodeAt(i) > 0x7e || authority.charCodeAt(i) < 0x21) return false
  }
  return true
}

/** Every URL in `line`, in the order they appear. */
export function findUrls(line: string): UrlMatch[] {
  const out: UrlMatch[] = []
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(line)) !== null) {
    const start = m.index
    if (!isBoundary(line, start)) continue
    const url = trimTrailing(m[0])
    if (url.length === 0) continue
    if (!authorityIsSafe(authorityOf(url))) continue
    out.push({ start, end: start + url.length, url })
  }
  return out
}

/**
 * Whether a URL may be handed to the system opener. Checked again right
 * before opening. On Windows a `file://` or UNC target can leak credentials
 * via SMB authentication, and `vbscript:`, `javascript:` and custom schemes
 * are the same class of problem. Also the only gate for OSC 8 URIs.
 */
export function isOpenableUrl(url: string): boolean {
  const scheme = /^(https?):\/\//i.exec(url)
  if (!scheme) return false
  if (!authorityIsSafe(authorityOf(url))) return false
  // A control character would be invisible in whatever the OS shows.
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return false
  }
  return true
}
