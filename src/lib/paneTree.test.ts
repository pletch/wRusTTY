import { describe, it, expect } from 'vitest'
import type { PaneNode } from '../types'
import {
  blankLeaf,
  reidentify,
  findLeaf,
  firstLeaf,
  allLeaves,
  verticalRows,
  horizontalColumns,
  splitBlocker,
  canSplitLeaf,
  updateLeaf,
  splitLeaf,
  closeLeaf,
  MAX_PANES_PER_TAB,
  MAX_PANE_ROWS,
  MAX_PANE_COLUMNS,
} from './paneTree'

describe('blankLeaf', () => {
  it('creates a fresh, unconnected leaf defaulting to the ghostty engine', () => {
    const leaf = blankLeaf()
    expect(leaf.type).toBe('leaf')
    expect(leaf.source).toBeNull()
    expect(leaf.generation).toBe(0)
    expect(leaf.engine).toBe('ghostty')
  })

  it('assigns each leaf a distinct id', () => {
    const a = blankLeaf()
    const b = blankLeaf()
    expect(a.id).not.toBe(b.id)
  })
})

describe('splitLeaf', () => {
  it('replaces the target leaf with a split holding the original and a new blank leaf', () => {
    const leaf = blankLeaf()
    const next = splitLeaf(leaf, leaf.id, 'horizontal')
    expect(next.type).toBe('split')
    if (next.type !== 'split') throw new Error('unreachable')
    expect(next.direction).toBe('horizontal')
    expect(next.sizes).toEqual([50, 50])
    expect(next.children[0]).toEqual(leaf)
    expect(next.children[1].id).not.toBe(leaf.id)
  })

  it('leaves an untouched sibling leaf referentially identical', () => {
    const a = blankLeaf()
    const b = blankLeaf()
    const tree: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [a, b], sizes: [50, 50] }
    const next = splitLeaf(tree, a.id, 'vertical')
    if (next.type !== 'split') throw new Error('unreachable')
    expect(next.children[1]).toBe(b)
  })

  it('is a no-op when the id is not present in the tree', () => {
    const leaf = blankLeaf()
    const next = splitLeaf(leaf, 'not-a-real-id', 'horizontal')
    expect(next).toEqual(leaf)
  })
})

describe('closeLeaf', () => {
  it('returns null only when closing the last leaf in the tree', () => {
    const leaf = blankLeaf()
    expect(closeLeaf(leaf, leaf.id)).toBeNull()
  })

  it('collapses a split into the surviving sibling', () => {
    const a = blankLeaf()
    const b = blankLeaf()
    const tree: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [a, b], sizes: [50, 50] }
    expect(closeLeaf(tree, a.id)).toBe(b)
    expect(closeLeaf(tree, b.id)).toBe(a)
  })

  it('collapses only the inner split in a nested tree, leaving the rest intact', () => {
    const a = blankLeaf()
    const b = blankLeaf()
    const c = blankLeaf()
    const inner: PaneNode = { type: 'split', id: 'inner', direction: 'vertical', children: [b, c], sizes: [50, 50] }
    const tree: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [a, inner], sizes: [50, 50] }
    const next = closeLeaf(tree, b.id)
    if (!next || next.type !== 'split') throw new Error('unreachable')
    expect(next.children[0]).toBe(a)
    expect(next.children[1]).toBe(c)
  })
})

describe('updateLeaf', () => {
  it('updates only the target leaf, leaving every other leaf referentially identical', () => {
    const a = blankLeaf()
    const b = blankLeaf()
    const tree: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [a, b], sizes: [50, 50] }
    const next = updateLeaf(tree, a.id, (leaf) => ({ ...leaf, generation: leaf.generation + 1 }))
    if (next.type !== 'split') throw new Error('unreachable')
    expect(next.children[0]).not.toBe(a)
    expect((next.children[0] as typeof a).generation).toBe(1)
    expect(next.children[1]).toBe(b)
  })
})

describe('reidentify', () => {
  it('gives every node in the tree a fresh id and resets leaf generation', () => {
    const a = { ...blankLeaf(), generation: 3, source: null }
    const b = blankLeaf()
    const tree: PaneNode = { type: 'split', id: 'root', direction: 'vertical', children: [a, b], sizes: [30, 70] }
    const next = reidentify(tree)
    if (next.type !== 'split') throw new Error('unreachable')
    expect(next.id).not.toBe('root')
    expect(next.children[0].id).not.toBe(a.id)
    expect(next.children[1].id).not.toBe(b.id)
    expect((next.children[0] as typeof a).generation).toBe(0)
    // structure and non-id fields are preserved
    expect(next.direction).toBe('vertical')
    expect(next.sizes).toEqual([30, 70])
  })

  it('produces distinct ids across repeated calls on the same tree', () => {
    const tree = blankLeaf()
    const first = reidentify(tree)
    const second = reidentify(tree)
    expect(first.id).not.toBe(second.id)
  })
})

describe('findLeaf / firstLeaf / allLeaves', () => {
  it('locates a leaf by id anywhere in the tree, and null when absent', () => {
    const a = blankLeaf()
    const b = blankLeaf()
    const tree: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [a, b], sizes: [50, 50] }
    expect(findLeaf(tree, b.id)).toBe(b)
    expect(findLeaf(tree, 'missing')).toBeNull()
  })

  it('firstLeaf always walks the first child', () => {
    const a = blankLeaf()
    const b = blankLeaf()
    const tree: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [a, b], sizes: [50, 50] }
    expect(firstLeaf(tree)).toBe(a)
  })

  it('allLeaves returns every leaf in left-to-right order', () => {
    const a = blankLeaf()
    const b = blankLeaf()
    const c = blankLeaf()
    const inner: PaneNode = { type: 'split', id: 'inner', direction: 'vertical', children: [b, c], sizes: [50, 50] }
    const tree: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [a, inner], sizes: [50, 50] }
    expect(allLeaves(tree)).toEqual([a, b, c])
  })
})

describe('verticalRows / horizontalColumns on asymmetric trees', () => {
  it('counts a single leaf as one row and one column', () => {
    const leaf = blankLeaf()
    expect(verticalRows(leaf)).toBe(1)
    expect(horizontalColumns(leaf)).toBe(1)
  })

  it('sums rows down a vertical chain but takes the max across a horizontal split', () => {
    // root: horizontal split of [leaf] and [vertical chain of 3 leaves]
    const left = blankLeaf()
    const r1 = blankLeaf()
    const r2 = blankLeaf()
    const r3 = blankLeaf()
    const rightChain: PaneNode = {
      type: 'split',
      id: 'r-inner',
      direction: 'vertical',
      children: [r1, { type: 'split', id: 'r-inner-2', direction: 'vertical', children: [r2, r3], sizes: [50, 50] }],
      sizes: [50, 50],
    }
    const tree: PaneNode = { type: 'split', id: 'root', direction: 'horizontal', children: [left, rightChain], sizes: [50, 50] }

    // left branch has 1 row, right branch has 3 rows stacked -> max is 3
    expect(verticalRows(tree)).toBe(3)
    // horizontal split at the root adds columns: 1 (left) + 1 (right, since
    // the right branch is entirely vertical splits) = 2
    expect(horizontalColumns(tree)).toBe(2)
  })
})

// Builds a chain of `count` leaves stacked along `direction` by always
// splitting the most recently added leaf.
function buildChain(direction: 'horizontal' | 'vertical', count: number): PaneNode {
  let tree: PaneNode = blankLeaf()
  let targetId = (tree as { id: string }).id
  for (let i = 1; i < count; i++) {
    tree = splitLeaf(tree, targetId, direction)
    const leaves = allLeaves(tree)
    targetId = leaves[leaves.length - 1].id
  }
  return tree
}

describe('splitBlocker / canSplitLeaf at the panes / rows / columns boundaries', () => {
  it('allows splitting up to MAX_PANE_ROWS, blocks the split that would exceed it', () => {
    const atCap = buildChain('vertical', MAX_PANE_ROWS)
    expect(verticalRows(atCap)).toBe(MAX_PANE_ROWS)
    const lastLeaf = allLeaves(atCap)[allLeaves(atCap).length - 1]
    expect(splitBlocker(atCap, lastLeaf.id, 'vertical')).toBe('rows')
    expect(canSplitLeaf(atCap, lastLeaf.id, 'vertical')).toBe(false)
  })

  it('allows splitting up to MAX_PANE_COLUMNS, blocks the split that would exceed it', () => {
    const atCap = buildChain('horizontal', MAX_PANE_COLUMNS)
    expect(horizontalColumns(atCap)).toBe(MAX_PANE_COLUMNS)
    const lastLeaf = allLeaves(atCap)[allLeaves(atCap).length - 1]
    expect(splitBlocker(atCap, lastLeaf.id, 'horizontal')).toBe('columns')
    expect(canSplitLeaf(atCap, lastLeaf.id, 'horizontal')).toBe(false)
  })

  it('allows splitting up to MAX_PANES_PER_TAB via a balanced grid, blocks the split that would exceed it', () => {
    // Build a balanced 4x2 grid: 4 columns, 2 rows, 8 leaves — exactly at
    // the panes cap without tripping the row or column caps first.
    let tree: PaneNode = blankLeaf()
    tree = splitLeaf(tree, firstLeaf(tree).id, 'horizontal')
    for (const leaf of allLeaves(tree)) {
      tree = splitLeaf(tree, leaf.id, 'vertical')
    }
    // Now 4 columns... actually 2 columns x 2 rows = 4 leaves; split each
    // column once more horizontally to reach 4 columns x 2 rows = 8 leaves.
    for (const leaf of [...allLeaves(tree)]) {
      tree = splitLeaf(tree, leaf.id, 'horizontal')
    }

    expect(allLeaves(tree).length).toBe(MAX_PANES_PER_TAB)
    expect(verticalRows(tree)).toBeLessThanOrEqual(MAX_PANE_ROWS)
    expect(horizontalColumns(tree)).toBeLessThanOrEqual(MAX_PANE_COLUMNS)

    const someLeaf = allLeaves(tree)[0]
    expect(splitBlocker(tree, someLeaf.id, 'vertical')).toBe('panes')
    expect(canSplitLeaf(tree, someLeaf.id, 'vertical')).toBe(false)
  })

  it('reports no blocker, and allows the split, when comfortably under every cap', () => {
    const leaf = blankLeaf()
    expect(splitBlocker(leaf, leaf.id, 'horizontal')).toBeNull()
    expect(canSplitLeaf(leaf, leaf.id, 'horizontal')).toBe(true)
  })

  it('canSplitLeaf is false for an id that is not in the tree at all', () => {
    const leaf = blankLeaf()
    expect(canSplitLeaf(leaf, 'not-present', 'horizontal')).toBe(false)
  })
})
