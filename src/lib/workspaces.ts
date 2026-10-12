import { invoke } from '@tauri-apps/api/core'
import type { Tab } from '../types'
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
