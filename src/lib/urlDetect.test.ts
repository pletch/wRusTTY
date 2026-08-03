import { describe, it, expect } from 'vitest'
import { findUrls, isOpenableUrl } from './urlDetect'

/**
 * The detector, exhaustively — it is pure string work, so this is the cheap
 * place to pin behaviour that would otherwise only be observable by hovering
 * a running pane.
 *
 * Three groups matter beyond the obvious: what the surrounding punctuation
 * owns, what a deceptive host does, and what a hostile line costs.
 */

describe('findUrls', () => {
  const cases: [string, string, string[]][] = [
    ['a plain URL', 'see https://example.com/x for more', ['https://example.com/x']],
    ['http as well as https', 'http://example.com', ['http://example.com']],
    ['an uppercase scheme', 'HTTPS://EXAMPLE.COM/A', ['HTTPS://EXAMPLE.COM/A']],
    ['a URL at the very start and end', 'https://a.example https://b.example', ['https://a.example', 'https://b.example']],
    ['two adjacent URLs separated by one space', 'https://a.example/1 https://b.example/2', ['https://a.example/1', 'https://b.example/2']],
    ['a query string and fragment', 'https://x.example/p?a=1&b=2#frag', ['https://x.example/p?a=1&b=2#frag']],
    ['an IPv6 literal with a port', 'try https://[::1]:8080/status', ['https://[::1]:8080/status']],
    ['a percent-encoded path', 'https://x.example/a%20b', ['https://x.example/a%20b']],
    ['a non-ASCII path, which is only the host that matters', 'https://x.example/wiki/Ünicode', ['https://x.example/wiki/Ünicode']],

    // Trailing punctuation: the whole difficulty.
    ['a full stop ending the sentence', 'go to https://example.com/x.', ['https://example.com/x']],
    ['a comma in a list', 'https://a.example/1, https://b.example/2', ['https://a.example/1', 'https://b.example/2']],
    ['other sentence punctuation', 'really? https://x.example/y! yes; https://z.example/w:', ['https://x.example/y', 'https://z.example/w']],
    ['a closing quote', "run 'https://x.example/y'", ['https://x.example/y']],
    ['a parenthesised aside', '(see https://x.example/y)', ['https://x.example/y']],
    ['a bracketed link', '[https://x.example/y]', ['https://x.example/y']],
    ['parentheses that belong to the URL', 'https://en.wikipedia.org/wiki/Foo_(bar)', ['https://en.wikipedia.org/wiki/Foo_(bar)']],
    ['a parenthesised URL that also holds parentheses', '(https://en.wikipedia.org/wiki/Foo_(bar))', ['https://en.wikipedia.org/wiki/Foo_(bar)']],
    ['a full stop after a closing parenthesis', 'see https://x.example/a_(b).', ['https://x.example/a_(b)']],
    ['the angle-bracket form', 'mail said <https://x.example/y> today', ['https://x.example/y']],

    // Things that must not become links.
    ['nothing in a line of ls output', 'drwxr-xr-x 2 tim tim 4096 Aug  1 09:12 src', []],
    ['a bare hostname', 'connecting to www.example.com now', []],
    ['a scheme this does not open', 'file:///etc/passwd and ftp://x.example', []],
    ['a scheme buried in an identifier', 'xhttps://evil.example', []],
    ['a scheme with no authority', 'https:// and https://?x', []],
    ['a Cyrillic homograph host', 'https://аpple.com/login', []],
    ['a non-ASCII host with an ASCII path', 'https://exämple.com/safe', []],
    // The same homograph, percent-encoded: ASCII to every check here and
    // Cyrillic once the browser has decoded it. Refusing only the raw spelling
    // would be a defence against the example rather than the attack.
    ['a percent-encoded homograph host', 'go to https://%D0%B0pple.com/id now', []],
    // Userinfo — the link reads as `google.com` and resolves to
    // `evil.example`. All ASCII, so nothing else here catches it.
    ['userinfo naming a different site', 'see https://google.com@evil.example/login here', []],
    ['userinfo with a password', 'https://www.paypal.com:x@10.0.0.5/', []],
  ]

  for (const [what, line, expected] of cases) {
    it(`finds ${what}`, () => {
      expect(findUrls(line).map((u) => u.url)).toEqual(expected)
    })
  }

  /** `[start, end)` has to index the line the caller passed in, since that is
   *  what maps back to rows and columns. */
  it('reports offsets that slice back to the matched text', () => {
    const line = 'go to https://example.com/x. now'
    const [m] = findUrls(line)
    expect(line.slice(m.start, m.end)).toBe(m.url)
    expect(m.start).toBe(6)
  })

  it('detects a URL ending exactly at the end of the line', () => {
    expect(findUrls('open https://example.com/end').map((u) => u.url)).toEqual([
      'https://example.com/end',
    ])
  })

  /**
   * A line of remote output is attacker-supplied, so the cost of a hostile one
   * has to look like the cost of a friendly one. Two shapes are checked: a
   * very long run with no delimiter, which is what would feed a backtracking
   * pattern, and a very long run of closing brackets, which is what would feed
   * a quadratic trailing-punctuation trim.
   */
  it('stays fast on a pathological line', () => {
    const noDelimiter = 'https://' + 'a'.repeat(200_000)
    const brackets = 'https://x.example/' + ')'.repeat(100_000)
    const started = performance.now()
    expect(findUrls(noDelimiter)).toHaveLength(1)
    expect(findUrls(brackets)[0].url).toBe('https://x.example/')
    // Two orders of magnitude of headroom over what this measures locally
    // (~2ms); the assertion is "linear", not a benchmark.
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('isOpenableUrl', () => {
  it('allows http and https', () => {
    expect(isOpenableUrl('https://example.com')).toBe(true)
    expect(isOpenableUrl('http://example.com/a?b=1')).toBe(true)
  })

  /** The check that matters on Windows: a UNC-flavoured target can provoke an
   *  outbound SMB authentication attempt. */
  it('refuses every other scheme', () => {
    for (const url of [
      'file:///C:/Windows/win.ini',
      'file://attacker.example/share/x',
      '\\\\attacker.example\\share',
      'javascript:alert(1)',
      'vbscript:msgbox',
      'ms-msdt:/id',
      'data:text/html,<script>',
      'example.com',
      '',
    ]) {
      expect(isOpenableUrl(url)).toBe(false)
    }
  })

  /** Both new rejections are on the *authority* alone. A percent-encoded path
   *  is ordinary — half the URLs anyone copies have one — and an `@` after the
   *  first `/` is a path segment, not userinfo. This is also the gate an OSC 8
   *  URI passes, so a false positive here is a link that cannot be opened at
   *  all. */
  it('leaves an encoded path and a path-level @ alone', () => {
    expect(isOpenableUrl('https://x.example/a%20b?q=%7Bid%7D')).toBe(true)
    expect(isOpenableUrl('https://github.com/x/y/blob/main/a@b.ts')).toBe(true)
  })

  it('refuses a deceptive or malformed authority', () => {
    expect(isOpenableUrl('https://%D0%B0pple.com/id')).toBe(false)
    expect(isOpenableUrl('https://google.com@evil.example/login')).toBe(false)
    expect(isOpenableUrl('https://аpple.com')).toBe(false)
    expect(isOpenableUrl('https://')).toBe(false)
    expect(isOpenableUrl('https://example.com/\u0007x')).toBe(false)
  })
})
