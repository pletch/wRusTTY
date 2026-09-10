import type { ConnectionSource } from './connection'
import { authNeedsVault } from './profiles'
import type { SessionProfile } from './profiles'
import type { PaneNode, Tab } from '../types'
import { allLeaves } from './paneTree'

const STORAGE_KEY = 'wrustty.session-snapshot'
// Pre-rebrand key (was wr-shell) — read as a fallback so an existing
// snapshot isn't silently dropped by the rename; the very next saveSnapshot
// call naturally retires it by writing under the new key instead.
const PREVIOUS_STORAGE_KEY = 'wr-shell.session-snapshot'

export interface SanitizeOptions {
  /** Serial panes are kept in the launch snapshot — it describes what was
   * open moments ago, when the port almost certainly still is what it was.
   * They are dropped from saved workspaces, which are reopened days or weeks
   * later, by which time a USB adapter moved to another socket has silently
   * become a different COM number pointing at the wrong device. */
  allowSerial: boolean
}

/** Only these protocols can be reconnected without ever collecting a
 * plaintext secret outside the vault — a manually-typed SSH connection's
 * password/passphrase was never persisted anywhere and never will be, so
 * those leaves are dropped (reverted to a blank pane) rather than restored
 * as a broken shell of themselves with no credential to actually use. */
function restorableSource(
  source: ConnectionSource | null,
  opts: SanitizeOptions,
): ConnectionSource | null {
  if (!source) return null
  if (source.protocol === 'sshProfile' || source.protocol === 'telnet') return source
  // A saved local shell needs no credential and nothing is on the other end of
  // a network, so restoring one can always succeed. It re-resolves its shell id
  // on the way back, exactly as a fresh connect does.
  if (source.protocol === 'localProfile') return source
  if (source.protocol === 'serial' && opts.allowSerial) return source
  return null
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

/** Strips unsaveable panes and then whole tabs left with nothing, shared by
 * the launch snapshot and saved workspaces so the two can't diverge on what
 * counts as safe to persist. */
export function sanitizeTabs(tabs: Tab[], opts: SanitizeOptions): Tab[] {
  return tabs
    .map((t) => ({ ...t, root: sanitizeNode(t.root, opts) }))
    .filter((t) => allLeaves(t.root).some((l) => l.source))
}

/** How many panes `sanitizeTabs` would drop — lets the save flow say so up
 * front rather than silently losing them. */
export function countUnsaveable(tabs: Tab[], opts: SanitizeOptions): number {
  return tabs.reduce(
    (n, t) =>
      n +
      allLeaves(t.root).filter((l) => l.source && !restorableSource(l.source, opts)).length,
    0,
  )
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
    // Best-effort; a snapshot-persistence failure shouldn't break the app.
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

/** Whether connecting this saved profile has to go through the vault.
 *
 * Agent and keyboard-interactive auth don't — see `authNeedsVault`, which owns
 * that judgement. A jump host does count even when the target
 * itself is agent-authenticated, because `ssh_connect_profile` resolves the
 * jump profile's *own* auth, which may well be a vaulted password. Only one
 * hop is considered, matching that same function ignoring any jump the jump
 * host itself names.
 *
 * A profile that isn't in the list is treated as vault-bound. That's the safe
 * direction — an unlock prompt that turns out to be unnecessary, rather than
 * a pane that mounts and immediately dies with "vault is locked" — and it's
 * also what happens on the first render at launch, before the profile list
 * has finished loading. */
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

/** Whether reconnecting `source` needs an unlocked vault. Shared by the
 * "should we prompt?" check and the "which panes do we blank?" pass, so the
 * two can't disagree about which panes the prompt was actually for. */
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
