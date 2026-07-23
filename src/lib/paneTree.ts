import type { PaneLeaf, PaneNode } from '../types'

export function newPaneId() {
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function blankLeaf(): PaneLeaf {
  return {
    type: 'leaf',
    id: newPaneId(),
    source: null,
    generation: 0,
    // xterm.js stays the default until the Ghostty engine is feature-complete
    // and measured faster here: it currently has no scrollback (scrollLines and
    // scrollToLine are no-ops and scrollbackLength is a constant), no selection,
    // no search and no bell, so a pane that opens on it silently loses working
    // features. Selectable per-pane in the meantime.
    engine: 'xterm',
  }
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

/** How many rows the tab strip's pane map has to stack for this tree.
 *
 * Vertical splits stack their children, so those add up; horizontal splits
 * sit side by side, so the deepest branch decides. The bar's height is then
 * driven by this rather than by a flat "is the top split vertical", which
 * gave a nested stack the same height as a single row and left its segments
 * sub-pixel — a stacked split inside a 3px segment renders two 0.5px lines,
 * which is simply invisible. */
export function verticalRows(node: PaneNode): number {
  if (node.type === 'leaf') return 1
  const [first, second] = node.children.map(verticalRows)
  return node.direction === 'vertical' ? first + second : Math.max(first, second)
}

/** The same count the other way round: how many panes the widest band of
 * this tree puts side by side. Only used for the split limits — the pane map
 * doesn't need it, since columns divide the width it already has. */
export function horizontalColumns(node: PaneNode): number {
  if (node.type === 'leaf') return 1
  const [first, second] = node.children.map(horizontalColumns)
  return node.direction === 'horizontal' ? first + second : Math.max(first, second)
}

/** Split limits for one tab. Deliberate ceilings rather than technical ones:
 * past these the panes are too small to work in on a normal window, and
 * anything genuinely needing more wants another tab.
 *
 * The two axis caps do most of the work — they're what keeps any single pane
 * from being reduced to a sliver, and the row cap is also what the tab
 * strip's pane map is sized for (PANE_MAP_MAX_ROWS in TabBar.tsx). The total
 * is a separate ceiling on top, since the axis caps alone would permit a
 * 4×4 grid.
 *
 * Trees saved by an earlier build may exceed any of these; they still open
 * and render, they just can't be split further. */
export const MAX_PANES_PER_TAB = 8
export const MAX_PANE_ROWS = 4
export const MAX_PANE_COLUMNS = 4

export type SplitLimit = 'panes' | 'rows' | 'columns'

/** Which limit splitting `id` in `direction` would breach, or null if it's
 * allowed. Assumes `id` is a leaf of `root` — see canSplitLeaf.
 *
 * Decided by building the resulting tree and measuring it, rather than by
 * reasoning about the leaf's position: whether a split adds a row, a column
 * or neither depends on where the leaf sits and which way every split above
 * it runs. The tree is at most eight leaves, so producing the candidate is
 * cheaper than getting that reasoning right — and it can't disagree with
 * what the split would actually do, because it *is* the split. */
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
