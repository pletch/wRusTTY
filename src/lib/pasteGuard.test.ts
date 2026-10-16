import { describe, expect, it } from 'vitest'

import { countLines, pasteNeedsNoConfirm, stripTrailingNewline } from './pasteGuard'

describe('pasteNeedsNoConfirm', () => {
  it('lets a single line through when the engine agrees', () => {
    expect(pasteNeedsNoConfirm('ls -la', true)).toBe(true)
  })

  it('asks for a lone carriage return even when the engine calls it safe', () => {
    // What the engine said before upstream 5c9a3d8a9. This rule alone would
    // have blocked it.
    expect(pasteNeedsNoConfirm('cd /tmp\rrm -rf build\rls', true)).toBe(false)
  })

  it('asks for any line ending, whatever the engine says', () => {
    for (const text of ['a\nb', 'a\r\nb', 'a\rb']) {
      expect(pasteNeedsNoConfirm(text, true)).toBe(false)
    }
  })

  it('asks when the engine refuses a single line', () => {
    // A single line carrying a bracketed-paste terminator looks ordinary.
    expect(pasteNeedsNoConfirm('echo \x1b[201~ hi', false)).toBe(false)
  })

  it('falls back to the line count when the engine cannot say', () => {
    expect(pasteNeedsNoConfirm('ls', null)).toBe(true)
    expect(pasteNeedsNoConfirm('ls', undefined)).toBe(true)
    expect(pasteNeedsNoConfirm('a\rb', null)).toBe(false)
  })
})

describe('the line helpers', () => {
  it('counts CR, LF and CRLF as one line ending each', () => {
    expect(countLines('a')).toBe(1)
    expect(countLines('a\nb\rc\r\nd')).toBe(4)
  })

  it('strips exactly one trailing line ending', () => {
    expect(stripTrailingNewline('ls\n')).toBe('ls')
    expect(stripTrailingNewline('ls\r')).toBe('ls')
    expect(stripTrailingNewline('ls\r\n')).toBe('ls')
    expect(stripTrailingNewline('ls\n\n')).toBe('ls\n')
  })
})
