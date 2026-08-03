/**
 * Finding URLs in a line of terminal output.
 *
 * Pure string work: no core, no DOM, no knowledge of rows or columns. What it
 * is handed is one *logical* line — wrapped rows already joined, see
 * `ghostty/logicalLines.ts` — and what it hands back is offsets into that
 * line, which the caller maps to screen positions.
 *
 * Every line it sees is attacker-supplied. The far end of an SSH or serial
 * connection is untrusted by construction (the same boundary `remoteIdentity`
 * and `osc52` document), so two properties are load-bearing rather than nice
 * to have: the scan is linear in the length of the line, and a host that does
 * not read as what it is does not become a link at all.
 */

/** One detected URL. `[start, end)` is half-open, so `line.slice(start, end)`
 *  is the matched text — which is not necessarily `url`, since trailing
 *  punctuation is trimmed off the end of the match. */
export interface UrlMatch {
  start: number
  end: number
  url: string
}

/**
 * The scan.
 *
 * `https` and `http` only, until there is a reason for more: a scheme this
 * hands to the OS opener is a scheme an attacker chose. Bare `www.` is
 * deliberately not matched — it fires on hostnames in ordinary log output.
 *
 * **The pattern is linear on purpose.** One character class under one
 * quantifier: no nested repeat, no alternation inside a repeat, nothing that
 * can backtrack. A pattern that backtracks catastrophically turns `cat` of a
 * hostile file into a hung frame, which is a denial of service delivered as
 * ordinary output. Anything added here must preserve that shape.
 *
 * The excluded characters are the ones that reliably delimit a URL in text
 * rather than appear in one: whitespace, the angle brackets of the `<url>`
 * form, quotes that shells and prose wrap URLs in, and the characters RFC 3986
 * excludes outright. Square brackets stay in for IPv6 literals
 * (`https://[::1]:8080/`); a stray one from `[https://x]` is dealt with below.
 *
 * Control characters are not excluded because a line assembled from terminal
 * cells cannot contain one — the core has already turned them into cursor
 * movement or dropped them. `isOpenableUrl` rejects them anyway, which is
 * where a URI that did not come from cells (OSC 8, later) would be caught.
 */
const URL_RE = /https?:\/\/[^\s<>"`^{}|\\]+/gi

/** Trailing characters that are punctuation of the sentence, not of the URL. */
const TRAILING_PUNCT = '.,;:!?\'"'

/** Closers that may or may not belong to the URL, and their openers. */
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/**
 * A scheme cannot begin in the middle of a word. Without this,
 * `xhttps://evil.example` — or any identifier that happens to end in `http` —
 * produces a link over text that reads as something else entirely.
 */
function isBoundary(line: string, at: number): boolean {
  if (at === 0) return true
  const prev = line.charCodeAt(at - 1)
  const alpha = (prev >= 0x41 && prev <= 0x5a) || (prev >= 0x61 && prev <= 0x7a)
  const digit = prev >= 0x30 && prev <= 0x39
  return !alpha && !digit
}

/**
 * Drops the punctuation the surrounding text owns.
 *
 * This is the whole difficulty of detection. `(see https://x/y)` and
 * `https://x/y.` must not swallow the closer or the full stop, while
 * `https://en.wikipedia.org/wiki/Foo_(bar)` must keep its parentheses — so a
 * closer is dropped only when the match holds no opener to match it against.
 *
 * The bracket counts are computed once and maintained as characters come off
 * the end, rather than recounted per character: a line ending in a few
 * thousand `)` is exactly the kind of input this has to survive, and
 * recounting would make it quadratic — the same failure the regex is shaped to
 * avoid, arrived at from the other side.
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

/**
 * The authority component — userinfo, host and port — or null if there is
 * none.
 */
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
 * Whether the host reads as what it is.
 *
 * `https://аpple.com` with a Cyrillic `а` is a different site than it appears
 * to be, and this app already strips the format characters that play the same
 * trick out of the status bar's remote text (`remoteIdentity.ts`). A URL whose
 * authority is not plain ASCII is not offered as a link at all — the text
 * still sits in the buffer to be read and copied, which is the honest outcome
 * for a destination we cannot render unambiguously. Punycode (`xn--…`) reaches
 * here as ASCII and is offered, which is the same trade every browser makes.
 *
 * The two rejections above the loop are the ways an all-ASCII authority still
 * reads as somewhere it isn't — see each.
 */
function authorityIsSafe(authority: string | null): boolean {
  if (authority === null || authority.length === 0) return false
  // Userinfo. `https://google.com@evil.example/login` is a link to
  // `evil.example` whose first sixteen characters say otherwise, and reading
  // past the `@` is precisely the thing nobody does — it is the oldest URL
  // phishing trick there is. Showing the full URL in the link menu does not
  // help, because the full URL is the misleading string. Userinfo is
  // deprecated in http/https and every browser discards it, so refusing to
  // linkify costs nothing that works anyway.
  if (authority.includes('@')) return false
  // Percent-encoding, which otherwise smuggles the very homoglyphs the loop
  // below exists to reject: `%D0%B0pple.com` is plain ASCII here and Cyrillic
  // `аpple.com` by the time the browser has decoded it and resolved the IDN.
  // The raw form is already refused; without this the defence holds only
  // against the spelling of the attack, not the attack.
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
 * Whether a URL may be handed to the system opener.
 *
 * Checked again immediately before opening, not only at detection: the opener
 * passes the string to the OS, and the two points are far enough apart in the
 * code that this is not the same check twice. On Windows in particular a
 * `file://` or UNC-flavoured target can provoke an outbound SMB authentication
 * attempt and leak credentials to a host of the attacker's choosing;
 * `vbscript:`, `javascript:` and whatever custom schemes other installed
 * software has registered are the same class of problem.
 *
 * Also the gate an OSC 8 URI has to pass when that arrives — there the URI is
 * whatever the program declared rather than something this file matched, so
 * this is the only check it ever sees.
 */
export function isOpenableUrl(url: string): boolean {
  const scheme = /^(https?):\/\//i.exec(url)
  if (!scheme) return false
  if (!authorityIsSafe(authorityOf(url))) return false
  // A control character anywhere would be invisible in whatever the OS shows
  // the user before it acts on this.
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return false
  }
  return true
}
