import type { PaneLeaf, PaneNode } from '../types'

export function newPaneId() {
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function blankLeaf(): PaneLeaf {
  return { type: 'leaf', id: newPaneId(), source: null, generation: 0 }
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

/** Whether `node` contains a vertical (stacked top/bottom) split anywhere,
 * at any depth — a purely horizontal (side-by-side) arrangement, however
 * many panes wide, doesn't need any more room than a single pane does to
 * render clearly; only a stacked split actually needs the extra height to
 * show two rows distinctly. Used to grow a tab's indicator bar only when
 * that's actually true, rather than for every split. */
export function hasVerticalSplit(node: PaneNode): boolean {
  if (node.type === 'leaf') return false
  return node.direction === 'vertical' || node.children.some(hasVerticalSplit)
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
