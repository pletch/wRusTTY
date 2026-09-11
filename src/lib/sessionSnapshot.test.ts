// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import type { ConnectionSource } from './connection'
import { defaultLocalConfig } from './local'
import type { SessionProfile } from './profiles'
import type { PaneNode, Tab } from '../types'
import { blankLeaf } from './paneTree'
import {
  sanitizeTabs,
  countUnsaveable,
  saveSnapshot,
  loadSnapshot,
  clearSnapshot,
  countSessions,
  countAwaitingElevation,
  isVaultBound,
  needsVaultUnlock,
} from './sessionSnapshot'

const STORAGE_KEY = 'wrustty.session-snapshot'
const PREVIOUS_STORAGE_KEY = 'wr-shell.session-snapshot'

function leafWith(source: ConnectionSource | null): PaneNode {
  return { ...blankLeaf(), source }
}

function tabWith(...sources: (ConnectionSource | null)[]): Tab {
  const leaves = sources.map(leafWith)
  let root: PaneNode = leaves[0]
  for (let i = 1; i < leaves.length; i++) {
    root = { type: 'split', id: `split-${i}`, direction: 'horizontal', children: [root, leaves[i]], sizes: [50, 50] }
  }
  return { id: `tab-${Math.random()}`, title: 'tab', root, activePaneId: leaves[0].id }
}

const sshProfileSource = (profileId: string): ConnectionSource => ({ protocol: 'sshProfile', profileId })
const telnetSource: ConnectionSource = { protocol: 'telnet', config: { host: 'h', port: 23 } as never }
const serialSource: ConnectionSource = { protocol: 'serial', config: { port: 'COM1' } as never }
const rawSshSource: ConnectionSource = {
  protocol: 'ssh',
  config: { host: 'h', port: 22, username: 'u' } as never,
}

function profile(overrides: Partial<SessionProfile> = {}): SessionProfile {
  return {
    id: 'p1',
    label: 'p1',
    folder: null,
    host: 'h',
    port: 22,
    protocol: 'ssh',
    username: 'u',
    authType: 'agent',
    keyPath: null,
    hasCredential: false,
    jumpProfileId: null,
    ...overrides,
  } as SessionProfile
}

beforeEach(() => {
  localStorage.clear()
})

describe('sanitizeTabs', () => {
  it('keeps sshProfile and telnet panes, drops raw ssh and unbound serial panes', () => {
    const tabs = [tabWith(sshProfileSource('p1'), telnetSource, rawSshSource, serialSource)]
    const result = sanitizeTabs(tabs, { allowSerial: false })
    const sources = collectSources(result)
    expect(sources).toEqual([sshProfileSource('p1'), telnetSource, null, null])
  })

  it('keeps serial panes only when allowSerial is set', () => {
    const tabs = [tabWith(serialSource)]
    // With allowSerial off, the only leaf loses its source and the tab is
    // then left with nothing restorable, so the whole tab is dropped too.
    expect(collectSources(sanitizeTabs(tabs, { allowSerial: false }))).toEqual([])
    expect(collectSources(sanitizeTabs(tabs, { allowSerial: true }))).toEqual([serialSource])
  })

  it('drops whole tabs left with no restorable pane', () => {
    const tabs = [tabWith(rawSshSource), tabWith(sshProfileSource('p1'))]
    const result = sanitizeTabs(tabs, { allowSerial: false })
    expect(result.length).toBe(1)
    expect(collectSources(result)).toEqual([sshProfileSource('p1')])
  })
})

function collectSources(tabs: Tab[]): (ConnectionSource | null)[] {
  const sources: (ConnectionSource | null)[] = []
  const walk = (node: PaneNode) => {
    if (node.type === 'leaf') {
      sources.push(node.source)
    } else {
      walk(node.children[0])
      walk(node.children[1])
    }
  }
  tabs.forEach((t) => walk(t.root))
  return sources
}

describe('countUnsaveable', () => {
  it('matches exactly what sanitizeTabs would drop', () => {
    const tabs = [tabWith(sshProfileSource('p1'), rawSshSource, serialSource, null)]
    expect(countUnsaveable(tabs, { allowSerial: false })).toBe(2)
    expect(countUnsaveable(tabs, { allowSerial: true })).toBe(1)
  })
})

describe('isVaultBound / needsVaultUnlock', () => {
  const sessions = [
    profile({ id: 'agent', authType: 'agent', jumpProfileId: null }),
    profile({ id: 'password', authType: 'password', jumpProfileId: null }),
    profile({ id: 'agent-via-agent-jump', authType: 'agent', jumpProfileId: 'agent' }),
    profile({ id: 'agent-via-password-jump', authType: 'agent', jumpProfileId: 'password' }),
  ]

  it('is false only for a non-jumping agent profile', () => {
    expect(isVaultBound(sshProfileSource('agent'), sessions)).toBe(false)
  })

  it('is true for a password-authenticated profile', () => {
    expect(isVaultBound(sshProfileSource('password'), sessions)).toBe(true)
  })

  it('is true when the profile itself is agent but jumps through a vault-bound one', () => {
    expect(isVaultBound(sshProfileSource('agent-via-password-jump'), sessions)).toBe(true)
  })

  it('is false when both the profile and its jump host are agent-authenticated', () => {
    expect(isVaultBound(sshProfileSource('agent-via-agent-jump'), sessions)).toBe(false)
  })

  it('treats an unknown profile id as vault-bound (the safe default)', () => {
    expect(isVaultBound(sshProfileSource('missing'), sessions)).toBe(true)
  })

  it('is false for non-sshProfile sources', () => {
    expect(isVaultBound(telnetSource, sessions)).toBe(false)
    expect(isVaultBound(null, sessions)).toBe(false)
  })

  it('needsVaultUnlock is true iff some pane in some tab is vault-bound', () => {
    expect(needsVaultUnlock([tabWith(sshProfileSource('agent'))], sessions)).toBe(false)
    expect(needsVaultUnlock([tabWith(sshProfileSource('password'))], sessions)).toBe(true)
  })
})

describe('countSessions', () => {
  it('counts every leaf with a non-null source', () => {
    const tabs = [tabWith(sshProfileSource('p1'), null, telnetSource)]
    expect(countSessions(tabs)).toBe(2)
  })
})

describe('save / load / clear snapshot', () => {
  it('round-trips through localStorage under the current key', () => {
    const tabs = [tabWith(sshProfileSource('p1'))]
    saveSnapshot(tabs, tabs[0].id)
    const loaded = loadSnapshot()
    expect(loaded).not.toBeNull()
    expect(loaded!.activeTabId).toBe(tabs[0].id)
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()
  })

  it('clears the stored snapshot when nothing survives sanitization', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: [], activeTabId: null }))
    saveSnapshot([tabWith(rawSshSource)], null)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('falls back to activeTabId of the first sanitized tab when the given id was dropped', () => {
    const tabs = [tabWith(sshProfileSource('p1')), tabWith(sshProfileSource('p2'))]
    saveSnapshot(tabs, 'not-a-real-tab-id')
    const loaded = loadSnapshot()
    expect(loaded!.activeTabId).toBe(tabs[0].id)
  })

  it('falls back to the pre-rebrand storage key when the current key is empty', () => {
    const payload = JSON.stringify({ tabs: [], activeTabId: 'legacy' })
    localStorage.setItem(PREVIOUS_STORAGE_KEY, payload)
    const loaded = loadSnapshot()
    expect(loaded).toEqual({ tabs: [], activeTabId: 'legacy' })
  })

  it('clearSnapshot removes only the current-key entry', () => {
    localStorage.setItem(STORAGE_KEY, 'x')
    clearSnapshot()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})

describe('administrator panes', () => {
  const elevated: ConnectionSource = { protocol: 'elevated', shellId: 'pwsh', profileId: null }

  it('come back blank, never connected — but keep their tab', () => {
    const result = sanitizeTabs([tabWith(elevated)], { allowSerial: true })
    expect(result.length).toBe(1)
    expect(collectSources(result)).toEqual([null])
  })

  it('are not counted as lost, since their form survives', () => {
    expect(countUnsaveable([tabWith(elevated, rawSshSource)], { allowSerial: true })).toBe(1)
  })
})

describe('local shells', () => {
  const adHoc: ConnectionSource = {
    protocol: 'local',
    config: { ...defaultLocalConfig(), command: 'C:/Program Files/PowerShell/7/pwsh.exe' },
  }

  // No credential and no network: an unsaved shell can always start again,
  // so it comes back connected rather than vanishing with its tab.
  it('restores an unsaved local shell connected', () => {
    const result = sanitizeTabs([tabWith(adHoc)], { allowSerial: true })
    expect(collectSources(result)).toEqual([adHoc])
    expect(countUnsaveable([tabWith(adHoc)], { allowSerial: true })).toBe(0)
  })
})

describe('countAwaitingElevation', () => {
  const elevated: ConnectionSource = { protocol: 'elevated', shellId: 'pwsh', profileId: null }

  // The launch prompt's count: after a restart, an administrator pane has no
  // source (it waits for approval), so countSessions alone left it out.
  it('counts restored administrator panes, which countSessions does not', () => {
    const tab = tabWith(sshProfileSource('p1'), elevated)
    const leaves = tab.root.type === 'split' ? tab.root.children : []
    const adminLeaf = leaves[1]
    if (adminLeaf.type === 'leaf') {
      adminLeaf.initial = {
        protocol: 'local',
        local: { shellId: 'pwsh', command: 'pwsh.exe', args: [], cwd: null, elevated: true },
      }
    }
    const restored = sanitizeTabs([tab], { allowSerial: true })
    expect(countSessions(restored)).toBe(1)
    expect(countAwaitingElevation(restored)).toBe(1)
  })
})
