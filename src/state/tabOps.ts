import { sourceLabel } from '../lib/connection'
import { allLeaves, blankLeaf, findLeaf, firstLeaf } from '../lib/paneTree'
import type { SplitLimit } from '../lib/paneTree'
import { MAX_PANES_PER_TAB, MAX_PANE_COLUMNS, MAX_PANE_ROWS } from '../lib/paneTree'
import type { SessionProfile } from '../lib/profiles'
import * as sessionSnapshot from '../lib/sessionSnapshot'
import type { PaneLeaf, PaneNode, Tab } from '../types'

/** Tooltip on a split button that's been disabled by one of the limits in
 * paneTree.ts. Says which ceiling was hit and what to do instead, since a
 * dimmed button on its own just looks broken — and with per-axis caps the
 * other split direction is often still available, which isn't guessable. */
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
          : 'PublicKey',
    keyPath: profile.keyPath ?? undefined,
    hasCredential: profile.hasCredential,
    jumpProfileId: profile.jumpProfileId,
    termType: profile.termType,
    backspaceSendsCtrlH: profile.backspaceSendsCtrlH,
    keepaliveSeconds: profile.keepaliveSeconds,
    // Carried whole so editing a saved serial session opens the form on its
    // stored line settings *and* keeps the adapter identity — re-saving
    // without touching the port dropdown must not silently downgrade the
    // profile to name-only matching.
    serial: profile.serial,
  }
}

/** Re-resolves saved-profile panes against the live profile list as a stored
 * arrangement (a workspace, or the launch snapshot) is brought back.
 *
 * Both stores keep a copy of the profile's details in `initial`, captured when
 * the arrangement was saved — possibly months ago, and it only ever feeds the
 * connect form and the tab title (the connection itself carries just a profile
 * id, which Rust resolves fresh). So the live profile wins outright and the
 * stored copy is demoted to a fallback for one case: a profile that no longer
 * exists. That's what keeps a renamed or re-hosted profile from coming back
 * under its old name, and it holds for edits made outside the app or by a
 * vault import too — none of which could have written back into these files.
 *
 * Three outcomes per pane:
 *  - profile gone: blanked to a connect form, prefilled from the stored copy,
 *    since mounting it would only fail with "profile not found";
 *  - profile needs the vault and we don't have it: blanked to a connect form,
 *    prefilled from the *live* profile, which offers to unlock;
 *  - otherwise: kept connected, with its details refreshed. */
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
 * the pane that will be showing when it opens — otherwise a renamed profile
 * still surfaces under its old name in the tab bar, which is the one place
 * the staleness was actually visible. */
export function refreshTabs(tabs: Tab[], sessions: SessionProfile[], vaultUsable: boolean): Tab[] {
  return tabs.map((t) => {
    const root = refreshProfilePanes(t.root, sessions, vaultUsable)
    const active = findLeaf(root, t.activePaneId) ?? firstLeaf(root)
    return { ...t, root, title: leafTitle(active, t.title) }
  })
}

/** A tab holding one pane that has never connected — the state a new tab
 * starts in, showing the connect dialog. Opening a workspace from such a tab
 * should consume it rather than leave it stranded in front of the tabs it
 * just created. Any half-filled connect form in it goes too, which is fine:
 * choosing a workspace from that very form is choosing to move on. */
export function isBlankTab(tab: Tab): boolean {
  const leaves = allLeaves(tab.root)
  return leaves.length === 1 && !leaves[0].source
}

export function newTabId() {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// A leaf connected via a saved profile carries a `sshProfile` source whose
// only field is the profile's id — sourceLabel() for that variant returns
// the raw (UUID-looking) id, since resolving it to the profile's actual
// name requires the profile list, which isn't available down in lib/
// connection.ts. leaf.initial.label is filled in with the real name at
// connect time and is always the better title when present; every title
// computation should go through this instead of calling sourceLabel(source)
// directly, or a saved-profile pane's title regresses to its profile id
// the moment anything (focus, split, pop-out, attach) recomputes it.
export function leafTitle(leaf: PaneLeaf, fallback: string): string {
  if (leaf.initial?.label) return leaf.initial.label
  if (leaf.source) return sourceLabel(leaf.source)
  return fallback
}

// Serial data-bits enum → the digit used in conventional framing notation
// (e.g. the "8" in "8N1"), for the status bar's serial detail string.
export function dataBitsDigit(bits: 'Five' | 'Six' | 'Seven' | 'Eight'): number {
  return { Five: 5, Six: 6, Seven: 7, Eight: 8 }[bits]
}

export function blankTab(): Tab {
  const leaf = blankLeaf()
  return { id: newTabId(), title: 'New Connection', root: leaf, activePaneId: leaf.id }
}
