import { describe, it, expect } from 'vitest'
import {
  isCleanDisconnect,
  isDisconnect,
  parseReconnecting,
  reconnectPolicy,
  shouldAutoClosePane,
} from './connection'

/** These two functions are one half of a wire contract — the other half is
 * `status_label` in src-tauri/src/connection_status.rs, which has its own tests
 * asserting the same strings from the producing side. Between them, a change to
 * the format on either side fails a test rather than silently leaving the UI
 * showing a raw status string. */
describe('parseReconnecting', () => {
  it('reads the attempt and the countdown the backend sends', () => {
    expect(parseReconnecting('reconnecting: 3 in 8')).toEqual({ attempt: 3, inSeconds: 8 })
  })

  it('handles multi-digit values, since a run reaches attempt 12', () => {
    expect(parseReconnecting('reconnecting: 12 in 30')).toEqual({ attempt: 12, inSeconds: 30 })
  })

  it('returns null for every other status rather than a partly-filled object', () => {
    for (const status of [
      'connected',
      'connecting',
      'disconnected',
      'lost',
      'waking',
      'failed: authentication failed',
      // The give-up message mentions reconnecting but is a terminal failure,
      // and treating it as an in-flight retry would leave the pane showing a
      // countdown forever.
      'failed: could not reconnect after 12 attempts',
      'reconnecting',
      'reconnecting: 3',
    ]) {
      expect(parseReconnecting(status), status).toBeNull()
    }
  })
})

describe('isDisconnect', () => {
  it('covers both a clean close and a lost transport', () => {
    expect(isDisconnect('disconnected')).toBe(true)
    expect(isDisconnect('lost')).toBe(true)
  })

  it('does not treat a failure or an in-flight state as a disconnect', () => {
    for (const status of ['connected', 'connecting', 'waking', 'failed: nope', 'reconnecting: 1 in 1']) {
      expect(isDisconnect(status), status).toBe(false)
    }
  })
})

describe('isCleanDisconnect', () => {
  it('separates a session that ended from one that was taken away', () => {
    expect(isCleanDisconnect('disconnected')).toBe(true)
    expect(isCleanDisconnect('lost')).toBe(false)
  })
})

/**
 * The rule behind `closeOnDisconnect`.
 *
 * Pinned because getting it wrong is invisible in the worst way: the setting is
 * on by default, and closing the pane removes the session id, which is the very
 * thing that stops a reconnect run. Firing it on `lost` therefore switched
 * auto-reconnect off for most users while looking like an unrelated preference,
 * and no test caught it because the two features were only ever exercised
 * apart.
 */
describe('shouldAutoClosePane', () => {
  it('closes the pane when the session ended cleanly and the setting is on', () => {
    expect(shouldAutoClosePane('disconnected', true)).toBe(true)
  })

  it('leaves a lost transport alone, so auto-reconnect can have it', () => {
    expect(shouldAutoClosePane('lost', true)).toBe(false)
  })

  it('closes nothing at all when the setting is off', () => {
    expect(shouldAutoClosePane('disconnected', false)).toBe(false)
    expect(shouldAutoClosePane('lost', false)).toBe(false)
  })

  it('never closes on a failure, which has to stay readable', () => {
    for (const status of [
      'failed: authentication failed',
      // A run that used up its budget. The pane is where that message lives
      // and where the Reconnect button is; closing it would take away both.
      'failed: could not reconnect after 12 attempts',
      'connecting',
      'reconnecting: 2 in 4',
      'connected',
    ]) {
      expect(shouldAutoClosePane(status, true), status).toBe(false)
    }
  })
})

describe('reconnectPolicy', () => {
  const settings = { autoReconnect: true, reconnectMaxAttempts: 12, reconnectMaxSeconds: 300 }

  it('carries the bounds through unchanged', () => {
    expect(reconnectPolicy(settings, null)).toEqual({
      enabled: true,
      maxAttempts: 12,
      maxElapsedSeconds: 300,
    })
  })

  it('treats a profile with no preference as following the global setting', () => {
    expect(reconnectPolicy(settings, null).enabled).toBe(true)
    expect(reconnectPolicy(settings, undefined).enabled).toBe(true)
    expect(reconnectPolicy({ ...settings, autoReconnect: false }, null).enabled).toBe(false)
  })

  it('lets a single profile opt out while the global setting stays on', () => {
    expect(reconnectPolicy(settings, false).enabled).toBe(false)
  })

  // The half that would be easy to get backwards. Both sides subtract: the
  // global switch is the one place someone turns the whole behaviour off, and
  // a profile that could re-enable it there would make that switch useless
  // without auditing every saved session.
  it('does not let a profile re-enable what the global setting turned off', () => {
    expect(reconnectPolicy({ ...settings, autoReconnect: false }, true).enabled).toBe(false)
  })

  // The bounds are sent whatever the switch says. They describe the run, not
  // whether there is one, and dropping them when disabled would mean the
  // backend silently substituting its own the moment the switch came back on
  // mid-session — which it cannot, since the policy is fixed at connect time.
  it('still reports the bounds when reconnecting is switched off', () => {
    expect(reconnectPolicy({ ...settings, autoReconnect: false }, null)).toEqual({
      enabled: false,
      maxAttempts: 12,
      maxElapsedSeconds: 300,
    })
  })
})
