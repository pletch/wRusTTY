import { describe, expect, it } from 'vitest'

import type { ConnectionSource } from './connection'
import { decodeBase64, describeForKeeping, sourceForKeeping, tabForKept } from './sessionReattach'
import type { PaneLeaf } from '../types'

const withPassword = {
  protocol: 'ssh',
  config: {
    host: 'h',
    port: 22,
    username: 'u',
    auth: { type: 'Password', password: 'hunter2' },
    jump: { host: 'j', port: 22, username: 'u', auth: { type: 'Password', password: 'other' } },
  },
} as ConnectionSource

describe('what gets kept for a new webview', () => {
  it('holds no secrets', () => {
    const kept = describeForKeeping(withPassword, 'label')
    expect(kept).not.toContain('hunter2')
    expect(kept).not.toContain('other')
  })

  it('keeps what the pane needs to label itself', () => {
    const kept = sourceForKeeping(withPassword)
    expect(kept).toMatchObject({ protocol: 'ssh', config: { host: 'h', username: 'u' } })
  })

  it('leaves a saved session alone, which holds nothing to take out', () => {
    const saved: ConnectionSource = { protocol: 'sshProfile', profileId: 'p' }
    expect(sourceForKeeping(saved)).toEqual(saved)
  })
})

describe('tabForKept', () => {
  const descriptor = describeForKeeping({ protocol: 'sshProfile', profileId: 'p' }, 'my server')

  it('rebuilds a tab attached to the running session', () => {
    const tab = tabForKept({ sessionId: 'ssh-1', descriptor }, () => 'tab-1')!
    const leaf = tab.root as PaneLeaf
    expect(tab.id).toBe('tab-1')
    expect(tab.title).toBe('my server')
    expect(tab.activePaneId).toBe(leaf.id)
    expect(leaf.attachTo).toBe('ssh-1')
    expect(leaf.source).toEqual({ protocol: 'sshProfile', profileId: 'p' })
    expect(leaf.initial?.label).toBe('my server')
  })

  it('skips a descriptor it cannot read rather than failing the rest', () => {
    expect(tabForKept({ sessionId: 's', descriptor: 'not json' }, () => 't')).toBeNull()
    expect(tabForKept({ sessionId: 's', descriptor: '{}' }, () => 't')).toBeNull()
  })
})

describe('decodeBase64', () => {
  it('returns the original bytes, including ones that are not text', () => {
    expect([...decodeBase64('AP8QaGk=')]).toEqual([0x00, 0xff, 0x10, 0x68, 0x69])
    expect(decodeBase64('').length).toBe(0)
  })
})
