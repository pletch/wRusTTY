import { describe, it, expect, vi } from 'vitest'
import type { SessionProfile } from '../lib/profiles'
import type { SessionSnapshot } from '../lib/sessionSnapshot'
import type { Workspace } from '../lib/workspaces'
import { profileConnectionSource, runVaultGatedAction, type VaultGateEffects } from './vaultGate'

function profile(overrides: Partial<SessionProfile> = {}): SessionProfile {
  return {
    id: 'p1',
    label: 'Prod box',
    folder: null,
    host: 'h',
    port: 22,
    protocol: 'ssh',
    username: 'u',
    authType: 'password',
    keyPath: null,
    hasCredential: true,
    jumpProfileId: null,
    termType: null,
    backspaceSendsCtrlH: null,
    ...overrides,
  } as SessionProfile
}

function effects(overrides: Partial<VaultGateEffects> = {}) {
  return {
    applyRestore: vi.fn(),
    materializeWorkspace: vi.fn(),
    closeModal: vi.fn(),
    hasCredential: vi.fn().mockResolvedValue(true),
    applyProfileToPane: vi.fn(),
    reconnectPane: vi.fn(),
    ...overrides,
  } satisfies VaultGateEffects
}

describe('profileConnectionSource', () => {
  it('points at the vault only when a credential is actually stored', () => {
    expect(profileConnectionSource('p1', true)).toEqual({ protocol: 'sshProfile', profileId: 'p1' })
  })

  // A null source drops the pane back to its own connect form. Returning a
  // sshProfile source here instead would have the connection reach for a
  // credential the vault does not hold.
  it('returns no source when the vault has nothing for the profile', () => {
    expect(profileConnectionSource('p1', false)).toBeNull()
  })
})

describe('runVaultGatedAction', () => {
  // Every case below asserts both that the right effect ran and that the
  // others didn't — routing to a second action as well as the intended one is
  // the failure mode a "just add a union member" dispatcher invites.
  it('restores sessions with vaultUsable forced true', async () => {
    const e = effects()
    const snapshot = { tabs: [], activeTabId: 't1' } as unknown as SessionSnapshot
    await runVaultGatedAction({ kind: 'restoreSessions', snapshot }, e)
    // `true` rather than a read of vaultStatus: the caller has just unlocked
    // and React state has not caught up within the same call.
    expect(e.applyRestore).toHaveBeenCalledWith(snapshot, true)
    expect(e.materializeWorkspace).not.toHaveBeenCalled()
    expect(e.applyProfileToPane).not.toHaveBeenCalled()
  })

  it('materializes a workspace over its origin tab and closes the prompt', async () => {
    const e = effects()
    const workspace = { name: 'w', tabs: [] } as unknown as Workspace
    await runVaultGatedAction({ kind: 'openWorkspace', workspace, originTabId: 't7' }, e)
    expect(e.materializeWorkspace).toHaveBeenCalledWith(workspace, true, 't7')
    expect(e.closeModal).toHaveBeenCalled()
    expect(e.applyRestore).not.toHaveBeenCalled()
  })

  it('connects a profile through the vault when it holds a credential', async () => {
    const e = effects()
    const p = profile()
    await runVaultGatedAction({ kind: 'connectProfile', tabId: 't1', paneId: 'a', profile: p }, e)
    expect(e.hasCredential).toHaveBeenCalledWith('p1')
    expect(e.applyProfileToPane).toHaveBeenCalledWith(
      't1',
      'a',
      { protocol: 'sshProfile', profileId: 'p1' },
      p,
    )
  })

  it('falls back to the manual form when the vault has no credential', async () => {
    const e = effects({ hasCredential: vi.fn().mockResolvedValue(false) })
    const p = profile({ hasCredential: false })
    await runVaultGatedAction({ kind: 'connectProfile', tabId: 't1', paneId: 'a', profile: p }, e)
    expect(e.applyProfileToPane).toHaveBeenCalledWith('t1', 'a', null, p)
  })

  // The vault query crosses to the Rust side, which can fail for reasons that
  // have nothing to do with whether a credential exists (a vault relocked
  // between the unlock and this call). A rejection has to read as "no
  // credential" and still apply the profile, or picking a session leaves the
  // pane sitting on nothing at all.
  // The pane already holds the source it dropped from, so unlocking is the
  // whole of the fix: remount that one pane and dismiss the prompt, without
  // touching the restore or workspace paths.
  it('reconnects the waiting pane and closes the prompt', async () => {
    const e = effects()
    await runVaultGatedAction({ kind: 'reconnectPane', tabId: 't1', paneId: 'a' }, e)
    expect(e.reconnectPane).toHaveBeenCalledWith('t1', 'a')
    expect(e.closeModal).toHaveBeenCalled()
    expect(e.applyRestore).not.toHaveBeenCalled()
    expect(e.materializeWorkspace).not.toHaveBeenCalled()
    expect(e.applyProfileToPane).not.toHaveBeenCalled()
  })

  it('treats a failed vault query as no credential rather than aborting', async () => {
    const e = effects({ hasCredential: vi.fn().mockRejectedValue(new Error('locked')) })
    const p = profile()
    await runVaultGatedAction({ kind: 'connectProfile', tabId: 't1', paneId: 'a', profile: p }, e)
    expect(e.applyProfileToPane).toHaveBeenCalledWith('t1', 'a', null, p)
  })
})
