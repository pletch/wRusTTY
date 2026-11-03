import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfirmRequest } from '../components/confirmContext'
import { importVaultBundle } from './vaultTransfer'
import * as vault from './vault'

vi.mock('./vault', () => ({
  pickImport: vi.fn(),
  finishImport: vi.fn(),
  cancelImport: vi.fn(),
  exportVault: vi.fn(),
}))
vi.mock('./toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const mocked = vi.mocked(vault)

/** Answers each dialog in turn. A password dialog is checked with `password` first. */
function answering(answers: boolean[], password?: string) {
  const asked: ConfirmRequest[] = []
  const ask = async (request: ConfirmRequest) => {
    asked.push(request)
    if (request.checkPassword) return (await request.checkPassword(password ?? '')) === null
    return answers.shift() ?? false
  }
  return { ask, asked }
}

describe('importVaultBundle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocked.pickImport.mockResolvedValue(true)
    mocked.finishImport.mockResolvedValue(undefined)
    mocked.cancelImport.mockResolvedValue(undefined)
  })

  it('asks for the password after a file is picked, then imports with it', async () => {
    const { ask, asked } = answering([true], 'correct horse')
    expect(await importVaultBundle(ask)).toBe(true)
    expect(asked.map((r) => Boolean(r.checkPassword))).toEqual([false, true])
    expect(mocked.finishImport).toHaveBeenCalledWith('correct horse')
    expect(mocked.cancelImport).not.toHaveBeenCalled()
  })

  it('asks for nothing when the warning is declined', async () => {
    const { ask } = answering([false])
    expect(await importVaultBundle(ask)).toBe(false)
    expect(mocked.pickImport).not.toHaveBeenCalled()
  })

  it('asks for no password when no file is picked', async () => {
    mocked.pickImport.mockResolvedValue(false)
    const { ask, asked } = answering([true])
    expect(await importVaultBundle(ask)).toBe(false)
    expect(asked).toHaveLength(1)
  })

  it('reports a wrong password to the dialog rather than failing the import', async () => {
    mocked.finishImport.mockRejectedValue('incorrect master password')
    const seen: Array<string | null> = []
    const ask = async (request: ConfirmRequest) => {
      if (!request.checkPassword) return true
      seen.push(await request.checkPassword('wrong'))
      return false
    }
    expect(await importVaultBundle(ask)).toBe(false)
    expect(seen).toEqual(['incorrect master password'])
    expect(mocked.cancelImport).toHaveBeenCalled()
  })
})
