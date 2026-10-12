import { sourceLabel } from '../lib/connection'
import { allLeaves, blankLeaf, findLeaf, firstLeaf } from '../lib/paneTree'
import type { SplitLimit } from '../lib/paneTree'
import { MAX_PANES_PER_TAB, MAX_PANE_COLUMNS, MAX_PANE_ROWS } from '../lib/paneTree'
import type { SessionProfile } from '../lib/profiles'
import * as sessionSnapshot from '../lib/sessionSnapshot'
import type { PaneLeaf, PaneNode, Tab } from '../types'

/** Tooltip on a split button disabled by a paneTree.ts limit: which ceiling,
 * and what to do instead (often the other direction still works). */
export function splitLimitHint(limit: SplitLimit): string {
  switch (limit) {
    case 'panes':
      return `Split limit reached (${MAX_PANES_PER_TAB} panes per tab) — open a new tab instead`
    case 'rows':
      return `Split limit reached (${MAX_PANE_ROWS} panes top to bottom) — try splitting right`
    case 'columns':
      return `Split limit reached (${MAX_PANE_COLUMNS} panes side by side) — try splitting down`
  }
}

export function profileToInitial(profile: SessionProfile): PaneLeaf['initial'] {
  return {
    id: profile.id,
    protocol: profile.protocol,
    label: profile.label,
    folder: profile.folder,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authType:
      profile.authType === 'password'
        ? 'Password'
        : profile.authType === 'agent'
          ? 'Agent'
          : profile.authType === 'keyboard_interactive'
            ? 'Interactive'
            : 'PublicKey',
    keyPath: profile.keyPath ?? undefined,
    hasCredential: profile.hasCredential,
    jumpProfileId: profile.jumpProfileId,
    termType: profile.termType,
    backspaceSendsCtrlH: profile.backspaceSendsCtrlH,
    autoReconnect: profile.autoReconnect,
    keepaliveSeconds: profile.keepaliveSeconds,
    useProxy: profile.useProxy ?? null,
    logSession: profile.logSession ?? null,
    // Carried so editing other fields keeps the wake settings.
    wakeOnLan: profile.wakeOnLan,
    // Carried whole so the form opens on the stored line settings and re-saving
    // keeps the adapter identity.
    serial: profile.serial,
    // Likewise: open on the saved shell and keep its detected id.
    local: profile.local,
  }
}

/** Re-resolves saved-profile panes against the live profile list when a
 * workspace or the launch snapshot is restored.
 *
 * The stored `initial` copy only feeds the form and tab title (the
 * connection carries just an id), so the live profile wins and the stored
 * copy is a fallback for a deleted profile. Per pane:
 *  - profile gone: blanked to a form prefilled from the stored copy;
 *  - profile needs the vault and it's locked: blanked to a form prefilled
 *    from the live profile, which offers to unlock;
 *  - otherwise: kept, with details refreshed. */
export function refreshProfilePanes(
  node: PaneNode,
  sessions: SessionProfile[],
  vaultUsable: boolean,
): PaneNode {
  if (node.type === 'split') {
    return {
      ...node,
      children: [
        refreshProfilePanes(node.children[0], sessions, vaultUsable),
        refreshProfilePanes(node.children[1], sessions, vaultUsable),
      ],
    }
  }

  const source = node.source
  if (source?.protocol !== 'sshProfile') return node
  const profile = sessions.find((s) => s.id === source.profileId)
  if (!profile) return { ...node, source: null }
  const initial = profileToInitial(profile)
  if (!vaultUsable && sessionSnapshot.isVaultBound(source, sessions)) {
    return { ...node, source: null, initial }
  }
  return { ...node, initial }
}

/** Applies `refreshProfilePanes` to whole tabs, re-deriving each title from
 * the pane that will show, so a renamed profile isn't titled by its old
 * name. */
export function refreshTabs(tabs: Tab[], sessions: SessionProfile[], vaultUsable: boolean): Tab[] {
  return tabs.map((t) => {
    const root = refreshProfilePanes(t.root, sessions, vaultUsable)
    const active = findLeaf(root, t.activePaneId) ?? firstLeaf(root)
    return { ...t, root, title: leafTitle(active, t.title) }
  })
}

/** A tab with one never-connected pane (a new tab's connect dialog). Opening
 * a workspace from it consumes it, half-filled form included. */
export function isBlankTab(tab: Tab): boolean {
  const leaves = allLeaves(tab.root)
  return leaves.length === 1 && !leaves[0].source
}

export function newTabId() {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// A saved-profile leaf's `sshProfile` source holds only the profile id, so
// sourceLabel() returns that id; leaf.initial.label holds the real name.
// Every title computation should go through this.
export function leafTitle(leaf: PaneLeaf, fallback: string): string {
  if (leaf.initial?.label) return leaf.initial.label
  if (leaf.source) return sourceLabel(leaf.source)
  return fallback
}

// Serial data bits as the digit in framing notation (the "8" in "8N1").
export function dataBitsDigit(bits: 'Five' | 'Six' | 'Seven' | 'Eight'): number {
  return { Five: 5, Six: 6, Seven: 7, Eight: 8 }[bits]
}

export function blankTab(): Tab {
  const leaf = blankLeaf()
  return { id: newTabId(), title: 'New Connection', root: leaf, activePaneId: leaf.id }
}
