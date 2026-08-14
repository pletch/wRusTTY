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
} from './settings'

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
