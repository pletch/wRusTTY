import { describe, it, expect } from 'vitest'
import { parseWindowTitle, parseCwd, parseCwdProperty, guessCwdFromTitle } from './remoteIdentity'

describe('parseWindowTitle', () => {
  it('takes the title a shell sets', () => {
    expect(parseWindowTitle('dev@build01: ~/src')).toBe('dev@build01: ~/src')
  })

  it('reports an empty payload as no title', () => {
    // How a shell restores the default, so it has to be distinguishable from
    // a title rather than shown as a blank one.
    expect(parseWindowTitle('')).toBeNull()
    expect(parseWindowTitle('   ')).toBeNull()
  })

  it('strips control characters', () => {
    // An ESC surviving into the status bar would be inert there, but this is
    // the same string that goes into a tooltip and a title attribute.
    expect(parseWindowTitle('before\x1b[31mafter')).toBe('before [31mafter')
    expect(parseWindowTitle('two\nlines')).toBe('two lines')
  })

  it('strips the bidi overrides that let one string read as another', () => {
    expect(parseWindowTitle('safe\u202egnp.exe')).toBe('safe gnp.exe')
  })

  it('bounds a title that is trying to fill the window', () => {
    const title = parseWindowTitle('x'.repeat(1000))!
    expect(title).toHaveLength(200)
    expect(title.endsWith('…')).toBe(true)
  })

  it('keeps a non-ASCII title intact', () => {
    expect(parseWindowTitle('~/プロジェクト')).toBe('~/プロジェクト')
  })
})

describe('parseCwd', () => {
  it('decodes a file URL', () => {
    expect(parseCwd('file://build01/home/dev/src')).toBe('/home/dev/src')
  })

  it('decodes percent-escapes', () => {
    expect(parseCwd('file://build01/home/dev/my%20project')).toBe('/home/dev/my project')
  })

  it('drops the host, which is not ours to report', () => {
    // The pane already says what it is connected to; a second, host-supplied
    // answer beside it is worse than none.
    expect(parseCwd('file://not-the-host-you-connected-to/tmp')).toBe('/tmp')
  })

  it('accepts the bare path some shells send', () => {
    expect(parseCwd('/var/log')).toBe('/var/log')
    expect(parseCwd('~/notes')).toBe('~/notes')
  })

  it('drops the URL grammar slash from a Windows path', () => {
    expect(parseCwd('file:///C:/Users/dev')).toBe('C:/Users/dev')
  })

  it('reports no directory for a URL with no path', () => {
    expect(parseCwd('file://build01')).toBeNull()
  })

  it('ignores anything that is not a path', () => {
    expect(parseCwd('')).toBeNull()
    expect(parseCwd('http://example.com/x')).toBeNull()
    expect(parseCwd('some title that landed here')).toBeNull()
  })

  it('keeps a malformed escape rather than dropping the path', () => {
    // Still readable, and still the host's answer.
    expect(parseCwd('file://h/home/100%')).toBe('/home/100%')
  })

  it('bounds a path that is trying to fill the window', () => {
    const path = parseCwd(`file://h/${'d/'.repeat(500)}`)!
    expect(path).toHaveLength(400)
  })
})

/**
 * OSC 7 is far from universal — a stock bash on Debian or RHEL sets only the
 * window title — so a terminal that reads only OSC 7 will report "no
 * directory" for a session that is plainly showing one. These are the other
 * two roads the same fact travels.
 */
describe('parseCwdProperty', () => {
  it('reads the VS Code shell integration property', () => {
    expect(parseCwdProperty('P;Cwd=/home/dev/src')).toBe('/home/dev/src')
  })

  it('reads it past other properties in the same payload', () => {
    expect(parseCwdProperty('P;IsWindows=False;Cwd=/srv/www')).toBe('/srv/www')
  })

  it("reads iTerm2's form", () => {
    expect(parseCwdProperty('CurrentDir=/var/log')).toBe('/var/log')
  })

  it('accepts a Windows path', () => {
    expect(parseCwdProperty('P;Cwd=C:\\Users\\dev')).toBe('C:\\Users\\dev')
  })

  it('ignores the rest of the sequence family', () => {
    // Prompt and command markers share the number and must fall through to
    // the shell-integration tracker unchanged.
    expect(parseCwdProperty('A')).toBeNull()
    expect(parseCwdProperty('D;0')).toBeNull()
    expect(parseCwdProperty('E;ls -la')).toBeNull()
    expect(parseCwdProperty('P;IsWindows=False')).toBeNull()
    // A property that is not a path at all.
    expect(parseCwdProperty('P;Cwd=not-a-path')).toBeNull()
  })
})

describe('guessCwdFromTitle', () => {
  /** Bash's stock `\u@\h: \w` — the case this exists for. */
  it('takes the path out of a user@host title', () => {
    expect(guessCwdFromTitle('dev@build01: ~/src/wrustty')).toBe('~/src/wrustty')
    expect(guessCwdFromTitle('root@fw1: /etc/frr')).toBe('/etc/frr')
  })

  it('takes a bare path', () => {
    expect(guessCwdFromTitle('/var/log')).toBe('/var/log')
    expect(guessCwdFromTitle('~')).toBe('~')
  })

  it('drops commentary after the path', () => {
    expect(guessCwdFromTitle('~/src — vim')).toBe('~/src')
  })

  /** Everything else is a title, and a title is not a destination. */
  it('offers nothing for a title that is not a path', () => {
    expect(guessCwdFromTitle('vim README.md')).toBeNull()
    expect(guessCwdFromTitle('dev@build01: bash')).toBeNull()
    expect(guessCwdFromTitle('Restarting nginx')).toBeNull()
    expect(guessCwdFromTitle(null)).toBeNull()
    expect(guessCwdFromTitle('')).toBeNull()
  })
})
