// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as vault from '../lib/vault'
import { VaultMenu } from './VaultMenu'

vi.mock('../lib/vault', () => ({
  osUnlockAvailable: vi.fn(),
  osUnlockMethod: vi.fn(),
  beginMasterPasswordReset: vi.fn(),
  resetMasterPassword: vi.fn(),
  lock: vi.fn(),
}))
vi.mock('../lib/toast', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('./confirmContext', () => ({ useConfirm: () => vi.fn() }))

const mocked = vi.mocked(vault)

describe('resetting the master password', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocked.osUnlockAvailable.mockResolvedValue(true)
    mocked.osUnlockMethod.mockResolvedValue({
      label: 'Windows Hello',
      protection: 'hello-unattested',
    })
    mocked.beginMasterPasswordReset.mockResolvedValue(undefined)
    mocked.resetMasterPassword.mockResolvedValue(undefined)
  })

  afterEach(cleanup)

  async function openMenu(status: vault.VaultStatus = 'unlocked') {
    render(<VaultMenu status={status} onStatusChange={() => {}} />)
    fireEvent.click(screen.getByTitle(`Vault: ${status}`))
  }

  async function startReset() {
    await openMenu()
    fireEvent.click(await screen.findByText(/Reset master password\.\.\./))
    await screen.findByPlaceholderText('current master password')
  }

  const type = (placeholder: string, value: string) =>
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } })
  const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))

  it('is offered only on an unlocked vault', async () => {
    await openMenu('locked')
    await screen.findByPlaceholderText('master password')
    expect(screen.queryByText(/Reset master password/)).toBeNull()
  })

  it('asks who you are before asking for a new password', async () => {
    await startReset()
    expect(screen.queryByPlaceholderText('new master password')).toBeNull()
  })

  it('moves on with the current password', async () => {
    await startReset()
    type('current master password', 'old')
    press('Continue')
    await screen.findByPlaceholderText('new master password')
    expect(mocked.beginMasterPasswordReset).toHaveBeenCalledWith('old')
  })

  it('moves on with Windows Hello, without the current password', async () => {
    await startReset()
    fireEvent.click(await screen.findByRole('button', { name: /Use Windows Hello instead/ }))
    await screen.findByPlaceholderText('new master password')
    expect(mocked.beginMasterPasswordReset).toHaveBeenCalledWith(null)
  })

  it("doesn't offer a device unlock the vault doesn't have", async () => {
    mocked.osUnlockAvailable.mockResolvedValue(false)
    mocked.osUnlockMethod.mockResolvedValue(null)
    await startReset()
    expect(screen.queryByRole('button', { name: /instead/ })).toBeNull()
  })

  it('stays put when the proof is refused, and says why', async () => {
    mocked.beginMasterPasswordReset.mockRejectedValue('incorrect master password')
    await startReset()
    type('current master password', 'wrong')
    press('Continue')
    expect(await screen.findByText('incorrect master password')).toBeTruthy()
    expect(screen.queryByPlaceholderText('new master password')).toBeNull()
  })

  it('asks for something rather than sending a blank current password', async () => {
    await startReset()
    press('Continue')
    expect(await screen.findByText('Enter your current master password')).toBeTruthy()
    expect(mocked.beginMasterPasswordReset).not.toHaveBeenCalled()
  })

  async function atNewPassword() {
    await startReset()
    type('current master password', 'old')
    press('Continue')
    await screen.findByPlaceholderText('new master password')
  }

  it('sets the new password, and returns to the menu', async () => {
    await atNewPassword()
    type('new master password', 'next')
    type('confirm new password', 'next')
    press('Reset master password')
    await waitFor(() => expect(mocked.resetMasterPassword).toHaveBeenCalledWith('next'))
    expect(await screen.findByText(/Reset master password\.\.\./)).toBeTruthy()
  })

  it('refuses a new password that was mistyped', async () => {
    await atNewPassword()
    type('new master password', 'next')
    type('confirm new password', 'nxet')
    press('Reset master password')
    expect(await screen.findByText('Passwords do not match')).toBeTruthy()
    expect(mocked.resetMasterPassword).not.toHaveBeenCalled()
  })

  it('refuses an empty new password', async () => {
    await atNewPassword()
    press('Reset master password')
    expect(await screen.findByText('Enter a new master password')).toBeTruthy()
    expect(mocked.resetMasterPassword).not.toHaveBeenCalled()
  })

  it('can be cancelled from either step', async () => {
    await startReset()
    press('Cancel')
    expect(await screen.findByText(/Reset master password\.\.\./)).toBeTruthy()
    expect(mocked.beginMasterPasswordReset).not.toHaveBeenCalled()
  })
})
