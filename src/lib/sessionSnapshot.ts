import type { ConnectionSource } from './connection'
import type { PaneNode, Tab } from '../types'
import { allLeaves } from './paneTree'

const STORAGE_KEY = 'wr-shell.session-snapshot'

/** Only these protocols can be reconnected without ever collecting a
 * plaintext secret outside the vault — a manually-typed SSH connection's
 * password/passphrase was never persisted anywhere and never will be, so
 * those leaves are dropped (reverted to a blank pane) rather than restored
 * as a broken shell of themselves with no credential to actually use. */
function restorableSource(source: ConnectionSource | null): ConnectionSource | null {
  if (!source) return null
  return source.protocol === 'sshProfile' ||
    source.protocol === 'telnet' ||
    source.protocol === 'serial'
    ? source
    : null
}

function sanitizeNode(node: PaneNode): PaneNode {
  if (node.type === 'leaf') {
    return { ...node, source: restorableSource(node.source) }
  }
  return {
    ...node,
    children: [sanitizeNode(node.children[0]), sanitizeNode(node.children[1])],
  }
}

export interface SessionSnapshot {
  tabs: Tab[]
  activeTabId: string | null
}

/** Persists which tabs/panes are currently open, dropping anything that
 * can't be safely reconnected (see restorableSource) and dropping whole
 * tabs left with nothing restorable at all. Called on every tabs/
 * activeTabId change rather than gated on a clean-exit hook, so a crash or
 * force-quit doesn't lose it — same reasoning as the vault/known_hosts
 * files being written on every edit instead of only on close. */
export function saveSnapshot(tabs: Tab[], activeTabId: string | null) {
  const sanitized = tabs
    .map((t) => ({ ...t, root: sanitizeNode(t.root) }))
    .filter((t) => allLeaves(t.root).some((l) => l.source))

  if (sanitized.length === 0) {
    clearSnapshot()
    return
  }

  const validActiveId = sanitized.some((t) => t.id === activeTabId) ? activeTabId : sanitized[0].id
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: sanitized, activeTabId: validActiveId }),
    )
  } catch {
    // Best-effort; a snapshot-persistence failure shouldn't break the app.
  }
}

export function loadSnapshot(): SessionSnapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function clearSnapshot() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Best-effort.
  }
}

export function countSessions(tabs: Tab[]): number {
  return tabs.reduce((n, t) => n + allLeaves(t.root).filter((l) => l.source).length, 0)
}

export function needsVaultUnlock(tabs: Tab[]): boolean {
  return tabs.some((t) => allLeaves(t.root).some((l) => l.source?.protocol === 'sshProfile'))
}
