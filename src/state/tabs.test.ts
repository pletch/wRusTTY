import { describe, it, expect } from 'vitest'
import type { ConnectionSource } from '../lib/connection'
import { blankLeaf } from '../lib/paneTree'
import type { PaneNode, Tab } from '../types'
import { tabsReducer, layoutSignature } from './tabs'
import type { TabsState } from './tabs'

function leaf(overrides: Partial<ReturnType<typeof blankLeaf>> = {}) {
  return { ...blankLeaf(), ...overrides }
}

function tab(root: PaneNode, overrides: Partial<Tab> = {}): Tab {
  const activePaneId = overrides.activePaneId ?? (root.type === 'leaf' ? root.id : root.children[0].id)
  return { id: `tab-${Math.random()}`, title: 'tab', root, activePaneId, ...overrides }
}

function split(a: PaneNode, b: PaneNode, direction: 'horizontal' | 'vertical' = 'horizontal'): PaneNode {
  return { type: 'split', id: `split-${Math.random()}`, direction, children: [a, b], sizes: [50, 50] }
}

const telnet = (host = 'h', port = 23): ConnectionSource => ({ protocol: 'telnet', config: { host, port } as never })

describe('restored', () => {
  it('replaces tabs and activeTabId wholesale', () => {
    const before: TabsState = { tabs: [tab(leaf())], activeTabId: 'stale' }
    const fresh = [tab(leaf())]
    const state = tabsReducer(before, { type: 'restored', tabs: fresh, activeTabId: fresh[0].id })
    expect(state.tabs).toBe(fresh)
    expect(state.activeTabId).toBe(fresh[0].id)
  })
})

describe('tabOpened', () => {
  it('appends the tab and makes it active', () => {
    const existing = tab(leaf())
    const opened = tab(leaf())
    const state = tabsReducer({ tabs: [existing], activeTabId: existing.id }, { type: 'tabOpened', tab: opened })
    expect(state.tabs).toEqual([existing, opened])
    expect(state.activeTabId).toBe(opened.id)
  })
})

describe('tabClosed', () => {
  it('removes the tab and picks the tab that slid into its slot when it was active', () => {
    const a = tab(leaf())
    const b = tab(leaf())
    const c = tab(leaf())
    const state = tabsReducer({ tabs: [a, b, c], activeTabId: b.id }, { type: 'tabClosed', tabId: b.id })
    expect(state.tabs.map((t) => t.id)).toEqual([a.id, c.id])
    expect(state.activeTabId).toBe(c.id) // c slid into b's old index (1)
  })

  it('falls back to the previous tab when the closed active tab was last', () => {
    const a = tab(leaf())
    const b = tab(leaf())
    const state = tabsReducer({ tabs: [a, b], activeTabId: b.id }, { type: 'tabClosed', tabId: b.id })
    expect(state.activeTabId).toBe(a.id)
  })

  it('goes to null when the last tab closes', () => {
    const a = tab(leaf())
    const state = tabsReducer({ tabs: [a], activeTabId: a.id }, { type: 'tabClosed', tabId: a.id })
    expect(state.tabs).toEqual([])
    expect(state.activeTabId).toBeNull()
  })

  it('leaves activeTabId untouched when closing a background tab', () => {
    const a = tab(leaf())
    const b = tab(leaf())
    const state = tabsReducer({ tabs: [a, b], activeTabId: a.id }, { type: 'tabClosed', tabId: b.id })
    expect(state.activeTabId).toBe(a.id)
  })

  it('is a no-op for an id that is not open', () => {
    const before: TabsState = { tabs: [tab(leaf())], activeTabId: null }
    expect(tabsReducer(before, { type: 'tabClosed', tabId: 'ghost' })).toBe(before)
  })
})

describe('tabSelected', () => {
  it('changes the active tab', () => {
    const a = tab(leaf())
    const b = tab(leaf())
    const state = tabsReducer({ tabs: [a, b], activeTabId: a.id }, { type: 'tabSelected', tabId: b.id })
    expect(state.activeTabId).toBe(b.id)
  })

  it('is a no-op (same reference) when already active', () => {
    const a = tab(leaf())
    const before: TabsState = { tabs: [a], activeTabId: a.id }
    expect(tabsReducer(before, { type: 'tabSelected', tabId: a.id })).toBe(before)
  })
})

describe('tabsReordered', () => {
  it('moves the dragged tab to the target position', () => {
    const a = tab(leaf())
    const b = tab(leaf())
    const c = tab(leaf())
    const state = tabsReducer({ tabs: [a, b, c], activeTabId: null }, { type: 'tabsReordered', draggedId: a.id, targetId: c.id })
    expect(state.tabs.map((t) => t.id)).toEqual([b.id, c.id, a.id])
  })

  it('is a no-op when dragged and target are the same', () => {
    const before: TabsState = { tabs: [tab(leaf())], activeTabId: null }
    expect(tabsReducer(before, { type: 'tabsReordered', draggedId: 'x', targetId: 'x' })).toBe(before)
  })

  it('is a no-op when either id is not open', () => {
    const a = tab(leaf())
    const before: TabsState = { tabs: [a], activeTabId: null }
    expect(tabsReducer(before, { type: 'tabsReordered', draggedId: a.id, targetId: 'ghost' })).toBe(before)
  })
})

describe('paneReconnected', () => {
  it('bumps generation and re-resolves an sshProfile source from initial.id', () => {
    const l = leaf({ source: telnet(), initial: { id: 'p1' } as never, generation: 2 })
    const t = tab(l)
    const state = tabsReducer({ tabs: [t], activeTabId: t.id }, { type: 'paneReconnected', tabId: t.id, paneId: l.id })
    const updated = state.tabs[0].root as typeof l
    expect(updated.source).toEqual({ protocol: 'sshProfile', profileId: 'p1' })
    expect(updated.generation).toBe(3)
  })

  it('replays the existing source when there is no initial.id', () => {
    const l = leaf({ source: telnet('h', 23), generation: 0 })
    const t = tab(l)
    const state = tabsReducer({ tabs: [t], activeTabId: t.id }, { type: 'paneReconnected', tabId: t.id, paneId: l.id })
    expect((state.tabs[0].root as typeof l).source).toEqual(telnet('h', 23))
  })
})

describe('paneEngineSet', () => {
  it('sets the engine and bumps generation', () => {
    const l = leaf({ engine: 'ghostty', generation: 0 })
    const t = tab(l)
    const state = tabsReducer({ tabs: [t], activeTabId: t.id }, {
      type: 'paneEngineSet',
      tabId: t.id,
      paneId: l.id,
      engine: 'xterm',
    })
    const updated = state.tabs[0].root as typeof l
    expect(updated.engine).toBe('xterm')
    expect(updated.generation).toBe(1)
  })
})

describe('workspaceMaterialized', () => {
  it('is a no-op when nothing was restored', () => {
    const before: TabsState = { tabs: [tab(leaf())], activeTabId: null }
    expect(tabsReducer(before, { type: 'workspaceMaterialized', restored: [], originTabId: null })).toBe(before)
  })

  it('splices into a blank origin tab, replacing it in place', () => {
    const before = tab(leaf()) // blank: single leaf, no source
    const after = tab(leaf({ source: telnet() }))
    const restored = [tab(leaf({ source: telnet() }))]
    const state = tabsReducer(
      { tabs: [before, after], activeTabId: before.id },
      { type: 'workspaceMaterialized', restored, originTabId: before.id },
    )
    expect(state.tabs.map((t) => t.id)).toEqual([restored[0].id, after.id])
    expect(state.activeTabId).toBe(restored[0].id)
  })

  it('appends when the origin tab is not blank', () => {
    const connected = tab(leaf({ source: telnet() }))
    const restored = [tab(leaf())]
    const state = tabsReducer(
      { tabs: [connected], activeTabId: connected.id },
      { type: 'workspaceMaterialized', restored, originTabId: connected.id },
    )
    expect(state.tabs.map((t) => t.id)).toEqual([connected.id, restored[0].id])
  })

  it('falls back to activeTabId when no originTabId is given', () => {
    const blank = tab(leaf())
    const restored = [tab(leaf({ source: telnet() }))]
    const state = tabsReducer(
      { tabs: [blank], activeTabId: blank.id },
      { type: 'workspaceMaterialized', restored, originTabId: null },
    )
    expect(state.tabs.map((t) => t.id)).toEqual([restored[0].id])
  })
})

describe('paneConnected / paneDisconnected / paneProfileApplied', () => {
  it('paneConnected sets the source and retitles when the pane is active', () => {
    const l = leaf()
    const t = tab(l)
    const state = tabsReducer({ tabs: [t], activeTabId: t.id }, {
      type: 'paneConnected',
      tabId: t.id,
      paneId: l.id,
      source: telnet('example.com', 23),
      backspaceSendsCtrlH: true,
    })
    expect((state.tabs[0].root as typeof l).source).toEqual(telnet('example.com', 23))
    expect(state.tabs[0].title).toBe('example.com:23')
  })

  it('paneDisconnected clears the source without touching the rest of the tree', () => {
    const l = leaf({ source: telnet() })
    const t = tab(l)
    const state = tabsReducer({ tabs: [t], activeTabId: t.id }, { type: 'paneDisconnected', tabId: t.id, paneId: l.id })
    expect((state.tabs[0].root as typeof l).source).toBeNull()
  })

  it('paneProfileApplied falls back to the existing source when none is given', () => {
    const l = leaf({ source: telnet() })
    const t = tab(l)
    const state = tabsReducer({ tabs: [t], activeTabId: t.id }, {
      type: 'paneProfileApplied',
      tabId: t.id,
      paneId: l.id,
      source: null,
      initial: { label: 'Saved' } as never,
    })
    const updated = state.tabs[0].root as typeof l
    expect(updated.source).toEqual(telnet())
    expect(updated.initial).toEqual({ label: 'Saved' })
    expect(state.tabs[0].title).toBe('Saved')
  })
})

describe('paneFocused', () => {
  it('switches the active pane and retitles from it', () => {
    const a = leaf()
    const b = leaf({ source: telnet('other', 23) })
    const t = tab(split(a, b), { activePaneId: a.id })
    const state = tabsReducer({ tabs: [t], activeTabId: t.id }, { type: 'paneFocused', tabId: t.id, paneId: b.id })
    expect(state.tabs[0].activePaneId).toBe(b.id)
    expect(state.tabs[0].title).toBe('other:23')
  })

  it('is a no-op (same tab reference) when the pane is already active', () => {
    const a = leaf()
    const t = tab(a)
    const state = tabsReducer({ tabs: [t], activeTabId: t.id }, { type: 'paneFocused', tabId: t.id, paneId: a.id })
    expect(state.tabs[0]).toBe(t)
  })
})

describe('paneSplit', () => {
  it('splits the target leaf and focuses the new leaf', () => {
    const a = leaf()
    const t = tab(a)
    const state = tabsReducer({ tabs: [t], activeTabId: t.id }, {
      type: 'paneSplit',
      tabId: t.id,
      paneId: a.id,
      direction: 'horizontal',
    })
    const root = state.tabs[0].root
    expect(root.type).toBe('split')
    expect(state.tabs[0].activePaneId).not.toBe(a.id)
  })

  it('is a no-op past the split limit', () => {
    // MAX_PANE_COLUMNS is 4 — build a 4-wide row, then try a 5th horizontal split.
    let root: PaneNode = leaf()
    let t = tab(root)
    let state: TabsState = { tabs: [t], activeTabId: t.id }
    for (let i = 0; i < 3; i++) {
      const lastLeaf = lastLeafOf(state.tabs[0].root)
      state = tabsReducer(state, { type: 'paneSplit', tabId: t.id, paneId: lastLeaf.id, direction: 'horizontal' })
    }
    const before = state
    const lastLeaf = lastLeafOf(state.tabs[0].root)
    state = tabsReducer(state, { type: 'paneSplit', tabId: t.id, paneId: lastLeaf.id, direction: 'horizontal' })
    expect(state.tabs[0].root).toEqual(before.tabs[0].root)
  })
})

function lastLeafOf(node: PaneNode): { id: string } {
  return node.type === 'leaf' ? node : lastLeafOf(node.children[1])
}

describe('paneClosed', () => {
  it('collapses to the sibling and retitles when the closed pane was active', () => {
    const a = leaf()
    const b = leaf({ source: telnet('survivor', 23) })
    const t = tab(split(a, b), { activePaneId: a.id })
    const state = tabsReducer({ tabs: [t], activeTabId: t.id }, { type: 'paneClosed', tabId: t.id, paneId: a.id })
    expect(state.tabs[0].root).toEqual(b)
    expect(state.tabs[0].activePaneId).toBe(b.id)
    expect(state.tabs[0].title).toBe('survivor:23')
  })

  it('leaves the tab untouched when the pane was not active', () => {
    const a = leaf({ initial: { label: 'Active' } as never })
    const b = leaf()
    const t = tab(split(a, b), { activePaneId: a.id })
    const state = tabsReducer({ tabs: [t], activeTabId: t.id }, { type: 'paneClosed', tabId: t.id, paneId: b.id })
    expect(state.tabs[0].activePaneId).toBe(a.id)
    expect(state.tabs[0].title).toBe('Active')
  })

  it('is a no-op when the pane is the whole tab (caller closes the tab instead)', () => {
    const a = leaf()
    const t = tab(a)
    const before: TabsState = { tabs: [t], activeTabId: t.id }
    expect(tabsReducer(before, { type: 'paneClosed', tabId: t.id, paneId: a.id })).toBe(before)
  })

  it('is a no-op for a tabId that is not open', () => {
    const before: TabsState = { tabs: [tab(leaf())], activeTabId: null }
    expect(tabsReducer(before, { type: 'paneClosed', tabId: 'ghost', paneId: 'ghost' })).toBe(before)
  })
})

describe('panePoppedToNewTab', () => {
  it('removes the pane from its tab, appends the popped tab, and focuses it', () => {
    const a = leaf()
    const b = leaf()
    const t = tab(split(a, b), { activePaneId: b.id })
    const popped = tab(b, { title: 'Popped' })
    const state = tabsReducer({ tabs: [t], activeTabId: t.id }, {
      type: 'panePoppedToNewTab',
      tabId: t.id,
      paneId: b.id,
      poppedTab: popped,
    })
    expect(state.tabs.map((x) => x.id)).toEqual([t.id, popped.id])
    expect(state.tabs[0].root).toEqual(a)
    expect(state.tabs[0].activePaneId).toBe(a.id) // b was active; falls back to the surviving leaf
    expect(state.activeTabId).toBe(popped.id)
  })

  it('is a no-op when the tab has no split to pop from', () => {
    const a = leaf()
    const t = tab(a)
    const before: TabsState = { tabs: [t], activeTabId: t.id }
    const popped = tab(leaf())
    expect(
      tabsReducer(before, { type: 'panePoppedToNewTab', tabId: t.id, paneId: a.id, poppedTab: popped }),
    ).toBe(before)
  })

  it('is a no-op for a tabId that is not open', () => {
    const before: TabsState = { tabs: [tab(leaf())], activeTabId: null }
    const popped = tab(leaf())
    expect(
      tabsReducer(before, { type: 'panePoppedToNewTab', tabId: 'ghost', paneId: 'ghost', poppedTab: popped }),
    ).toBe(before)
  })

  it('keeps the popped-from tab active when the popped pane was not the active one', () => {
    const a = leaf()
    const b = leaf()
    const t = tab(split(a, b), { activePaneId: a.id })
    const popped = tab(b)
    const state = tabsReducer({ tabs: [t], activeTabId: t.id }, {
      type: 'panePoppedToNewTab',
      tabId: t.id,
      paneId: b.id,
      poppedTab: popped,
    })
    expect(state.tabs[0].activePaneId).toBe(a.id)
  })
})

describe('tabAttachedToPane', () => {
  it('replaces the target leaf with the dragged leaf, keeping the dragged id', () => {
    const target = leaf()
    const other = leaf()
    const draggedLeaf = leaf({ source: telnet('dragged', 23) })
    const hostTab = tab(split(target, other), { activePaneId: target.id })
    const draggedTab = tab(draggedLeaf)
    const state = tabsReducer(
      { tabs: [hostTab, draggedTab], activeTabId: hostTab.id },
      { type: 'tabAttachedToPane', targetPaneId: target.id, draggedTabId: draggedTab.id },
    )
    expect(state.tabs.map((t) => t.id)).toEqual([hostTab.id]) // dragged tab consumed
    const root = state.tabs[0].root as PaneNode & { type: 'split' }
    expect(root.children[0].id).toBe(draggedLeaf.id)
    expect(state.tabs[0].activePaneId).toBe(draggedLeaf.id) // remapped from target.id
    expect(state.tabs[0].title).toBe('dragged:23')
  })

  it('picks a neighbor for activeTabId when the dragged tab itself was active', () => {
    const target = leaf()
    const draggedLeaf = leaf({ source: telnet() })
    const hostTab = tab(target)
    const draggedTab = tab(draggedLeaf)
    const other = tab(leaf())
    const state = tabsReducer(
      { tabs: [hostTab, draggedTab, other], activeTabId: draggedTab.id },
      { type: 'tabAttachedToPane', targetPaneId: target.id, draggedTabId: draggedTab.id },
    )
    // draggedTab (index 1) removed; the tab that slid into its slot is `other`
    expect(state.activeTabId).toBe(other.id)
  })

  it('leaves activeTabId untouched when a background tab was attached to', () => {
    const target = leaf()
    const draggedLeaf = leaf({ source: telnet() })
    const hostTab = tab(target)
    const draggedTab = tab(draggedLeaf)
    const active = tab(leaf())
    const state = tabsReducer(
      { tabs: [active, hostTab, draggedTab], activeTabId: active.id },
      { type: 'tabAttachedToPane', targetPaneId: target.id, draggedTabId: draggedTab.id },
    )
    expect(state.activeTabId).toBe(active.id)
  })

  it('is a no-op when the dragged tab is not a single connected leaf', () => {
    const hostTab = tab(leaf())
    const draggedTab = tab(leaf()) // no source
    const before: TabsState = { tabs: [hostTab, draggedTab], activeTabId: hostTab.id }
    expect(
      tabsReducer(before, { type: 'tabAttachedToPane', targetPaneId: hostTab.root.id, draggedTabId: draggedTab.id }),
    ).toBe(before)
  })
})

describe('layoutSignature', () => {
  it('changes when the active tab changes', () => {
    const a = tab(leaf())
    const b = tab(leaf())
    expect(layoutSignature([a, b], a.id)).not.toBe(layoutSignature([a, b], b.id))
  })

  it('changes when the active tab is split', () => {
    const l = leaf()
    const before = tab(l)
    const afterRoot = split(l, leaf())
    const after = { ...before, root: afterRoot }
    expect(layoutSignature([before], before.id)).not.toBe(layoutSignature([after], after.id))
  })

  it('is unaffected by split sizes changing', () => {
    const root = split(leaf(), leaf())
    const t = tab(root)
    const resized: Tab = { ...t, root: { ...root, sizes: [70, 30] } as PaneNode }
    expect(layoutSignature([t], t.id)).toBe(layoutSignature([resized], resized.id))
  })

  it('changes when a leaf at the same tree position is swapped for a different leaf (attach)', () => {
    const before = tab(leaf())
    const after = { ...before, root: leaf() } // different leaf id, same shape
    expect(layoutSignature([before], before.id)).not.toBe(layoutSignature([after], after.id))
  })

  it('handles an activeTabId with no matching tab (e.g. the last tab just closed)', () => {
    expect(layoutSignature([], null)).toBe('null')
    expect(layoutSignature([tab(leaf())], 'ghost')).toBe('ghost')
  })
})
