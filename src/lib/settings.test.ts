// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadSettings,
  saveSettings,
  cursorStyleSequence,
  scrollbackTierForRows,
  SCROLLBACK_FOOTPRINT_TIERS_MB,
  RECONNECT_ATTEMPTS_RANGE,
  RECONNECT_SECONDS_RANGE,
  FONT_STACKS,
  FONT_SIZE_RANGE,
  FONT_WEIGHT_RANGE,
  LINE_HEIGHT_PERCENT_RANGE,
  DEFAULT_FONT_SIZE,
  effectiveBackgroundOpacity,
  UNFOCUSED_OPACITY_FLOOR,
  UNFOCUSED_DIM_RANGE,
} from './settings'
import { PRESET_THEMES, findTheme, getCustomThemes, setCustomThemes } from './theme'

const STORAGE_KEY = 'wrustty.terminal-settings'
const PREVIOUS_STORAGE_KEY = 'wr-shell.terminal-settings'

beforeEach(() => {
  localStorage.clear()
  setCustomThemes([])
})

describe('loadSettings', () => {
  it('returns the defaults when nothing is stored', () => {
    const settings = loadSettings()
    expect(settings.fontSize).toBe(14)
    expect(settings.themeName).toBe('wRusTTY Dark')
  })

  it('merges a stored payload onto the defaults, keeping unspecified fields default', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 20 }))
    const settings = loadSettings()
    expect(settings.fontSize).toBe(20)
    expect(settings.themeName).toBe('wRusTTY Dark')
  })

  it('does not blow up on an unknown key in the stored payload', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 20, notARealSetting: true }))
    expect(() => loadSettings()).not.toThrow()
    expect(loadSettings().fontSize).toBe(20)
  })

  it('falls back to the pre-rebrand wr-shell storage key when the current key is empty', () => {
    localStorage.setItem(PREVIOUS_STORAGE_KEY, JSON.stringify({ fontSize: 22 }))
    expect(loadSettings().fontSize).toBe(22)
  })

  it('prefers the current-key value over the legacy key when both are present', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 9 }))
    localStorage.setItem(PREVIOUS_STORAGE_KEY, JSON.stringify({ fontSize: 22 }))
    expect(loadSettings().fontSize).toBe(9)
  })

  /**
   * A settings blob written before `clipboardWriteFromRemote` existed has no
   * such key, and `undefined` is not `false` — but a merge that let the stored
   * object win would still turn remote clipboard writes off for every existing
   * user on upgrade. The feature has to survive its own gate being added.
   */
  it('leaves remote clipboard writes enabled for a blob predating the setting', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 20, bellSound: true }))
    expect(loadSettings().clipboardWriteFromRemote).toBe(true)
  })

  it('honours the setting once it has actually been turned off', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ clipboardWriteFromRemote: false }))
    expect(loadSettings().clipboardWriteFromRemote).toBe(false)
  })

  /**
   * Same hazard as the clipboard gate above, and a louder one: text blending
   * changes how every glyph in every pane is drawn. An existing install has
   * to come back on the renderer it already had, so the absent key must read
   * as 'native' rather than as "adopt the new mode".
   */
  it('leaves text blending on native for a blob predating the setting', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 20, themeName: 'Nord' }))
    expect(loadSettings().textBlending).toBe('native')
  })

  it('honours a stored blending choice', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ textBlending: 'linear-corrected' }))
    expect(loadSettings().textBlending).toBe('linear-corrected')
  })

  /**
   * The shader switches on this value and has no branch for anything else —
   * an unrecognised mode would draw nothing rather than degrade. Hand-edited
   * storage and a mode retired by a later version both land here, as does
   * 'srgb', the name this setting used before it took ghostty's vocabulary.
   */
  it('falls back to native for a blend mode the renderer has no branch for', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ textBlending: 'srgb' }))
    expect(loadSettings().textBlending).toBe('native')
  })

  /**
   * The stacks grew a symbol tier — a list of symbol faces after the text
   * face, which Canvas 2D falls back across per glyph. An existing install
   * would otherwise keep its old stack forever: the value still works, so
   * nothing looks broken, but the setting quietly stops matching any entry in
   * the picker and the tier never arrives.
   */
  it('carries a stack from before the symbol tier onto its current equivalent', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ fontFamily: '"Cascadia Mono", ui-monospace, monospace' }),
    )
    const cascadiaMono = FONT_STACKS.find((f) => f.label === 'Cascadia Mono')
    expect(loadSettings().fontFamily).toBe(cascadiaMono?.value)
    expect(loadSettings().fontFamily).toContain('Segoe UI Symbol')
  })

  it('leaves a stack it never shipped alone — that one belongs to the user', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontFamily: '"Fira Code", monospace' }))
    expect(loadSettings().fontFamily).toBe('"Fira Code", monospace')
  })

  /**
   * Same argument as text blending above: run shaping costs atlas slots
   * whether or not the resolved face has the substitutions, so a blob written
   * before the setting existed has to read as off rather than as opting in.
   */
  it('leaves ligatures off for a blob predating the setting', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 20 }))
    expect(loadSettings().ligatures).toBe(false)
  })

  it('honours a stored ligature choice, and ignores a non-boolean one', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ligatures: true }))
    expect(loadSettings().ligatures).toBe(true)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ligatures: 'yes' }))
    expect(loadSettings().ligatures).toBe(false)
  })

  it('falls back to defaults on corrupted JSON rather than throwing', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json')
    expect(loadSettings()).toEqual(loadSettingsDefaultsSnapshot())
  })
})

describe('saveSettings', () => {
  it('round-trips a full settings object through localStorage', () => {
    const settings = { ...loadSettings(), fontSize: 21 }
    saveSettings(settings)
    expect(loadSettings().fontSize).toBe(21)
  })
})

function loadSettingsDefaultsSnapshot() {
  localStorage.clear()
  return loadSettings()
}

describe('cursorStyleSequence', () => {
  /**
   * DECSCUSR pairs each shape with whether it blinks, so the two settings
   * resolve to one sequence and getting the pairing wrong silently swaps
   * "steady bar" for "blinking underline". The table is the test.
   */
  it('maps every shape and blink combination to its DECSCUSR value', () => {
    expect(cursorStyleSequence('block', true)).toBe('[1 q')
    expect(cursorStyleSequence('block', false)).toBe('[2 q')
    expect(cursorStyleSequence('underline', true)).toBe('[3 q')
    expect(cursorStyleSequence('underline', false)).toBe('[4 q')
    expect(cursorStyleSequence('bar', true)).toBe('[5 q')
    expect(cursorStyleSequence('bar', false)).toBe('[6 q')
  })

  it('falls back to a block rather than emitting a malformed sequence', () => {
    expect(cursorStyleSequence('nonsense' as never, true)).toBe('[1 q')
  })
})

/**
 * The scrollback setting changed unit — from a row count to a per-pane memory
 * tier — and the field was renamed to make that safe. This is the migration
 * and the guard around it.
 *
 * The rename is the whole point. `loadSettings` merges a stored payload onto
 * the defaults, so a `scrollback: 10000` left under its old name would have
 * been read as 10,000 *MB*: every existing user silently moved to the largest
 * tier and roughly ten times the memory they had agreed to.
 */
describe('scrollbackTierForRows', () => {
  it('rounds up to the first tier that covers what the user had', () => {
    // Nobody should lose history they were already relying on.
    expect(scrollbackTierForRows(1000)).toBe(8)
    expect(scrollbackTierForRows(5000)).toBe(16)
    expect(scrollbackTierForRows(10000)).toBe(16)
    expect(scrollbackTierForRows(30000)).toBe(64)
  })

  it('lands on the largest tier for a value past every tier', () => {
    // The old menu went to 100,000, so these exist in the wild.
    expect(scrollbackTierForRows(100000)).toBe(64)
    expect(scrollbackTierForRows(1e9)).toBe(64)
  })

  it('always returns a tier the picker actually offers', () => {
    for (const rows of [0, -1, 1, 999, 1000, 24617, 49230, 1e9, NaN, Infinity]) {
      expect(SCROLLBACK_FOOTPRINT_TIERS_MB).toContain(scrollbackTierForRows(rows))
    }
  })
})

describe('scrollback settings migration', () => {
  it('converts a stored row count to a tier', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ scrollback: 10000 }))
    expect(loadSettings().scrollbackBudgetMB).toBe(16)
  })

  it('never reads the old row count as megabytes', () => {
    // The regression the rename exists to prevent, stated directly.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ scrollback: 100000 }))
    const settings = loadSettings()
    expect(settings.scrollbackBudgetMB).toBeLessThanOrEqual(64)
    expect(SCROLLBACK_FOOTPRINT_TIERS_MB).toContain(settings.scrollbackBudgetMB)
  })

  it('drops the stale key so it cannot be re-read later', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ scrollback: 5000 }))
    expect('scrollback' in loadSettings()).toBe(false)
  })

  it('prefers an explicit tier over a row count left alongside it', () => {
    // A settings blob written by this version, loaded by a build that also
    // still carries the old key — the new field wins rather than being
    // recomputed from stale data.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ scrollback: 1000, scrollbackBudgetMB: 64 }))
    expect(loadSettings().scrollbackBudgetMB).toBe(64)
  })

  it('falls back to the default for a tier that is not offered', () => {
    // Corrupt, hand-edited, or retired by a later version. Must not reach the
    // engine, which would silently substitute its own smallest tier.
    for (const bad of [7, 24, 128, 0, -1, 'lots', null]) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ scrollbackBudgetMB: bad }))
      expect(loadSettings().scrollbackBudgetMB).toBe(16)
    }
  })

  it('gives a fresh install the tier matching the old default depth', () => {
    expect(loadSettings().scrollbackBudgetMB).toBe(16)
  })

  it('migrates a payload found under the pre-rebrand key too', () => {
    localStorage.setItem(PREVIOUS_STORAGE_KEY, JSON.stringify({ scrollback: 30000 }))
    expect(loadSettings().scrollbackBudgetMB).toBe(64)
  })
})

describe('the reconnect bounds', () => {
  it('default to the schedule the backend reasons about', () => {
    const settings = loadSettings()
    expect(settings.autoReconnect).toBe(true)
    expect(settings.reconnectMaxAttempts).toBe(12)
    expect(settings.reconnectMaxSeconds).toBe(300)
  })

  // These are loop bounds. The backend clamps them on arrival because the
  // webview is not a trusted source of one; this clamp exists so the dialog
  // shows the number that will actually be used rather than one silently
  // corrected on the way through.
  it('are clamped into range rather than passed on as stored', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ reconnectMaxAttempts: 100000, reconnectMaxSeconds: 0 }),
    )
    const settings = loadSettings()
    expect(settings.reconnectMaxAttempts).toBe(RECONNECT_ATTEMPTS_RANGE.max)
    expect(settings.reconnectMaxSeconds).toBe(RECONNECT_SECONDS_RANGE.min)
  })

  it('fall back to the default when a stored value is not a number at all', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ reconnectMaxAttempts: 'lots' }))
    expect(loadSettings().reconnectMaxAttempts).toBe(12)
  })

  // The switch is not a bound and must survive a blob whose bounds are junk.
  it('leave the switch alone while clamping', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ autoReconnect: false, reconnectMaxAttempts: -5 }),
    )
    const settings = loadSettings()
    expect(settings.autoReconnect).toBe(false)
    expect(settings.reconnectMaxAttempts).toBe(RECONNECT_ATTEMPTS_RANGE.min)
  })
})

describe('the font measurements a stored blob can carry', () => {
  // Every one of these is a number the renderer sizes a grid or a face with:
  // a stored zero is not an ugly pane, it is a division by a zero-width cell.
  it('clamp a font size to what the controls offer', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 500 }))
    expect(loadSettings().fontSize).toBe(FONT_SIZE_RANGE.max)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 0 }))
    expect(loadSettings().fontSize).toBe(FONT_SIZE_RANGE.min)
  })

  it('fall back to the default when a measurement is not a number', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ fontSize: 'big', lineHeightPercent: null, letterSpacing: 'wide' }),
    )
    const s = loadSettings()
    expect(s.fontSize).toBe(DEFAULT_FONT_SIZE)
    expect(s.lineHeightPercent).toBe(120)
    expect(s.letterSpacing).toBe(0)
  })

  it('clamp the weights to the CSS axis', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontWeight: 50, fontWeightBold: 4000 }))
    const s = loadSettings()
    expect(s.fontWeight).toBe(FONT_WEIGHT_RANGE.min)
    expect(s.fontWeightBold).toBe(FONT_WEIGHT_RANGE.max)
  })

  it('default to the weights and metrics that render as the app always did', () => {
    const s = loadSettings()
    expect(s.fontWeight).toBe(400)
    expect(s.fontWeightBold).toBe(700)
    expect(s.lineHeightPercent).toBe(120)
    expect(s.letterSpacing).toBe(0)
  })

  it('keep a line height below the font size out of the settings entirely', () => {
    // A cell shorter than the face clips its descenders, not just the odd
    // glyph's, so the floor is a real bound rather than a taste.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ lineHeightPercent: 40 }))
    expect(loadSettings().lineHeightPercent).toBe(LINE_HEIGHT_PERCENT_RANGE.min)
  })
})

describe('the font settings a stored blob can carry', () => {
  it('default to empty, so an install that never touched them renders as before', () => {
    const settings = loadSettings()
    expect(settings.fontFamilyBold).toBe('')
    expect(settings.fontFamilyItalic).toBe('')
    expect(settings.fontFamilyBoldItalic).toBe('')
    expect(settings.fontFeatures).toBe('')
    expect(settings.fontRanges).toEqual([])
  })

  // These reach the DOM as a CSS family list and a font-feature-settings
  // value, where a non-string would interpolate as "[object Object]" and
  // quietly resolve to the fallback face.
  it('fall back to the default when a stored face name is not a string', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ fontFamilyItalic: { name: 'Iosevka' }, fontFeatures: 3 }),
    )
    const settings = loadSettings()
    expect(settings.fontFamilyItalic).toBe('')
    expect(settings.fontFeatures).toBe('')
  })

  it('keep a well-formed range table', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ fontRanges: [{ lo: 0xe000, hi: 0xf8ff, family: 'Symbols Nerd Font' }] }),
    )
    expect(loadSettings().fontRanges).toEqual([
      { lo: 0xe000, hi: 0xf8ff, family: 'Symbols Nerd Font' },
    ])
  })

  it('sort the table, because the atlas binary-searches it', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        fontRanges: [
          { lo: 0x4e00, hi: 0x9fff, family: 'Sarasa Mono' },
          { lo: 0x2500, hi: 0x257f, family: 'Nerd Font' },
        ],
      }),
    )
    expect(loadSettings().fontRanges.map((r) => r.lo)).toEqual([0x2500, 0x4e00])
  })

  // Dropped rather than repaired: a lookup that silently never matches is
  // harder to see than an entry that plainly went missing.
  it('drop entries that are inverted, out of range, unnamed or the wrong type', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        fontRanges: [
          { lo: 0x100, hi: 0x50, family: 'Backwards' },
          { lo: -1, hi: 0x50, family: 'Negative' },
          { lo: 0x10, hi: 0x110000, family: 'Past the last plane' },
          { lo: 0.5, hi: 20.5, family: 'Fractional' },
          { lo: 0x20, hi: 0x30, family: '   ' },
          { lo: '0x20', hi: 0x30, family: 'Stringly typed' },
          null,
          { lo: 0x20, hi: 0x30, family: 'Fine' },
        ],
      }),
    )
    expect(loadSettings().fontRanges).toEqual([{ lo: 0x20, hi: 0x30, family: 'Fine' }])
  })

  // A stored table can overlap however it likes — it may have been written by
  // hand, or by a version that did not check. What comes out has to be
  // something the atlas can binary-search.
  it('drop a range that overlaps one starting earlier', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        fontRanges: [
          { lo: 0x2000, hi: 0x3000, family: 'Overlapping' },
          { lo: 0x1000, hi: 0x2500, family: 'First' },
          { lo: 0x4000, hi: 0x5000, family: 'Clear of both' },
        ],
      }),
    )
    expect(loadSettings().fontRanges).toEqual([
      { lo: 0x1000, hi: 0x2500, family: 'First' },
      { lo: 0x4000, hi: 0x5000, family: 'Clear of both' },
    ])
  })

  it('keep ranges that only touch, since both ends are inclusive', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        fontRanges: [
          { lo: 0x1000, hi: 0x1fff, family: 'A' },
          { lo: 0x2000, hi: 0x2fff, family: 'B' },
        ],
      }),
    )
    expect(loadSettings().fontRanges).toHaveLength(2)
  })

  it('drop a table that is not an array at all', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontRanges: { lo: 1, hi: 2 } }))
    expect(loadSettings().fontRanges).toEqual([])
  })
})

describe('custom themes', () => {
  const mine = { ...PRESET_THEMES[0], name: 'Mine', background: '#123456' }

  it('defaults to none', () => {
    expect(loadSettings().customThemes).toEqual([])
  })

  it('loads stored themes and makes findTheme able to resolve them', () => {
    // The registry is the whole point of loading these: every consumer that
    // paints a theme -- the engine, the chrome, the benchmark harness --
    // holds only a name and asks findTheme.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ themeName: 'Mine', customThemes: [mine] }))
    const settings = loadSettings()
    expect(settings.customThemes).toEqual([mine])
    expect(findTheme(settings.themeName).background).toBe('#123456')
  })

  it('cleans a malformed palette rather than passing it to the renderer', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ customThemes: [{ ...mine, red: 'rgb(1,2,3)' }, { name: '' }] }),
    )
    const settings = loadSettings()
    expect(settings.customThemes).toEqual([mine])
  })

  it('drops a themes value that is not a list', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ customThemes: 'Mine' }))
    expect(loadSettings().customThemes).toEqual([])
  })

  it('leaves an unknown theme name resolving to the default', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ themeName: 'Deleted' }))
    expect(findTheme(loadSettings().themeName)).toBe(PRESET_THEMES[0])
  })

  it('registers on save, so a theme is paintable before it has been reloaded', () => {
    saveSettings({ ...loadSettings(), themeName: 'Mine', customThemes: [mine] })
    expect(getCustomThemes()).toEqual([mine])
    expect(findTheme('Mine').background).toBe('#123456')
  })

  it('clears the registry when a corrupt blob sends load back to the defaults', () => {
    setCustomThemes([mine])
    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(loadSettings().customThemes).toEqual([])
    expect(getCustomThemes()).toEqual([])
  })
})

/**
 * Fading an unfocused window. The rule that matters is the floor, and in
 * particular that the floor never makes a window *more* opaque than it was.
 */
describe('effectiveBackgroundOpacity', () => {
  const at = (backgroundOpacity: number, unfocusedDimPercent: number) => ({
    backgroundOpacity,
    unfocusedDimPercent,
  })

  it('leaves a focused window exactly as configured', () => {
    expect(effectiveBackgroundOpacity(at(0.8, 40), true)).toBe(0.8)
  })

  it('does nothing when the setting is off, focused or not', () => {
    expect(effectiveBackgroundOpacity(at(0.8, 0), false)).toBe(0.8)
  })

  /** Relative, so it composes with a window already running translucent. */
  it('fades relative to the configured opacity', () => {
    expect(effectiveBackgroundOpacity(at(1, 20), false)).toBeCloseTo(0.8)
    expect(effectiveBackgroundOpacity(at(0.6, 50), false)).toBeCloseTo(0.3)
  })

  it('never fades below the floor', () => {
    expect(effectiveBackgroundOpacity(at(0.6, 60), false)).toBe(UNFOCUSED_OPACITY_FLOOR)
  })

  /** The case the capped floor exists for: someone already below the floor
   *  must not see the window firm *up* when they click away. */
  it('never makes a window more opaque than it was', () => {
    expect(effectiveBackgroundOpacity(at(0.2, 30), false)).toBeLessThanOrEqual(0.2)
    expect(effectiveBackgroundOpacity(at(0.2, 30), false)).toBe(0.2)
  })
})

describe('unfocusedDimPercent', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to off', () => {
    expect(loadSettings().unfocusedDimPercent).toBe(0)
  })

  /** It reaches the renderer as an alpha, so a hand-edited value must not. */
  it('is clamped on load', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ unfocusedDimPercent: 500 }))
    expect(loadSettings().unfocusedDimPercent).toBe(UNFOCUSED_DIM_RANGE.max)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ unfocusedDimPercent: 'lots' }))
    expect(loadSettings().unfocusedDimPercent).toBe(0)
  })
})
