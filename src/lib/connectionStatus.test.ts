import { describe, it, expect } from 'vitest'
import { isDisconnect, parseReconnecting } from './connection'

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
