import { describe, expect, it } from 'vitest'
import type { ConnectionSource } from './connection'
import type { PaneLeaf, PaneNode, Tab } from '../types'
import { flattenForPhone } from './workspaces'

const ssh = (profileId: string): ConnectionSource => ({ protocol: 'sshProfile', profileId })
const local: ConnectionSource = { protocol: 'localProfile', profileId: 'p', shellId: 'pwsh' }

function leaf(id: string, source: ConnectionSource | null, extra: Partial<PaneLeaf> = {}): PaneLeaf {
  return { type: 'leaf', id, source, generation: 0, ...extra }
}

function split(first: PaneNode, second: PaneNode): PaneNode {
  return {
    type: 'split',
    id: `${first.id}+${second.id}`,
    direction: 'horizontal',
    children: [first, second],
    sizes: [50, 50],
  }
}

function tab(id: string, root: PaneNode, activePaneId = 'a'): Tab {
  return { id, title: id, root, activePaneId }
}

describe('flattenForPhone', () => {
  it('gives each pane of a split its own tab, in the saved order', () => {
    const { tabs, skipped } = flattenForPhone([
      tab('one', split(leaf('a', ssh('1')), split(leaf('b', ssh('2')), leaf('c', ssh('3'))))),
      tab('two', leaf('d', ssh('4')), 'd'),
    ])
    expect(tabs.map((t) => t.root.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(tabs.every((t) => t.root.type === 'leaf')).toBe(true)
    expect(tabs.map((t) => t.activePaneId)).toEqual(['a', 'b', 'c', 'd'])
    expect(skipped).toBe(0)
  })

  it('counts and skips panes a phone cannot open', () => {
    const { tabs, skipped } = flattenForPhone([
      tab('one', split(leaf('a', ssh('1')), leaf('b', local))),
      tab('two', leaf('c', { protocol: 'serialProfile', profileId: 's' }), 'c'),
    ])
    expect(tabs.map((t) => t.root.id)).toEqual(['a'])
    expect(skipped).toBe(2)
  })

  it('keeps a pane waiting on its connect form, and drops an empty one without counting it', () => {
    const { tabs, skipped } = flattenForPhone([
      tab('one', split(leaf('a', null, { initial: { label: 'saved' } }), leaf('b', null))),
    ])
    expect(tabs.map((t) => t.root.id)).toEqual(['a'])
    expect(skipped).toBe(0)
  })

  it('leaves the saved tabs as they were', () => {
    const root = split(leaf('a', ssh('1')), leaf('b', ssh('2')))
    const saved = [tab('one', root)]
    flattenForPhone(saved)
    expect(saved[0].root).toBe(root)
    expect(saved[0].activePaneId).toBe('a')
  })

  it('has nothing to offer for a workspace of only local shells', () => {
    expect(flattenForPhone([tab('one', leaf('a', local))])).toEqual({ tabs: [], skipped: 1 })
  })
})
