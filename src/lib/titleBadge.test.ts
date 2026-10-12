import { describe, expect, it } from 'vitest'
import { titleBadge } from './titleBadge'

describe('titleBadge', () => {
  it('takes the asterisk Claude Code leads its title with', () => {
    expect(titleBadge('✳ Cursor obscuring characters in nano')).toBe('✳️')
  })

  it('takes the spinner frames the same program cycles while it works', () => {
    // Not emoji: Claude Code's spinner frames, hence Geometric Shapes.
    expect(titleBadge('◐ thinking')).toBe('◐')
    expect(titleBadge('◑ thinking')).toBe('◑')
  })

  it('takes a braille spinner, the other alphabet CLIs use for this', () => {
    expect(titleBadge('⠋ installing')).toBe('⠋')
  })

  it('keeps a multi-codepoint emoji whole', () => {
    // Sliced at its first codepoint this would be a bare person.
    expect(titleBadge('\u{1F469}‍\u{1F4BB} building')).toBe('\u{1F469}‍\u{1F4BB}')
  })

  it('keeps a variation selector with the character it modifies', () => {
    expect(titleBadge('✔️ done')).toBe('✔️')
  })

  it('returns nothing for the ordinary titles that make up the strip', () => {
    // The common case; a badge here would be noise on every tab.
    expect(titleBadge('dev@build01: ~/src')).toBeNull()
    expect(titleBadge('vim README.md')).toBeNull()
    expect(titleBadge('root@opnsense.home')).toBeNull()
    expect(titleBadge('/usr/local/bin')).toBeNull()
    expect(titleBadge('[sudo] password')).toBeNull()
    expect(titleBadge('~')).toBeNull()
    expect(titleBadge('"quoted"')).toBeNull()
    expect(titleBadge('3 files changed')).toBeNull()
  })

  it('skips leading whitespace rather than being disqualified by it', () => {
    expect(titleBadge('  ✳ Building')).toBe('✳️')
  })

  it('handles a title that is only the symbol', () => {
    expect(titleBadge('✳')).toBe('✳️')
  })

  it('handles absent and empty titles', () => {
    expect(titleBadge(null)).toBeNull()
    expect(titleBadge(undefined)).toBeNull()
    expect(titleBadge('')).toBeNull()
    expect(titleBadge('   ')).toBeNull()
  })
})

/**
 * Ordinary text never produces a badge, swept over the characters titles
 * realistically start with, since the accepted set is an allowlist of symbol
 * ranges.
 */
describe('titleBadge never fires on ordinary text', () => {
  it('rejects every ASCII character', () => {
    const badged: string[] = []
    for (let cp = 0x20; cp < 0x7f; cp++) {
      const ch = String.fromCodePoint(cp)
      if (titleBadge(`${ch} something`) !== null) badged.push(ch)
    }
    expect(badged).toEqual([])
  })

  it('rejects every Latin-1 character, including © and ®', () => {
    // `©` and `®` are reached by Extended_Pictographic but excluded by name;
    // they're the only two in this range.
    const badged: string[] = []
    for (let cp = 0xa0; cp <= 0xff; cp++) {
      const ch = String.fromCodePoint(cp)
      if (titleBadge(`${ch} something`) !== null) badged.push(ch)
    }
    expect(badged).toEqual([])
  })

  it('rejects accented and non-Latin letters a hostname or path may carry', () => {
    for (const t of ['émile@host', 'Ünal: ~/src', '日本語のタイトル', 'Привет', '中文']) {
      expect(titleBadge(t)).toBeNull()
    }
  })

  it('rejects the box-drawing characters a TUI title might be padded with', () => {
    // Box Drawing is next to Geometric Shapes but excluded: borders, not marks.
    expect(titleBadge('\u2500\u2500 htop \u2500\u2500')).toBeNull()
    expect(titleBadge('\u250C nano')).toBeNull()
  })
})

/**
 * Color presentation: text-default marks get U+FE0F so they render in color,
 * rather than relying on font fallback.
 */
describe('titleBadge color presentation', () => {
  it('asks for the color form of a text-default emoji', () => {
    // U+2733 is Extended_Pictographic but Emoji_Presentation: no.
    expect(titleBadge('\u2733 Building')).toBe('\u2733\uFE0F')
    expect(titleBadge('\u2714 done')).toBe('\u2714\uFE0F')
  })

  it('leaves an already-color emoji alone', () => {
    // Emoji_Presentation: yes, so no selector.
    expect(titleBadge('\u{1F525} hot')).toBe('\u{1F525}')
  })

  it('does not overrule a selector the program chose itself', () => {
    // U+FE0E explicitly asks for text; don't overrule it.
    expect(titleBadge('\u2733\uFE0E Building')).toBe('\u2733\uFE0E')
    expect(titleBadge('\u2733\uFE0F Building')).toBe('\u2733\uFE0F')
  })

  it('leaves the spinner frames as text glyphs', () => {
    // Not emoji, so no color form; they take the tab's color, as in Windows
    // Terminal.
    expect(titleBadge('\u25D0 thinking')).toBe('\u25D0')
    expect(titleBadge('\u280B installing')).toBe('\u280B')
  })

  it('does not append into the middle of a ZWJ sequence', () => {
    // A selector must sit against its base, not after a cluster.
    expect(titleBadge('\u{1F469}\u200D\u{1F4BB} building')).toBe('\u{1F469}\u200D\u{1F4BB}')
  })
})
