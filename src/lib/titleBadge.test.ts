import { describe, expect, it } from 'vitest'
import { titleBadge } from './titleBadge'

describe('titleBadge', () => {
  it('takes the asterisk Claude Code leads its title with', () => {
    expect(titleBadge('✳ Cursor obscuring characters in nano')).toBe('✳️')
  })

  it('takes the spinner frames the same program cycles while it works', () => {
    // Not emoji, and the reason Geometric Shapes is in the accepted set: the
    // badge would otherwise disappear for the seconds it means the most.
    expect(titleBadge('◐ thinking')).toBe('◐')
    expect(titleBadge('◑ thinking')).toBe('◑')
  })

  it('takes a braille spinner, the other alphabet CLIs use for this', () => {
    expect(titleBadge('⠋ installing')).toBe('⠋')
  })

  it('keeps a multi-codepoint emoji whole', () => {
    // Sliced at its first codepoint this is a bare person, which is a
    // different character rather than a truncated one.
    expect(titleBadge('\u{1F469}‍\u{1F4BB} building')).toBe('\u{1F469}‍\u{1F4BB}')
  })

  it('keeps a variation selector with the character it modifies', () => {
    expect(titleBadge('✔️ done')).toBe('✔️')
  })

  it('returns nothing for the ordinary titles that make up the strip', () => {
    // The case that matters most: a badge here would be noise on every tab.
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
 * The property that matters more than any single case: a title made of
 * ordinary text can never produce a badge. The accepted set is an allowlist of
 * symbol ranges rather than a denylist of text, so this is asserted by sweeping
 * the characters a title realistically starts with rather than by listing the
 * ones that happened to come up.
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
    // Those two are Extended_Pictographic and so reached by the accepted set;
    // they are excluded by name because they occur in ordinary text and are
    // never used as status marks. They are the only two in this range.
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
    // Adjacent to Geometric Shapes and deliberately not in it: these are frame
    // pieces, not marks, so a program drawing a border into its title gets no
    // badge from it.
    expect(titleBadge('\u2500\u2500 htop \u2500\u2500')).toBeNull()
    expect(titleBadge('\u250C nano')).toBeNull()
  })
})

/**
 * Colour presentation.
 *
 * The marks worth badging are mostly text-presentation by default, so without
 * an explicit request they render as monochrome glyphs in the tab's own colour
 * — nothing like the green square the user recognises. U+FE0F asks for the
 * colour form rather than betting on Blink's font fallback resolving the way
 * DirectWrite's does in Windows Terminal.
 */
describe('titleBadge colour presentation', () => {
  it('asks for the colour form of a text-default emoji', () => {
    // U+2733 is Extended_Pictographic but Emoji_Presentation: no.
    expect(titleBadge('\u2733 Building')).toBe('\u2733\uFE0F')
    expect(titleBadge('\u2714 done')).toBe('\u2714\uFE0F')
  })

  it('leaves an already-colour emoji alone', () => {
    // Emoji_Presentation: yes — a selector would be noise.
    expect(titleBadge('\u{1F525} hot')).toBe('\u{1F525}')
  })

  it('does not overrule a selector the program chose itself', () => {
    // U+FE0E is an explicit request for the *text* form. Forcing colour over
    // it would be overruling a deliberate statement.
    expect(titleBadge('\u2733\uFE0E Building')).toBe('\u2733\uFE0E')
    expect(titleBadge('\u2733\uFE0F Building')).toBe('\u2733\uFE0F')
  })

  it('leaves the spinner frames as text glyphs', () => {
    // Not emoji at all, so there is no colour form to ask for — and a selector
    // on one would be meaningless. They take the tab's own colour, which is
    // what Windows Terminal shows for them too.
    expect(titleBadge('\u25D0 thinking')).toBe('\u25D0')
    expect(titleBadge('\u280B installing')).toBe('\u280B')
  })

  it('does not append into the middle of a ZWJ sequence', () => {
    // A selector has to sit against its base; appending to the end of a
    // cluster would attach it to the wrong character.
    expect(titleBadge('\u{1F469}\u200D\u{1F4BB} building')).toBe('\u{1F469}\u200D\u{1F4BB}')
  })
})
