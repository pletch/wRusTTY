import { describe, it, expect } from 'vitest'
import { historyKey, historyKeyForSource } from './commandHistory'

/**
 * The key is the only logic on this side of the boundary — everything else
 * here is a one-line `invoke`, and the ranking and redaction it wraps are
 * tested in Rust, where they live.
 *
 * It is worth pinning anyway, because it decides *whose* history gets
 * suggested at a prompt. Two sessions that should be one history and aren't
 * merely lose suggestions; two that shouldn't be one history and are will
 * offer somebody else's commands at your prompt.
 */
describe('historyKey', () => {
  it('separates users on the same host', () => {
    const tim = historyKey({ protocol: 'ssh', host: 'db01', port: 22, username: 'tim' })
    const root = historyKey({ protocol: 'ssh', host: 'db01', port: 22, username: 'root' })
    expect(tim).not.toBe(root)
  })

  it('separates ports on the same address, which may be different machines', () => {
    expect(historyKey({ protocol: 'ssh', host: 'gw', port: 22, username: 'tim' })).not.toBe(
      historyKey({ protocol: 'ssh', host: 'gw', port: 2222, username: 'tim' }),
    )
  })

  it('separates protocols, so a telnet appliance is not a shell', () => {
    expect(historyKey({ protocol: 'ssh', host: 'sw1' })).not.toBe(
      historyKey({ protocol: 'telnet', host: 'sw1' }),
    )
  })

  it('is stable for the same session, so history accumulates rather than forking', () => {
    const opts = { protocol: 'ssh', host: 'db01', port: 22, username: 'tim' }
    expect(historyKey(opts)).toBe(historyKey({ ...opts }))
  })

  it('omits the parts a session does not have rather than inventing them', () => {
    // A serial line has no user and no port. Left to default they would come
    // out as `undefined@` and `:undefined`, which is a key that changes shape
    // the moment those fields start being passed.
    expect(historyKey({ protocol: 'serial', host: 'COM4' })).toBe('serial://COM4')
    expect(historyKey({ protocol: 'serial', host: 'COM4', port: null, username: null })).toBe(
      'serial://COM4',
    )
  })
})

describe('historyKeyForSource', () => {
  // An administrator shell records nothing — decision 6 of
  // docs/ELEVATED_TABS_PLAN.md. What is typed there should not come back as a
  // suggestion at an ordinary prompt.
  it('keeps no history for an administrator shell', () => {
    expect(historyKeyForSource({ protocol: 'elevated', shellId: 'pwsh', profileId: null })).toBeNull()
  })
})
