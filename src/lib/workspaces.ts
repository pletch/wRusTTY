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
