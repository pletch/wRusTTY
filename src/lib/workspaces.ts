import { invoke } from '@tauri-apps/api/core'
import type { Tab } from '../types'
import { sanitizeTabs, countUnsaveable } from './sessionSnapshot'

/** Serial is deliberately excluded from workspaces: a saved arrangement is
 * reopened days or weeks later, and a USB adapter moved to another socket
 * has by then silently become a different COM number pointing at whatever
 * else is plugged in. Serial stays ad-hoc. */
const WORKSPACE_SANITIZE = { allowSerial: false } as const

/** A named set of tabs and their pane arrangement. `tabs` is the same shape
 * the app already persists for launch restore — the Rust side stores it
 * opaquely and never inspects it. */
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

/** Everything a workspace can safely carry: saved SSH sessions and telnet
 * endpoints. Panes using a password typed at connect time are dropped — that
 * secret was never persisted anywhere and never will be. */
export function captureTabs(tabs: Tab[]): Tab[] {
  return sanitizeTabs(tabs, WORKSPACE_SANITIZE)
}

/** How many open panes a capture would drop, so the user is told before
 * saving rather than discovering it on reopen. */
export function countDropped(tabs: Tab[]): number {
  return countUnsaveable(tabs, WORKSPACE_SANITIZE)
}

/** The workspace `name` would collide with, if any. Matched the way the Rust
 * side matches (trimmed, case-insensitive) so the UI can offer to replace it
 * rather than let the save come back as an "already exists" error. */
export function findByName(saved: Workspace[], name: string): Workspace | undefined {
  const key = name.trim().toLowerCase()
  return key ? saved.find((w) => w.name.trim().toLowerCase() === key) : undefined
}

/** First unused "Workspace N", for when the name field is left blank.
 * Counting the list wouldn't do: delete one and the count walks back onto a
 * name that's still taken, which is now a hard error rather than a duplicate. */
export function defaultName(saved: Workspace[]): string {
  for (let n = saved.length + 1; ; n++) {
    const candidate = `Workspace ${n}`
    if (!findByName(saved, candidate)) return candidate
  }
}
