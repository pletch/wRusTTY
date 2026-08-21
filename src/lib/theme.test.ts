import { describe, it, expect } from 'vitest'
import {
  PRESET_THEMES,
  findTheme,
  hexToRgb,
  backgroundWithOpacity,
  backgroundTint,
  stripOverlay,
  tabHoverBackground,
} from './theme'

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
  it('lightens every dark preset', () => {
    for (const theme of PRESET_THEMES.filter((t) => t.name !== 'Light')) {
      expect(stripOverlay(theme)).toBe('rgba(255, 255, 255, 0.08)')
    }
  })

  it('darkens a light one', () => {
    expect(stripOverlay(findTheme('Light'))).toBe('rgba(0, 0, 0, 0.08)')
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

describe('tabHoverBackground', () => {
  it('lays half the strip wash over the background, not over the strip', () => {
    const theme = findTheme('Campbell')
    expect(tabHoverBackground(theme, 1)).toBe(
      'linear-gradient(rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.04)), #0c0c0cff',
    )
  })

  it('sits between the strip and the active tab', () => {
    // The active tab is the background exactly, the strip is that plus a
    // full wash — so half a wash is the midpoint, and on a dark theme that
    // has to be *darker* than the strip rather than lighter.
    for (const theme of PRESET_THEMES) {
      const [tone, , , full] = stripOverlay(theme).match(/[\d.]+/g)!.map(Number)
      const [, , , half] = tabHoverBackground(theme, 1).match(/[\d.]+/g)!.map(Number)
      expect(half).toBeCloseTo(full / 2)
      expect(tabHoverBackground(theme, 1)).toContain(`${theme.background}ff`)
      expect(tone).toBe(theme.name === 'Light' ? 0 : 255)
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
