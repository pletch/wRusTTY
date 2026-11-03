import { invoke } from '@tauri-apps/api/core'
import type { Tab } from '../types'
import { transportOf } from './connection'
import { allLeaves } from './paneTree'
import { sanitizeTabs, countUnsaveable } from './sessionSnapshot'

/** Serial panes are excluded from workspaces: reopened later, a moved USB
 * adapter may have a different COM number. */
const WORKSPACE_SANITIZE = { allowSerial: false } as const

/** A named set of tabs and pane arrangement, in the launch-restore shape;
 * Rust stores it opaquely. */
export interface Workspace {
  id: string
  name: string
  tabs: Tab[]
}

export function listWorkspaces() {
  return invoke<Workspace[]>('list_workspaces')
}

export function saveWorkspace(workspace: Workspace) {
  return invoke<void>('save_workspace', { workspace })
}

export function deleteWorkspace(id: string) {
  return invoke<void>('delete_workspace', { id })
}

/**
 * A workspace as a phone opens it: one pane to a tab, since a phone has no room for
 * splits, in the saved order. `skipped` counts panes a phone can't open, like a local
 * shell. An empty pane is left out without being counted, as there's nothing to lose.
 * The saved workspace isn't touched, so it keeps its layout on a desktop.
 */
export function flattenForPhone(tabs: Tab[]): { tabs: Tab[]; skipped: number } {
  const flat: Tab[] = []
  let skipped = 0
  for (const tab of tabs) {
    for (const leaf of allLeaves(tab.root)) {
      if (leaf.source) {
        const transport = transportOf(leaf.source)
        if (transport !== 'ssh' && transport !== 'telnet') {
          skipped++
          continue
        }
      } else if (!leaf.initial) {
        continue
      }
      flat.push({ ...tab, root: leaf, activePaneId: leaf.id })
    }
  }
  return { tabs: flat, skipped }
}

/** Everything a workspace can safely carry. Panes using a password typed at
 * connect are dropped; that secret was never persisted. */
export function captureTabs(tabs: Tab[]): Tab[] {
  return sanitizeTabs(tabs, WORKSPACE_SANITIZE)
}

/** How many panes a capture would drop, so the user is told before saving. */
export function countDropped(tabs: Tab[]): number {
  return countUnsaveable(tabs, WORKSPACE_SANITIZE)
}

/** The workspace `name` would collide with, matched as Rust does (trimmed,
 * case-insensitive), so the UI can offer to replace it. */
export function findByName(saved: Workspace[], name: string): Workspace | undefined {
  const key = name.trim().toLowerCase()
  return key ? saved.find((w) => w.name.trim().toLowerCase() === key) : undefined
}

/** First unused "Workspace N" for a blank name; counting the list could land
 * on a name still taken after a delete. */
export function defaultName(saved: Workspace[]): string {
  for (let n = saved.length + 1; ; n++) {
    const candidate = `Workspace ${n}`
    if (!findByName(saved, candidate)) return candidate
  }
}
