import { afterEach, describe, expect, it } from 'vitest'

import {
  displayWidth,
  forgetRemoteCopy,
  joinWrapped,
  rememberRemoteCopy,
  remoteCopyWidth,
} from './joinWrapped'

describe('joinWrapped', () => {
  it('joins every break with one space when the source width is unknown', () => {
    expect(joinWrapped('git log\n  --oneline\n  --graph', null)).toBe('git log --oneline --graph')
  })

  it('drops a POSIX continuation and joins with a space', () => {
    expect(joinWrapped('docker run \\\n  --rm \\\n  alpine', null)).toBe('docker run --rm alpine')
  })

  it('drops a PowerShell backtick continuation', () => {
    expect(joinWrapped('Get-ChildItem `\n    -Recurse', null)).toBe('Get-ChildItem -Recurse')
  })

  it('keeps a backtick that is part of a word', () => {
    expect(joinWrapped('echo `date`\nls', null)).toBe('echo `date` ls')
  })

  it('joins a token cut at the edge of the source pane with nothing between', () => {
    // A 20-column pane, two-space margin, a URL that ran past the edge.
    const copied = ['  curl https://examp', '  le.com/a/b/c'].join('\n')
    expect(joinWrapped(copied, 20)).toBe('curl https://example.com/a/b/c')
  })

  it('joins a word-boundary wrap with a space', () => {
    // Line 1 fills the 20-column pane, so its break is a cut. Line 2 stops
    // short: "uptime" didn't fit, so its break is a space.
    const copied = ['  ssh -i key user@ho', '  st.example.com', '  uptime'].join('\n')
    expect(joinWrapped(copied, 20)).toBe('ssh -i key user@host.example.com uptime')
  })

  it('finds the edge under a right margin', () => {
    // Pane is 24 wide, but the program stopped at 21.
    const copied = ['echo aaaaaaaaaaaaaaaa', 'bbbb and more'].join('\n')
    expect(joinWrapped(copied, 24)).toBe('echo aaaaaaaaaaaaaaaabbbb and more')
  })

  it('treats nothing as cut when no line came near the source width', () => {
    expect(joinWrapped('cd /tmp\nls -la', 80)).toBe('cd /tmp ls -la')
  })

  it('ignores the last line when looking for the edge', () => {
    // A long final line can't have wrapped and mustn't set the edge.
    const copied = ['cd /tmp', 'x'.repeat(78)].join('\n')
    expect(joinWrapped(copied, 80)).toBe(`cd /tmp ${'x'.repeat(78)}`)
  })

  it('ignores a widest line wider than the pane', () => {
    // Not from this pane after all.
    expect(joinWrapped(`${'a'.repeat(30)}\nb`, 20)).toBe(`${'a'.repeat(30)} b`)
  })

  it('skips blank lines and trailing padding', () => {
    expect(joinWrapped('echo one   \n\n   echo two  ', null)).toBe('echo one echo two')
  })

  it('handles CRLF and lone CR', () => {
    expect(joinWrapped('a\r\nb\rc', null)).toBe('a b c')
  })

  it('counts wide characters as two columns when finding the edge', () => {
    // 4 wide chars = 8 columns, a full 8-column pane.
    expect(joinWrapped('日本語字\nです', 8)).toBe('日本語字です')
  })
})

describe('remoteCopyWidth', () => {
  afterEach(forgetRemoteCopy)

  it('returns the width for the text that was copied', () => {
    rememberRemoteCopy('a\nb\n', 100)
    expect(remoteCopyWidth('a\r\nb')).toBe(100)
  })

  it('returns null once the clipboard holds something else', () => {
    rememberRemoteCopy('a\nb', 100)
    expect(remoteCopyWidth('a\nc')).toBeNull()
  })

  it('returns null when nothing was copied', () => {
    expect(remoteCopyWidth('a')).toBeNull()
  })
})

describe('displayWidth', () => {
  it('counts ASCII, wide and zero-width characters', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('日本')).toBe(4)
    expect(displayWidth('é')).toBe(1)
  })
})
