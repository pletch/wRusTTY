import type { PaneLeaf, PaneNode } from '../types'

export function newPaneId() {
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Leaves restored from older snapshots may carry an `engine` field; nothing
// reads it.
export function blankLeaf(): PaneLeaf {
  return {
    type: 'leaf',
    id: newPaneId(),
    source: null,
    generation: 0,
  }
}

/** Rebuilds a tree with fresh ids, keeping structure, sources and split sizes.
 * Needed when opening a saved workspace, whose stored ids can collide with
 * live panes (or itself, if opened twice). `generation` resets so panes
 * connect as new sessions. */
export function reidentify(node: PaneNode): PaneNode {
  if (node.type === 'leaf') {
    return { ...node, id: newPaneId(), generation: 0 }
  }
  return {
    ...node,
    id: newPaneId(),
    children: [reidentify(node.children[0]), reidentify(node.children[1])],
  }
}

export function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  for (const child of node.children) {
    const found = findLeaf(child, id)
    if (found) return found
  }
  return null
}

/** First leaf in the tree, used to pick a fallback active pane. */
export function firstLeaf(node: PaneNode): PaneLeaf {
  return node.type === 'leaf' ? node : firstLeaf(node.children[0])
}

export function allLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node]
  return [...allLeaves(node.children[0]), ...allLeaves(node.children[1])]
}

/** How many rows the tab strip's pane map stacks for this tree: vertical
 * splits add their children; horizontal ones take the deepest branch. */
export function verticalRows(node: PaneNode): number {
  if (node.type === 'leaf') return 1
  const [first, second] = node.children.map(verticalRows)
  return node.direction === 'vertical' ? first + second : Math.max(first, second)
}

/** How many panes the widest band puts side by side, for the split limits. */
export function horizontalColumns(node: PaneNode): number {
  if (node.type === 'leaf') return 1
  const [first, second] = node.children.map(horizontalColumns)
  return node.direction === 'horizontal' ? first + second : Math.max(first, second)
}

/** Split limits for one tab: past these, panes are too small to work in.
 *
 * The axis caps keep any pane from becoming a sliver (the row cap also sizes
 * the pane map: PANE_MAP_MAX_ROWS in TabBar.tsx). The total caps what the axis
 * limits alone would allow (a 4×4 grid). Larger saved trees still open; they
 * just can't split further. */
export const MAX_PANES_PER_TAB = 8
export const MAX_PANE_ROWS = 4
export const MAX_PANE_COLUMNS = 4

export type SplitLimit = 'panes' | 'rows' | 'columns'

/** Which limit splitting `id` in `direction` would breach, or null. Assumes
 * `id` is a leaf of `root` (see canSplitLeaf). Builds and measures the
 * resulting tree (at most eight leaves), which can't disagree with the split. */
export function splitBlocker(
  root: PaneNode,
  id: string,
  direction: 'horizontal' | 'vertical',
): SplitLimit | null {
  const next = splitLeaf(root, id, direction)
  if (allLeaves(next).length > MAX_PANES_PER_TAB) return 'panes'
  if (verticalRows(next) > MAX_PANE_ROWS) return 'rows'
  if (horizontalColumns(next) > MAX_PANE_COLUMNS) return 'columns'
  return null
}

export function canSplitLeaf(
  root: PaneNode,
  id: string,
  direction: 'horizontal' | 'vertical',
): boolean {
  return !!findLeaf(root, id) && splitBlocker(root, id, direction) === null
}

/** Returns a new tree with `id`'s leaf replaced via `update`. */
export function updateLeaf(
  node: PaneNode,
  id: string,
  update: (leaf: PaneLeaf) => PaneLeaf,
): PaneNode {
  if (node.type === 'leaf') {
    return node.id === id ? update(node) : node
  }
  return {
    ...node,
    children: [
      updateLeaf(node.children[0], id, update),
      updateLeaf(node.children[1], id, update),
    ],
  }
}

/** Replaces `id`'s leaf with a binary split of it and a new blank leaf;
 * nesting builds 3+ pane layouts. */
export function splitLeaf(
  node: PaneNode,
  id: string,
  direction: 'horizontal' | 'vertical',
): PaneNode {
  if (node.type === 'leaf') {
    if (node.id !== id) return node
    return {
      type: 'split',
      id: newPaneId(),
      direction,
      children: [node, blankLeaf()],
      sizes: [50, 50],
    }
  }
  return {
    ...node,
    children: [
      splitLeaf(node.children[0], id, direction),
      splitLeaf(node.children[1], id, direction),
    ],
  }
}

/** Removes `id`'s leaf, collapsing its parent split into the sibling that's
 * left over. Returns `null` if `id` was the whole tree (tab should close). */
export function closeLeaf(node: PaneNode, id: string): PaneNode | null {
  if (node.type === 'leaf') {
    return node.id === id ? null : node
  }

  const [a, b] = node.children
  if (a.type === 'leaf' && a.id === id) return b
  if (b.type === 'leaf' && b.id === id) return a

  return {
    ...node,
    children: [closeLeaf(a, id) ?? a, closeLeaf(b, id) ?? b],
  }
}
