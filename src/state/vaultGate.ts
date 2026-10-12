import type { ConnectionSource } from '../lib/connection'
import type { SessionProfile } from '../lib/profiles'
import type { SessionSnapshot } from '../lib/sessionSnapshot'
import type { Workspace } from '../lib/workspaces'

/** What a vault unlock was for. One dispatcher and two shared unlock entry
 * points serve every vault-gated action, so adding one is a new union
 * member here. At module scope so tests can reach the dispatcher. */
export type VaultGatedAction =
  | { kind: 'restoreSessions'; snapshot: SessionSnapshot }
  | { kind: 'openWorkspace'; workspace: Workspace; originTabId: string | null }
  | { kind: 'connectProfile'; tabId: string; paneId: string; profile: SessionProfile }
  | { kind: 'reconnectPane'; tabId: string; paneId: string }

/** The effects the dispatcher performs, injected because they need App
 * (reducers, modal state, the Rust side). */
export interface VaultGateEffects {
  /** `true` for `vaultUsable`: every caller has just unlocked, before
   * `vaultStatus` state catches up. */
  applyRestore(snapshot: SessionSnapshot, vaultUsable: boolean): void
  materializeWorkspace(workspace: Workspace, vaultUsable: boolean, originTabId: string | null): void
  closeModal(): void
  /** Asked of the Rust side rather than React state, likewise. */
  hasCredential(profileId: string): Promise<boolean>
  applyProfileToPane(tabId: string, paneId: string, source: ConnectionSource | null, profile: SessionProfile): void
  /** Bumps the pane's generation so its Terminal remounts and dials again with
   * the source it already carries. */
  reconnectPane(tabId: string, paneId: string): void
}

/** Where a just-unlocked profile's connection reads credentials from. A
 * profile with no stored credential gets null and falls back to the pane's
 * connect form, rather than connecting with no key. */
export function profileConnectionSource(profileId: string, hasCredential: boolean): ConnectionSource | null {
  return hasCredential ? { protocol: 'sshProfile', profileId } : null
}

export async function runVaultGatedAction(
  action: VaultGatedAction,
  effects: VaultGateEffects,
): Promise<void> {
  switch (action.kind) {
    case 'restoreSessions':
      effects.applyRestore(action.snapshot, true)
      return
    case 'openWorkspace':
      effects.materializeWorkspace(action.workspace, true, action.originTabId)
      effects.closeModal()
      return
    case 'connectProfile': {
      // Checked against Rust; `vaultStatus` state hasn't caught up yet.
      const hasCredential = await effects.hasCredential(action.profile.id).catch(() => false)
      effects.applyProfileToPane(
        action.tabId,
        action.paneId,
        profileConnectionSource(action.profile.id, hasCredential),
        action.profile,
      )
      return
    }
    case 'reconnectPane':
      effects.reconnectPane(action.tabId, action.paneId)
      effects.closeModal()
      return
  }
}
