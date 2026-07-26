// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { loadSettings, saveSettings, cursorStyleSequence } from './settings'

const STORAGE_KEY = 'wrustty.terminal-settings'
const PREVIOUS_STORAGE_KEY = 'wr-shell.terminal-settings'

beforeEach(() => {
  localStorage.clear()
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
    localStorage.setItem(PREVIOUS_STORAGE_KEY, JSON.stringify({ fontSize: 99 }))
    expect(loadSettings().fontSize).toBe(99)
  })

  it('prefers the current-key value over the legacy key when both are present', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 1 }))
    localStorage.setItem(PREVIOUS_STORAGE_KEY, JSON.stringify({ fontSize: 99 }))
    expect(loadSettings().fontSize).toBe(1)
  })

  it('falls back to defaults on corrupted JSON rather than throwing', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json')
    expect(loadSettings()).toEqual(loadSettingsDefaultsSnapshot())
  })
})

describe('saveSettings', () => {
  it('round-trips a full settings object through localStorage', () => {
    const settings = { ...loadSettings(), fontSize: 42 }
    saveSettings(settings)
    expect(loadSettings().fontSize).toBe(42)
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
