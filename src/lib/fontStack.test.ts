// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildFontSelection,
  familyForCodepoint,
  formatCodepoint,
  parseCodepoint,
  plainSelection,
  sameRanges,
} from './fontStack'
import type { FontSettings } from './fontStack'

/**
 * A stand-in for the CSS Font Loading API, which jsdom does not implement.
 *
 * It records what was asked for rather than pretending to rasterize: the
 * question these tests answer is whether a face gets declared with the right
 * descriptors and whether the atlas is handed a name that resolves to
 * something, not what the pixels look like.
 */
interface RecordedFace {
  family: string
  source: string
  descriptors: Record<string, string>
}

let declared: RecordedFace[]
let added: string[]
/** Whether a declared face is one the machine actually has. */
let loadSucceeds = true

class FontFaceStub {
  family: string
  constructor(family: string, source: string, descriptors: Record<string, string>) {
    this.family = family
    declared.push({ family, source, descriptors })
  }
  load() {
    return loadSucceeds ? Promise.resolve(this) : Promise.reject(new Error('no such family'))
  }
}

beforeEach(() => {
  declared = []
  added = []
  loadSucceeds = true
  vi.stubGlobal('FontFace', FontFaceStub)
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: (f: FontFaceStub) => added.push(f.family) },
  })
})

/** The settings shape with everything off; each test turns on what it is about.
 *  Families differ between tests on purpose: the generated faces are cached at
 *  module scope, so a shared name would make one test's declaration another
 *  test's cache hit. */
function settings(over: Partial<FontSettings> = {}): FontSettings {
  return {
    fontFamily: 'Consolas, monospace',
    fontFamilyBold: '',
    fontFamilyItalic: '',
    fontFamilyBoldItalic: '',
    fontFeatures: '',
    fontRanges: [],
    ...over,
  }
}

describe('buildFontSelection with nothing configured', () => {
  it('points every style at the body stack and claims no face for any of them', () => {
    const sel = buildFontSelection(settings())
    expect(sel.regular).toBe('Consolas, monospace')
    expect(sel.bold).toBe('Consolas, monospace')
    expect(sel.italic).toBe('Consolas, monospace')
    expect(sel.boldItalic).toBe('Consolas, monospace')
    expect(sel.boldIsFace).toBe(false)
    expect(sel.italicIsFace).toBe(false)
    expect(sel.boldItalicIsFace).toBe(false)
  })

  it('declares no @font-face at all, so an untouched install is untouched', () => {
    buildFontSelection(settings())
    expect(declared).toEqual([])
  })
})

describe('per-style faces', () => {
  it('marks a named slot as a face, so the atlas stops emitting the CSS keyword', () => {
    const sel = buildFontSelection(
      settings({ fontFamilyBold: 'Iosevka Bold', fontFamilyItalic: 'Iosevka Italic' }),
    )
    expect(sel.bold).toBe('Iosevka Bold')
    expect(sel.italic).toBe('Iosevka Italic')
    expect(sel.boldIsFace).toBe(true)
    expect(sel.italicIsFace).toBe(true)
  })

  it('falls bold-italic through to the italic face when only that one is named', () => {
    const sel = buildFontSelection(settings({ fontFamilyItalic: 'Iosevka Italic' }))
    // The slant comes from the face and the weight from CSS — which is why
    // this still counts as a face even though no bold-italic was named.
    expect(sel.boldItalic).toBe('Iosevka Italic')
    expect(sel.boldItalicIsFace).toBe(true)
    // The face supplies the slant only, so CSS still has to embolden it.
    expect(sel.boldItalicNeedsWeight).toBe(true)
  })

  it('asks a dedicated bold-italic face for neither the weight nor the slant', () => {
    const sel = buildFontSelection(
      settings({
        fontFamilyItalic: 'Iosevka Italic',
        fontFamilyBoldItalic: 'Iosevka Bold Italic',
      }),
    )
    expect(sel.boldItalic).toBe('Iosevka Bold Italic')
    expect(sel.boldItalicNeedsWeight).toBe(false)
  })

  it('still asks for nothing when the same face is named in both slots', () => {
    // Which is why the flag is stated rather than inferred from the two
    // families matching: this is that case, and it means the opposite.
    const sel = buildFontSelection(
      settings({ fontFamilyItalic: 'Maple Italic', fontFamilyBoldItalic: 'Maple Italic' }),
    )
    expect(sel.boldItalicNeedsWeight).toBe(false)
  })

  it('leaves bold-italic on the body stack when no italic face exists to fall through to', () => {
    const sel = buildFontSelection(settings({ fontFamilyBold: 'Iosevka Bold' }))
    expect(sel.boldItalic).toBe('Consolas, monospace')
    expect(sel.boldItalicIsFace).toBe(false)
  })
})

describe('OpenType features', () => {
  it('declares the head family again with the features baked in', () => {
    const sel = buildFontSelection(
      settings({ fontFamily: '"Cascadia Code", monospace', fontFeatures: '"ss01" 1' }),
    )
    expect(declared).toHaveLength(1)
    expect(declared[0].source).toBe('local("Cascadia Code")')
    expect(declared[0].descriptors.featureSettings).toBe('"ss01" 1')
    expect(added).toEqual([declared[0].family])
    expect(sel.regular.startsWith('"' + declared[0].family + '"')).toBe(true)
  })

  it('keeps the whole configured stack behind the generated name as fallback', () => {
    const sel = buildFontSelection(
      settings({ fontFamily: '"Cascadia Code", monospace', fontFeatures: '"ss02" 1' }),
    )
    expect(sel.regular).toBe(`"${declared[0].family}", "Cascadia Code", monospace`)
  })

  it('declares the face open across the weight axis, so real bold survives the wrapper', () => {
    buildFontSelection(settings({ fontFamily: 'Recursive Mono', fontFeatures: '"ss03" 1' }))
    expect(declared[0].descriptors.weight).toBe('1 1000')
    // Upright on purpose: an italic slot has to be a face of its own, because
    // asking this one to lean renders the upright glyph instead.
    expect(declared[0].descriptors.style).toBe('normal')
  })

  it('reuses one declaration for the same family and features rather than one per call', () => {
    const s = settings({ fontFamily: 'Berkeley Mono', fontFeatures: '"cv01" 1' })
    const first = buildFontSelection(s)
    const second = buildFontSelection(s)
    expect(declared).toHaveLength(1)
    expect(second.regular).toBe(first.regular)
  })

  it('shares the body wrapper with bold when no bold face is named', () => {
    const sel = buildFontSelection(
      settings({ fontFamily: 'Monaspace Neon', fontFeatures: '"ss04" 1' }),
    )
    expect(sel.bold).toBe(sel.regular)
    expect(declared).toHaveLength(1)
  })

  it('leaves an unset italic slot unwrapped, giving up the features rather than the slant', () => {
    const sel = buildFontSelection(
      settings({ fontFamily: 'JetBrains Mono', fontFeatures: '"ss05" 1' }),
    )
    expect(sel.italic).toBe('JetBrains Mono')
    expect(sel.boldItalic).toBe('JetBrains Mono')
  })

  it('wraps a named italic face, because that slot needs no synthesized slant', () => {
    const sel = buildFontSelection(
      settings({
        fontFamily: 'Maple Mono',
        fontFamilyItalic: 'Maple Mono Italic',
        fontFeatures: '"ss06" 1',
      }),
    )
    expect(declared.map((d) => d.source)).toContain('local("Maple Mono Italic")')
    expect(sel.italic).toBe(`"${declared[1].family}", Maple Mono Italic`)
  })

  it('names the family directly when the feature string is malformed', () => {
    vi.stubGlobal('FontFace', function Throwing() {
      throw new SyntaxError('bad feature string')
    })
    const sel = buildFontSelection(settings({ fontFamily: 'Fira Code', fontFeatures: 'nonsense' }))
    expect(sel.regular).toBe('Fira Code')
  })

  it('drops back to the plain family for later panes once a declaration fails to load', async () => {
    loadSucceeds = false
    const s = settings({ fontFamily: 'Not Installed Mono', fontFeatures: '"ss07" 1' })
    const wrapped = buildFontSelection(s)
    // The stack behind the generated name is what carries the first pane —
    // features lost, glyphs correct, which is the right way round.
    expect(wrapped.regular).toBe(`"${declared[0].family}", Not Installed Mono`)
    await Promise.resolve()
    await Promise.resolve()
    expect(buildFontSelection(s).regular).toBe('Not Installed Mono')
  })
})

describe('familyForCodepoint', () => {
  const ranges = [
    { lo: 0x2500, hi: 0x257f, family: 'Symbols Nerd Font' },
    { lo: 0x4e00, hi: 0x9fff, family: 'Sarasa Mono' },
    { lo: 0xe000, hi: 0xf8ff, family: 'Powerline Extra' },
  ]

  it('finds the family for a codepoint inside a range', () => {
    expect(familyForCodepoint(ranges, 0x4e2d)).toBe('Sarasa Mono')
  })

  it('matches both inclusive ends', () => {
    expect(familyForCodepoint(ranges, 0x2500)).toBe('Symbols Nerd Font')
    expect(familyForCodepoint(ranges, 0x257f)).toBe('Symbols Nerd Font')
  })

  it('returns null between ranges, below the first and above the last', () => {
    expect(familyForCodepoint(ranges, 0x41)).toBeNull()
    expect(familyForCodepoint(ranges, 0x3000)).toBeNull()
    expect(familyForCodepoint(ranges, 0x10000)).toBeNull()
  })

  it('returns null for an empty table', () => {
    expect(familyForCodepoint([], 0x4e2d)).toBeNull()
  })
})

describe('codepoints as the settings dialog types them', () => {
  it('formats to at least four hex digits, upper case, the way the charts do', () => {
    expect(formatCodepoint(0xe000)).toBe('U+E000')
    expect(formatCodepoint(0x41)).toBe('U+0041')
    expect(formatCodepoint(0x1f600)).toBe('U+1F600')
  })

  it('round-trips its own output', () => {
    for (const cp of [0x20, 0x2500, 0x4e2d, 0x10ffff]) {
      expect(parseCodepoint(formatCodepoint(cp))).toBe(cp)
    }
  })

  it('accepts the U+ and 0x prefixes, either case, with surrounding space', () => {
    expect(parseCodepoint('U+e000')).toBe(0xe000)
    expect(parseCodepoint('0XE000')).toBe(0xe000)
    expect(parseCodepoint('  e000  ')).toBe(0xe000)
  })

  it('reads a bare number as hex rather than guessing the base', () => {
    expect(parseCodepoint('1000')).toBe(0x1000)
  })

  it('returns null for a half-typed, malformed or out-of-range codepoint', () => {
    expect(parseCodepoint('')).toBeNull()
    expect(parseCodepoint('U+')).toBeNull()
    expect(parseCodepoint('nope')).toBeNull()
    expect(parseCodepoint('-1')).toBeNull()
    expect(parseCodepoint('110000')).toBeNull()
  })
})

describe('sameRanges', () => {
  const table = [{ lo: 1, hi: 2, family: 'A' }]

  it('is true for an equal-but-separate table, which is what keeps typing cheap', () => {
    expect(sameRanges(table, [{ lo: 1, hi: 2, family: 'A' }])).toBe(true)
  })

  it('is false when an end, a family, the length or the order moves', () => {
    expect(sameRanges(table, [{ lo: 1, hi: 3, family: 'A' }])).toBe(false)
    expect(sameRanges(table, [{ lo: 1, hi: 2, family: 'B' }])).toBe(false)
    expect(sameRanges(table, [])).toBe(false)
    expect(
      sameRanges(
        [table[0], { lo: 5, hi: 6, family: 'B' }],
        [{ lo: 5, hi: 6, family: 'B' }, table[0]],
      ),
    ).toBe(false)
  })
})

describe('plainSelection', () => {
  it('names one stack for every style and pins nothing', () => {
    const sel = plainSelection('monospace')
    expect(sel.regular).toBe('monospace')
    expect(sel.boldItalic).toBe('monospace')
    expect(sel.boldItalicIsFace).toBe(false)
    expect(sel.ranges).toEqual([])
  })
})
