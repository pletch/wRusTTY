import type { ConnectionSource } from './connection'
import { authNeedsVault } from './profiles'
import type { SessionProfile } from './profiles'
import type { PaneNode, Tab } from '../types'
import { allLeaves } from './paneTree'

const STORAGE_KEY = 'wrustty.session-snapshot'
// The pre-rebrand key (wr-shell), read as a fallback; the next save writes
// under the new key.
const PREVIOUS_STORAGE_KEY = 'wr-shell.session-snapshot'

export interface SanitizeOptions {
  /** Keep serial panes. True for the launch snapshot (moments old); false for
   * saved workspaces, reopened later when a moved USB adapter may have a
   * different COM number. */
  allowSerial: boolean
}

/** The sources that can reconnect without a plaintext secret outside the
 * vault. A manually typed SSH password was never persisted, so those leaves
 * revert to blank panes. */
function restorableSource(
  source: ConnectionSource | null,
  opts: SanitizeOptions,
): ConnectionSource | null {
  if (!source) return null
  if (source.protocol === 'sshProfile' || source.protocol === 'telnet') return source
  // A saved local shell needs no credential; it re-resolves its shell id on
  // the way back.
  if (source.protocol === 'localProfile') return source
  // An unsaved local shell has no password either.
  if (source.protocol === 'local') return source
  if (source.protocol === 'serial' && opts.allowSerial) return source
  // An administrator shell never restores connected (decision 4 of
  // docs/ELEVATED_TABS_PLAN.md); it comes back as its form (see `keepsBlank`).
  return null
}

/** A pane restored without its connection but kept: an administrator shell
 * reopens as its reopen-or-close card (ElevatedRestore). */
function keepsBlank(source: ConnectionSource | null): boolean {
  return source?.protocol === 'elevated'
}

function sanitizeNode(node: PaneNode, opts: SanitizeOptions): PaneNode {
  if (node.type === 'leaf') {
    return { ...node, source: restorableSource(node.source, opts) }
  }
  return {
    ...node,
    children: [sanitizeNode(node.children[0], opts), sanitizeNode(node.children[1], opts)],
  }
}

/** Strips unsaveable panes, then tabs left empty. Shared by the launch
 * snapshot and saved workspaces. */
export function sanitizeTabs(tabs: Tab[], opts: SanitizeOptions): Tab[] {
  return tabs
    .filter((t) =>
      allLeaves(t.root).some((l) => keepsBlank(l.source) || restorableSource(l.source, opts)),
    )
    .map((t) => ({ ...t, root: sanitizeNode(t.root, opts) }))
}

/** How many panes `sanitizeTabs` would drop, so the save flow can say so. */
export function countUnsaveable(tabs: Tab[], opts: SanitizeOptions): number {
  return tabs.reduce(
    (n, t) =>
      n +
      allLeaves(t.root).filter(
        (l) => l.source && !keepsBlank(l.source) && !restorableSource(l.source, opts),
      ).length,
    0,
  )
}

export interface SessionSnapshot {
  tabs: Tab[]
  activeTabId: string | null
}

/** Persists the open tabs and panes, dropping anything that can't be safely
 * reconnected (see restorableSource) and tabs left empty. Called on every
 * change rather than on exit, so a crash doesn't lose it. */
export function saveSnapshot(tabs: Tab[], activeTabId: string | null) {
  const sanitized = sanitizeTabs(tabs, { allowSerial: true })

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
    // Best-effort.
  }
}

export function loadSnapshot(): SessionSnapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(PREVIOUS_STORAGE_KEY)
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

/** Administrator panes coming back as their reopen card, counted apart from
 * `countSessions` so the restore prompt can name them. */
export function countAwaitingElevation(tabs: Tab[]): number {
  return tabs.reduce(
    (n, t) => n + allLeaves(t.root).filter((l) => !l.source && l.initial?.local?.elevated).length,
    0,
  )
}

/** Whether connecting this saved profile goes through the vault.
 *
 * Agent and keyboard-interactive auth don't (see `authNeedsVault`), but a jump
 * host counts, since `ssh_connect_profile` resolves the jump profile's own
 * auth. Only one hop is considered, matching that function.
 *
 * An unknown profile counts as vault-bound (as on first render, before the
 * list loads): an unneeded unlock prompt beats a pane dying with "vault is
 * locked". */
function profileNeedsVault(profileId: string, sessions: SessionProfile[]): boolean {
  const profile = sessions.find((s) => s.id === profileId)
  if (!profile) return true
  if (authNeedsVault(profile.authType)) return true
  if (profile.jumpProfileId) {
    const jump = sessions.find((s) => s.id === profile.jumpProfileId)
    if (!jump || authNeedsVault(jump.authType)) return true
  }
  return false
}

/** Whether reconnecting `source` needs an unlocked vault. Shared by the prompt
 * check and the blanking pass so they agree. */
export function isVaultBound(
  source: ConnectionSource | null,
  sessions: SessionProfile[],
): boolean {
  if (source?.protocol !== 'sshProfile') return false
  return profileNeedsVault(source.profileId, sessions)
}

export function needsVaultUnlock(tabs: Tab[], sessions: SessionProfile[]): boolean {
  return tabs.some((t) => allLeaves(t.root).some((l) => isVaultBound(l.source, sessions)))
}
