import type { ConnectionSource } from '../lib/connection'
import type { SessionProfile } from '../lib/profiles'
import type { SessionSnapshot } from '../lib/sessionSnapshot'
import type { Workspace } from '../lib/workspaces'

/** What a vault unlock was for — the launch-restore prompt, the
 * open-workspace prompt, and the per-pane saved-session sidebar's own unlock
 * form each used to hand-roll their own password/OS pair of unlock-then-act
 * functions (six total). One dispatcher plus two shared unlock entry points
 * replace all six; adding a fourth vault-gated action is a new union member
 * here, not a new pair of functions.
 *
 * The union and its dispatcher live at module scope rather than inside App's
 * component body so that claim is actually checkable: a test can add a member
 * and see the dispatcher fail to compile, and can assert that each existing
 * member reaches the right effect. Declared inside the body it was
 * unreachable from any test file, which made "a new union member is all it
 * takes" an assertion about code nobody could exercise. */
export type VaultGatedAction =
  | { kind: 'restoreSessions'; snapshot: SessionSnapshot }
  | { kind: 'openWorkspace'; workspace: Workspace; originTabId: string | null }
  | { kind: 'connectProfile'; tabId: string; paneId: string; profile: SessionProfile }

/** The effects the dispatcher performs, injected rather than closed over.
 * These are the parts that genuinely need App — they touch reducers, modal
 * state and the Rust side — so they stay there and the routing between them
 * comes here. */
export interface VaultGateEffects {
  /** `true` for `vaultUsable`: every caller of this dispatcher has just
   * unlocked, and `vaultStatus` React state won't have caught up within the
   * same call. */
  applyRestore(snapshot: SessionSnapshot, vaultUsable: boolean): void
  materializeWorkspace(workspace: Workspace, vaultUsable: boolean, originTabId: string | null): void
  closeModal(): void
  /** Asked of the Rust side rather than of React state, for the same reason. */
  hasCredential(profileId: string): Promise<boolean>
  applyProfileToPane(tabId: string, paneId: string, source: ConnectionSource | null, profile: SessionProfile): void
}

/** Where a just-unlocked profile's connection should read its credentials
 * from. Split out because it is the one branch in the dispatcher with a
 * decision in it rather than a call: a profile with no stored credential gets
 * a null source and falls back to the pane's own connect form, and getting
 * that backwards means silently connecting with no key. */
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
      // Checked fresh against the Rust side rather than trusting
      // `vaultStatus` React state, which wouldn't have caught up yet at this
      // point in the same call.
      const hasCredential = await effects.hasCredential(action.profile.id).catch(() => false)
      effects.applyProfileToPane(
        action.tabId,
        action.paneId,
        profileConnectionSource(action.profile.id, hasCredential),
        action.profile,
      )
      return
    }
  }
}
