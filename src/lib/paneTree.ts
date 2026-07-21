import type { PaneLeaf, PaneNode } from '../types'

export function newPaneId() {
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function blankLeaf(): PaneLeaf {
  return { type: 'leaf', id: newPaneId(), source: null, generation: 0 }
}

/** Rebuilds a tree with fresh ids, preserving structure, sources and split
 * sizes. Required when materialising a saved workspace: its stored ids were
 * generated in a previous run and can collide with live panes — including
 * with itself, if the same workspace is opened twice. `generation` resets so
 * the restored panes mount and connect as new sessions. */
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

/** Whether `node`'s outermost split is vertical (stacked top/bottom) — a
 * top-level horizontal (side-by-side) arrangement keeps the indicator bar
 * at its normal thin height even if one of its branches is further split
 * vertically further down; that nested stack just renders thinner within
 * its own segment, which is preferred over growing the whole tab's bar
 * height for every tab that has a vertical split anywhere in it. Only a
 * vertical split at the top level actually needs the whole bar taller to
 * show its two rows distinctly. */
export function isTopSplitVertical(node: PaneNode): boolean {
  return node.type !== 'leaf' && node.direction === 'vertical'
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

/** Replaces `id`'s leaf with a split containing the original leaf and a new
 * blank one. Splitting always produces a binary split, regardless of the
 * parent's direction — nesting is how you build 3+ pane layouts. */
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
