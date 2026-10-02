import { describe, it, expect } from 'vitest'
import { describeHistoryHost, historyKey, historyKeyForSource } from './commandHistory'
import type { SessionProfile } from './profiles'

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

  describe('a saved session that connected through the form', () => {
    const saved = {
      id: 'p1',
      label: 'OPNsense',
      protocol: 'ssh',
      host: 'opnsense.home',
      port: 22,
      username: 'root',
    } as SessionProfile
    const typed = (host: string, username = 'root', port = 22) =>
      ({ protocol: 'ssh', config: { host, port, username } }) as Parameters<
        typeof historyKeyForSource
      >[0]

    // Its credential could not be used, so the pane fell back to the form and
    // connected as plain ssh. That is still the saved session's history.
    it('files under the profile while it points where the profile does', () => {
      expect(historyKeyForSource(typed('opnsense.home'), saved)).toBe('profile://p1')
    })

    // The form was edited before connecting — a different machine, or a
    // different user on it, and so a different history.
    it('files under the address once it points somewhere else', () => {
      expect(historyKeyForSource(typed('other.home'), saved)).toBe('ssh://root@other.home:22')
      expect(historyKeyForSource(typed('opnsense.home', 'tim'), saved)).toBe(
        'ssh://tim@opnsense.home:22',
      )
      expect(historyKeyForSource(typed('opnsense.home', 'root', 2222), saved)).toBe(
        'ssh://root@opnsense.home:2222',
      )
    })

    it('files under the address with no saved session at all', () => {
      expect(historyKeyForSource(typed('opnsense.home'))).toBe('ssh://root@opnsense.home:22')
    })
  })
})

describe('describeHistoryHost', () => {
  const profile = {
    id: '09b63c55-28a1-4d82-8ac4-142b507be0df',
    label: 'Build box',
    protocol: 'ssh',
    host: 'build.lan',
    port: 22,
    username: 'tim',
  } as SessionProfile
  const profiles = new Map([[profile.id, profile]])

  it('names a saved session by its label, not its id', () => {
    expect(describeHistoryHost(`profile://${profile.id}`, profiles)).toEqual({
      title: 'Build box',
      detail: 'tim@build.lan',
    })
  })

  it('says so when the saved session is gone', () => {
    expect(describeHistoryHost(`profile://${profile.id}`, new Map())).toEqual({
      title: 'Deleted saved session',
      detail: null,
    })
  })

  it('shows an ad-hoc connection as its address', () => {
    expect(describeHistoryHost('ssh://root@10.0.0.5:2222', profiles)).toEqual({
      title: 'root@10.0.0.5:2222',
      detail: 'ssh',
    })
  })

  it('names local shells, WSL by distro', () => {
    expect(describeHistoryHost('local://wsl:Ubuntu', profiles).title).toBe('WSL Ubuntu')
    expect(describeHistoryHost('local://bash', profiles)).toEqual({
      title: 'bash',
      detail: 'local shell',
    })
  })
})
