import { describe, it, expect, afterEach } from 'vitest'
import {
  PRESET_THEMES,
  THEME_COLOR_KEYS,
  PALETTE_ROWS,
  SURFACE_FIELDS,
  copyOfTheme,
  findTheme,
  getCustomThemes,
  hexToRgb,
  isHexColor,
  sanitizeCustomThemes,
  setCustomThemes,
  uniqueThemeName,
  backgroundWithOpacity,
  backgroundTint,
  stripOverlay,
  tabHoverWash,
  type TerminalTheme,
} from './theme'

// The custom-theme registry is module state, so a test that sets it would
// otherwise decide what `findTheme` returns for every test after it.
afterEach(() => setCustomThemes([]))

/** Whether a preset is one of the light ones, worked out here rather than
 *  imported: the tests below exist to check that the code's own answer to
 *  this drives the chrome correctly, and asking it the same question twice
 *  would check nothing. Was a `name !== 'Light'` list until there was more
 *  than one light preset. */
function looksLight(theme: TerminalTheme): boolean {
  const [r, g, b] = hexToRgb(theme.background)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b >= 128
}

/** A minimal well-formed custom theme, for the tests that only care about
 *  one field of one. */
function customTheme(name: string, overrides: Partial<TerminalTheme> = {}): TerminalTheme {
  return { ...PRESET_THEMES[0], name, ...overrides }
}

describe('findTheme', () => {
  it('finds a preset by exact name', () => {
    expect(findTheme('Dracula')?.name).toBe('Dracula')
  })

  it('falls back to the first preset for an unknown name', () => {
    expect(findTheme('not-a-real-theme')).toBe(PRESET_THEMES[0])
  })

  // Campbell is the Windows console default (conhost and Windows Terminal's
  // stock profile), so it is the one preset whose values are not ours to
  // taste-tune: it exists so a pane can match what the same command looks
  // like in native PowerShell. Pinned against the published Microsoft
  // values rather than eyeballed, since drift here silently defeats the
  // only reason the theme is in the list.
  it('matches the Windows console Campbell palette exactly', () => {
    const campbell = findTheme('Campbell')
    expect(campbell.name).toBe('Campbell')
    expect(campbell.background).toBe('#0c0c0c')
    expect(campbell.foreground).toBe('#cccccc')
    expect([
      campbell.black, campbell.red, campbell.green, campbell.yellow,
      campbell.blue, campbell.magenta, campbell.cyan, campbell.white,
    ]).toEqual([
      '#0c0c0c', '#c50f1f', '#13a10e', '#c19c00',
      '#0037da', '#881798', '#3a96dd', '#cccccc',
    ])
    expect([
      campbell.brightBlack, campbell.brightRed, campbell.brightGreen, campbell.brightYellow,
      campbell.brightBlue, campbell.brightMagenta, campbell.brightCyan, campbell.brightWhite,
    ]).toEqual([
      '#767676', '#e74856', '#16c60c', '#f9f1a5',
      '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2',
    ])
  })
})

describe('hexToRgb', () => {
  it('parses a full 6-digit hex with a leading #', () => {
    expect(hexToRgb('#ff0080')).toEqual([255, 0, 128])
  })

  it('parses a full 6-digit hex without a leading #', () => {
    expect(hexToRgb('00ff00')).toEqual([0, 255, 0])
  })

  it('is case-insensitive', () => {
    expect(hexToRgb('#FF0080')).toEqual([255, 0, 128])
  })

  // Characterization: the function assumes a well-formed 6-digit hex and
  // does no length validation. Short input starves the later byte slices,
  // and invalid characters parse to NaN — pinned here so a future change to
  // this behavior is a deliberate decision, not an accident.
  it('produces NaN components when the string is shorter than 6 hex digits', () => {
    const [r, g, b] = hexToRgb('#fff')
    expect(r).toBe(255)
    expect(g).toBe(15)
    expect(Number.isNaN(b)).toBe(true)
  })

  it('produces NaN components for non-hex characters', () => {
    const [r, g, b] = hexToRgb('#zzzzzz')
    expect(Number.isNaN(r)).toBe(true)
    expect(Number.isNaN(g)).toBe(true)
    expect(Number.isNaN(b)).toBe(true)
  })
})

describe('backgroundWithOpacity', () => {
  const theme = PRESET_THEMES[0]

  it('appends ff for full opacity', () => {
    expect(backgroundWithOpacity(theme, 1)).toBe(`${theme.background}ff`)
  })

  it('appends 00 for zero opacity', () => {
    expect(backgroundWithOpacity(theme, 0)).toBe(`${theme.background}00`)
  })

  it('rounds a fractional opacity to the nearest byte', () => {
    // 0.5 * 255 = 127.5 -> rounds to 128 = 0x80
    expect(backgroundWithOpacity(theme, 0.5)).toBe(`${theme.background}80`)
  })
})

describe('stripOverlay', () => {
  it('lightens a dark preset and darkens a light one', () => {
    for (const theme of PRESET_THEMES) {
      expect(stripOverlay(theme)).toBe(
        looksLight(theme) ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.08)',
      )
    }
  })

  it('covers both directions across the presets', () => {
    // The loop above passes vacuously if every preset happens to be dark,
    // which is what it was before Light existed and would be again if the
    // light ones were dropped.
    expect(PRESET_THEMES.some(looksLight)).toBe(true)
    expect(PRESET_THEMES.some((t) => !looksLight(t))).toBe(true)
  })

  it('separates the strip from the terminal on every preset', () => {
    // What bg-black/20 failed to do: as a multiply it moved Campbell
    // (#0c0c0c) two levels, which is not visible. Composite the overlay over
    // each background and check the result actually went somewhere.
    for (const theme of PRESET_THEMES) {
      const [tone, , , alpha] = stripOverlay(theme).match(/[\d.]+/g)!.map(Number)
      for (const channel of hexToRgb(theme.background)) {
        expect(Math.abs(tone * alpha - channel * alpha)).toBeGreaterThan(10)
      }
    }
  })
})

describe('tabHoverWash', () => {
  it('is half the strip wash, as a flat one-stop layer', () => {
    expect(tabHoverWash(findTheme('Campbell'))).toBe(
      'linear-gradient(rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.04))'
    )
  })

  it('carries no colour of its own, so the caller sets what it sits on', () => {
    // As one `background` shorthand Chrome keeps the gradient and drops the
    // colour, which put the wash on the strip rather than on the terminal —
    // the wrong side of the tab it is meant to be reaching towards.
    for (const theme of PRESET_THEMES) {
      expect(tabHoverWash(theme)).not.toContain(theme.background)
      const [tone, , , half] = tabHoverWash(theme).match(/[\d.]+/g)!.map(Number)
      const [, , , full] = stripOverlay(theme).match(/[\d.]+/g)!.map(Number)
      expect(half).toBeCloseTo(full / 2)
      expect(tone).toBe(looksLight(theme) ? 0 : 255)
    }
  })
})

describe('backgroundTint', () => {
  it('returns the background rgb plus a rounded 0-255 alpha', () => {
    const theme = PRESET_THEMES[0]
    const [r, g, b] = hexToRgb(theme.background)
    expect(backgroundTint(theme, 1)).toEqual([r, g, b, 255])
    expect(backgroundTint(theme, 0)).toEqual([r, g, b, 0])
  })
})

describe('PRESET_THEMES', () => {
  it('gives every preset a distinct name', () => {
    // The name is the whole identity: it is what `themeName` stores and what
    // `findTheme` resolves, so a duplicate is a preset nobody can select.
    const names = PRESET_THEMES.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('fills in every colour the editor can reach, as a 6-digit hex', () => {
    // THEME_COLOR_KEYS drives both the editor grid and the loader's
    // validation, so a field missing from it is unreachable in the UI and
    // unvalidated on the way in.
    for (const theme of PRESET_THEMES) {
      for (const key of THEME_COLOR_KEYS) {
        expect(isHexColor(theme[key])).toBe(true)
      }
      expect(Object.keys(theme).sort()).toEqual([...THEME_COLOR_KEYS, 'name'].sort())
    }
  })
})

describe('findTheme with custom themes', () => {
  it('resolves a registered custom theme by name', () => {
    setCustomThemes([customTheme('Mine', { background: '#123456' })])
    expect(findTheme('Mine').background).toBe('#123456')
  })

  it('falls back to the default once a custom theme is gone', () => {
    setCustomThemes([customTheme('Mine')])
    setCustomThemes([])
    expect(findTheme('Mine')).toBe(PRESET_THEMES[0])
  })

  it('lets a preset win over a custom theme claiming its name', () => {
    // sanitizeCustomThemes renames these on the way in, so this is the
    // second line of defence -- but it is the one that decides that
    // "Campbell" means Campbell no matter what is in storage.
    setCustomThemes([customTheme('Campbell', { background: '#ff0000' })])
    expect(findTheme('Campbell').background).toBe('#0c0c0c')
  })

  it('reports what is registered', () => {
    const mine = [customTheme('Mine')]
    setCustomThemes(mine)
    expect(getCustomThemes()).toEqual(mine)
  })
})

describe('isHexColor', () => {
  it('accepts a 6-digit hex in either case', () => {
    expect(isHexColor('#a1b2c3')).toBe(true)
    expect(isHexColor('#A1B2C3')).toBe(true)
  })

  it('rejects the forms hexToRgb would read as NaN', () => {
    // Each of these is something a hand-edited settings file can contain,
    // and each parses to NaN components -- see the hexToRgb tests above.
    for (const bad of ['#fff', 'a1b2c3', '#a1b2c', '#a1b2c3d', '#zzzzzz', '', null, 42, {}]) {
      expect(isHexColor(bad)).toBe(false)
    }
  })
})

describe('sanitizeCustomThemes', () => {
  it('returns nothing for a value that is not an array', () => {
    for (const bad of [undefined, null, 'themes', {}, 7]) {
      expect(sanitizeCustomThemes(bad)).toEqual([])
    }
  })

  it('keeps a well-formed theme as it is', () => {
    const mine = customTheme('Mine', { background: '#123456' })
    expect(sanitizeCustomThemes([mine])).toEqual([mine])
  })

  it('substitutes the default for a colour that is not one, keeping the rest', () => {
    // Per-field rather than dropping the theme: someone whose file lost one
    // colour should get that colour back, not lose the palette they built.
    const [cleaned] = sanitizeCustomThemes([
      customTheme('Mine', { background: '#123456', red: 'not-a-colour' }),
    ])
    expect(cleaned.background).toBe('#123456')
    expect(cleaned.red).toBe(PRESET_THEMES[0].red)
  })

  it('supplies every missing colour', () => {
    const [cleaned] = sanitizeCustomThemes([{ name: 'Sparse' }])
    for (const key of THEME_COLOR_KEYS) {
      expect(cleaned[key]).toBe(PRESET_THEMES[0][key])
    }
  })

  it('lower-cases hex so the editor and the stored value agree', () => {
    // <input type="color"> emits lower case; a transcribed palette usually
    // is not. Two spellings of one colour would make the swatch and the
    // text field disagree about whether anything changed.
    const [cleaned] = sanitizeCustomThemes([customTheme('Mine', { blue: '#AABBCC' })])
    expect(cleaned.blue).toBe('#aabbcc')
  })

  it('drops entries with no usable name', () => {
    expect(sanitizeCustomThemes([{ name: '  ' }, { name: 5 }, null, 'x', customTheme('Real')])).toEqual([
      customTheme('Real'),
    ])
  })

  it('trims a name', () => {
    expect(sanitizeCustomThemes([customTheme('  Mine  ')])[0].name).toBe('Mine')
  })

  it('renames a theme that collides with a preset', () => {
    expect(sanitizeCustomThemes([customTheme('Dracula')])[0].name).toBe('Dracula 2')
  })

  it('renames later duplicates, keeping the first', () => {
    const names = sanitizeCustomThemes([
      customTheme('Mine'),
      customTheme('Mine'),
      customTheme('Mine'),
    ]).map((t) => t.name)
    expect(names).toEqual(['Mine', 'Mine 2', 'Mine 3'])
  })
})

describe('uniqueThemeName', () => {
  it('returns the name when nothing has it', () => {
    expect(uniqueThemeName('Mine', new Set())).toBe('Mine')
  })

  it('counts up past every taken suffix', () => {
    expect(uniqueThemeName('Mine', new Set(['Mine', 'Mine 2', 'Mine 3']))).toBe('Mine 4')
  })
})

describe('copyOfTheme', () => {
  it('copies the palette under a free name', () => {
    const copy = copyOfTheme(findTheme('Nord'), [])
    expect(copy.name).toBe('Nord copy')
    expect({ ...copy, name: 'Nord' }).toEqual(findTheme('Nord'))
  })

  it('avoids a name an existing custom theme already has', () => {
    expect(copyOfTheme(findTheme('Nord'), [customTheme('Nord copy')]).name).toBe('Nord copy 2')
  })

  it('avoids a preset name', () => {
    // Duplicating a custom theme called "Light copy" must not produce a
    // second "Light".
    expect(copyOfTheme(customTheme('Light'), []).name).toBe('Light copy')
  })
})

describe('the editor grid', () => {
  it('reaches every colour a theme has, exactly once', () => {
    // The grid is laid out by hand -- three surface colours, then eight
    // normal/bright pairs -- rather than mapped off THEME_COLOR_KEYS, which
    // is what makes the pairing possible and what makes it possible to
    // forget a field. A colour missing here is one no user can edit, and
    // nothing else would fail.
    const reached = [
      ...SURFACE_FIELDS.map((f) => f.key),
      ...PALETTE_ROWS.flatMap((r) => [r.normal, r.bright]),
    ]
    expect(reached.slice().sort()).toEqual([...THEME_COLOR_KEYS].sort())
    expect(new Set(reached).size).toBe(reached.length)
  })

  it('pairs each normal slot with its own bright one', () => {
    // Off-by-one in this table would silently wire Red's bright field to
    // brightGreen -- editable, saved, and wrong.
    for (const { normal, bright } of PALETTE_ROWS) {
      expect(bright).toBe(`bright${normal[0].toUpperCase()}${normal.slice(1)}`)
    }
  })
})
