import { describe, it, expect } from 'vitest'
import type { SessionProfile } from '../lib/profiles'
import type { PaneNode, Tab } from '../types'
import { blankLeaf, closeLeaf, firstLeaf, updateLeaf } from '../lib/paneTree'
import {
  splitLimitHint,
  profileToInitial,
  refreshProfilePanes,
  refreshTabs,
  isBlankTab,
  newTabId,
  leafTitle,
  dataBitsDigit,
  blankTab,
} from './tabOps'

describe('splitLimitHint', () => {
  it('names the limit and suggests the escape hatch for each kind', () => {
    expect(splitLimitHint('panes')).toMatch(/panes per tab/)
    expect(splitLimitHint('rows')).toMatch(/top to bottom/)
    expect(splitLimitHint('columns')).toMatch(/side by side/)
  })
})

function profile(overrides: Partial<SessionProfile> = {}): SessionProfile {
  return {
    id: 'p1',
    label: 'Prod box',
    folder: null,
    host: 'h',
    port: 22,
    protocol: 'ssh',
    username: 'u',
    authType: 'agent',
    keyPath: null,
    serial: null,
    keepaliveSeconds: null,
    wakeOnLan: null,
    hasCredential: false,
    jumpProfileId: null,
    termType: null,
    backspaceSendsCtrlH: null,
    autoReconnect: null,
    ...overrides,
  }
}

describe('profileToInitial', () => {
  it('maps the internal authType enum to the connect form labels', () => {
    expect(profileToInitial(profile({ authType: 'password' }))?.authType).toBe('Password')
    expect(profileToInitial(profile({ authType: 'agent' }))?.authType).toBe('Agent')
    expect(profileToInitial(profile({ authType: 'public_key' }))?.authType).toBe('PublicKey')
    expect(profileToInitial(profile({ authType: '' }))?.authType).toBe('PublicKey')
  })

  it('passes through the rest of the profile fields', () => {
    const initial = profileToInitial(profile({ keyPath: '/k', hasCredential: true, jumpProfileId: 'jump' }))
    expect(initial).toMatchObject({ id: 'p1', label: 'Prod box', keyPath: '/k', hasCredential: true, jumpProfileId: 'jump' })
  })
})

describe('leafTitle', () => {
  it('prefers initial.label over the connection source label', () => {
    const leaf = { ...blankLeaf(), source: { protocol: 'telnet' as const, config: { host: 'h', port: 23 } as never }, initial: { label: 'My Session' } }
    expect(leafTitle(leaf, 'fallback')).toBe('My Session')
  })

  it('falls back to the source label when there is no initial.label', () => {
    const leaf = { ...blankLeaf(), source: { protocol: 'ssh' as const, config: { host: 'h', port: 22, username: 'u' } as never } }
    expect(leafTitle(leaf, 'fallback')).toBe('u@h')
  })

  it('falls back to the given title when the pane has neither', () => {
    expect(leafTitle(blankLeaf(), 'New Connection')).toBe('New Connection')
  })
})

describe('dataBitsDigit', () => {
  it('maps each enum value to its conventional framing digit', () => {
    expect(dataBitsDigit('Five')).toBe(5)
    expect(dataBitsDigit('Six')).toBe(6)
    expect(dataBitsDigit('Seven')).toBe(7)
    expect(dataBitsDigit('Eight')).toBe(8)
  })
})

describe('isBlankTab', () => {
  it('is true for a single unconnected leaf', () => {
    expect(isBlankTab(blankTab())).toBe(true)
  })

  it('is false once the pane has a source', () => {
    const tab = blankTab()
    const root = { ...tab.root, source: { protocol: 'telnet' as const, config: { host: 'h', port: 23 } as never } } as PaneNode
    expect(isBlankTab({ ...tab, root })).toBe(false)
  })

  it('is false for a split tab, even if neither leaf is connected', () => {
    const a = blankLeaf()
    const b = blankLeaf()
    const root: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [a, b], sizes: [50, 50] }
    expect(isBlankTab({ id: 't', title: 't', root, activePaneId: a.id })).toBe(false)
  })
})

describe('blankTab / newTabId', () => {
  it('creates a tab titled "New Connection" whose active pane is its one leaf', () => {
    const tab = blankTab()
    expect(tab.title).toBe('New Connection')
    expect(tab.root.type).toBe('leaf')
    expect(tab.activePaneId).toBe(tab.root.id)
  })

  it('newTabId produces distinct ids', () => {
    expect(newTabId()).not.toBe(newTabId())
  })
})

describe('refreshProfilePanes', () => {
  const liveSessions = [profile({ id: 'p1', label: 'Renamed', authType: 'agent' })]

  it('blanks a pane whose profile no longer exists, prefilling from the stored copy', () => {
    const leaf = { ...blankLeaf(), source: { protocol: 'sshProfile' as const, profileId: 'gone' }, initial: { id: 'gone', label: 'Old Name' } as never }
    const next = refreshProfilePanes(leaf, liveSessions, true)
    expect(next.type).toBe('leaf')
    if (next.type !== 'leaf') throw new Error('unreachable')
    expect(next.source).toBeNull()
    expect(next.initial).toEqual(leaf.initial)
  })

  it('blanks a vault-bound pane when the vault is not usable, prefilling from the live profile', () => {
    const passwordProfile = profile({ id: 'p2', authType: 'password' })
    const leaf = { ...blankLeaf(), source: { protocol: 'sshProfile' as const, profileId: 'p2' } }
    const next = refreshProfilePanes(leaf, [passwordProfile], false)
    if (next.type !== 'leaf') throw new Error('unreachable')
    expect(next.source).toBeNull()
    expect(next.initial?.id).toBe('p2')
  })

  it('keeps a live, vault-usable pane connected and refreshes its initial from the live profile', () => {
    const leaf = { ...blankLeaf(), source: { protocol: 'sshProfile' as const, profileId: 'p1' }, initial: { id: 'p1', label: 'Stale Name' } as never }
    const next = refreshProfilePanes(leaf, liveSessions, true)
    if (next.type !== 'leaf') throw new Error('unreachable')
    expect(next.source).toEqual(leaf.source)
    expect(next.initial?.label).toBe('Renamed')
  })

  it('leaves non-sshProfile and disconnected leaves untouched', () => {
    const leaf = blankLeaf()
    expect(refreshProfilePanes(leaf, liveSessions, true)).toBe(leaf)
  })

  it('recurses into both children of a split', () => {
    const a = { ...blankLeaf(), source: { protocol: 'sshProfile' as const, profileId: 'gone' } }
    const b = blankLeaf()
    const tree: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [a, b], sizes: [50, 50] }
    const next = refreshProfilePanes(tree, liveSessions, true)
    if (next.type !== 'split') throw new Error('unreachable')
    expect((next.children[0] as typeof a).source).toBeNull()
    expect(next.children[1]).toBe(b)
  })
})

describe('refreshTabs', () => {
  it('re-derives the tab title from the active leaf when a profile is deleted out from under it', () => {
    const leaf = {
      ...blankLeaf(),
      source: { protocol: 'sshProfile' as const, profileId: 'gone' },
      initial: { id: 'gone', label: 'Deleted Profile' } as never,
    }
    const tab: Tab = { id: 't1', title: 'Deleted Profile', root: leaf, activePaneId: leaf.id }
    const [next] = refreshTabs([tab], [], true)
    // The pane is blanked (no live profile), but leafTitle still resolves the
    // title from the stored `initial.label`, so the tab name itself survives
    // even though the connection didn't.
    expect(next.title).toBe('Deleted Profile')
    expect(next.root.type).toBe('leaf')
    if (next.root.type !== 'leaf') throw new Error('unreachable')
    expect(next.root.source).toBeNull()
  })

  it("falls back to the tree's first leaf when activePaneId no longer resolves", () => {
    const a = blankLeaf()
    const b = blankLeaf()
    const root: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [a, b], sizes: [50, 50] }
    const tab: Tab = { id: 't1', title: 'stale', root, activePaneId: 'no-longer-exists' }
    const [next] = refreshTabs([tab], [], true)
    expect(next.title).toBe('stale') // neither leaf carries a source or label
  })
})

// Characterization tests for the tree-operation pattern duplicated across
// closePaneNow, popPaneToNewTab, attachTabToPane and focusPane in App.tsx —
// each recomputes a tab's title from whichever leaf becomes active using
// exactly this composition of primitives. Phase 4 collapses the four
// call sites into one helper; these tests are what prove that collapse
// changed nothing.
describe('the title-follows-active-leaf pattern (closeLeaf + firstLeaf + leafTitle)', () => {
  it('retitles to the surviving leaf when the active pane is the one that closed', () => {
    const closing = { ...blankLeaf(), initial: { label: 'Closing' } as never }
    const surviving = { ...blankLeaf(), source: { protocol: 'telnet' as const, config: { host: 'h', port: 23 } as never } }
    const root: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [closing, surviving], sizes: [50, 50] }

    const newRoot = closeLeaf(root, closing.id)
    expect(newRoot).not.toBeNull()
    // closePaneNow's rule: if the closed pane was active, the new active
    // pane is the new root's first leaf.
    const newActiveId = firstLeaf(newRoot!).id
    expect(newActiveId).toBe(surviving.id)
    expect(leafTitle(surviving, 'old title')).toBe('h:23')
  })

  it('leaves the title alone when the active pane was not the one that changed', () => {
    const active = { ...blankLeaf(), initial: { label: 'Still Active' } as never }
    const other = blankLeaf()
    const root: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [active, other], sizes: [50, 50] }
    const newRoot = closeLeaf(root, other.id)
    expect(newRoot).toBe(active) // collapses to the untouched sibling
    expect(leafTitle(active, 'old title')).toBe('Still Active')
  })
})

describe('attachTabToPane id preservation (updateLeaf replacing a target with a dragged leaf)', () => {
  it('the attached leaf keeps the dragged leaf id, not the target pane id', () => {
    const target = blankLeaf()
    const draggedLeaf = { ...blankLeaf(), source: { protocol: 'telnet' as const, config: { host: 'h', port: 23 } as never } }
    const root: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [target, blankLeaf()], sizes: [50, 50] }

    const next = updateLeaf(root, target.id, () => draggedLeaf)
    if (next.type !== 'split') throw new Error('unreachable')
    expect(next.children[0].id).toBe(draggedLeaf.id)
    expect(next.children[0].id).not.toBe(target.id)
  })
})
