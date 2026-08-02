import { describe, it, expect } from 'vitest'
import { parseWindowTitle, parseCwd } from './remoteIdentity'

describe('parseWindowTitle', () => {
  it('takes the title a shell sets', () => {
    expect(parseWindowTitle('tim@build01: ~/src')).toBe('tim@build01: ~/src')
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
    expect(parseCwd('file://build01/home/tim/src')).toBe('/home/tim/src')
  })

  it('decodes percent-escapes', () => {
    expect(parseCwd('file://build01/home/tim/my%20project')).toBe('/home/tim/my project')
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
    expect(parseCwd('file:///C:/Users/tim')).toBe('C:/Users/tim')
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
