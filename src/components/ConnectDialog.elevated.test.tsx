// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectDialog } from './ConnectDialog'

/**
 * "Run as administrator" — phase 4 of docs/ELEVATED_TABS_PLAN.md.
 *
 * Every case here is about what the box may *not* do: be ticked for a shell
 * the elevated host would refuse, stay ticked after the shell changes, or send
 * anything but an `elevated` source when it is ticked.
 */

const shells = [
  { id: 'pwsh', label: 'PowerShell', command: 'C:/pwsh.exe', args: ['-NoLogo'] },
  { id: 'wsl:Ubuntu', label: 'Ubuntu', command: 'C:/wsl.exe', args: ['-d', 'Ubuntu'] },
]

vi.mock('../lib/local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/local')>()
  return { ...actual, listShells: () => Promise.resolve(shells) }
})

afterEach(cleanup)

const adminBox = () => screen.getByLabelText(/Run as administrator/i) as HTMLInputElement

async function openLocal(onConnect = vi.fn()) {
  render(<ConnectDialog onConnect={onConnect} vaultUnlocked={false} initial={{ protocol: 'local' }} />)
  // Detection fills the blank form with the first shell.
  await waitFor(() => expect(adminBox().disabled).toBe(false))
  return onConnect
}

describe('the run-as-administrator box', () => {
  it('is offered for an elevatable shell picked from the list', async () => {
    await openLocal()
    expect(adminBox().checked).toBe(false)
  })

  it('is disabled, and cleared, for a shell the host will not elevate', async () => {
    const user = userEvent.setup()
    await openLocal()
    await user.click(adminBox())
    expect(adminBox().checked).toBe(true)
    await user.selectOptions(screen.getByDisplayValue('PowerShell'), 'wsl:Ubuntu')
    expect(adminBox().disabled).toBe(true)
    expect(adminBox().checked).toBe(false)
    // Back to an elevatable shell: the tick does not come back by itself.
    await user.selectOptions(screen.getByDisplayValue('Ubuntu'), 'pwsh')
    expect(adminBox().checked).toBe(false)
  })

  it('is disabled for a hand-typed path', async () => {
    const user = userEvent.setup()
    await openLocal()
    const path = screen.getByPlaceholderText('path to shell')
    await user.clear(path)
    await user.type(path, 'C:/tools/pwsh.exe')
    expect(adminBox().disabled).toBe(true)
  })

  it('warns what an administrator tab means only once ticked', async () => {
    const user = userEvent.setup()
    await openLocal()
    expect(screen.queryByText(/UAC prompt/)).toBeNull()
    await user.click(adminBox())
    expect(screen.queryByText(/UAC prompt/)).toBeTruthy()
  })
})

describe('connecting', () => {
  it('sends an ordinary local source when unticked', async () => {
    const user = userEvent.setup()
    const onConnect = await openLocal()
    await user.click(screen.getByRole('button', { name: /^Connect$/ }))
    expect(onConnect.mock.calls[0][0].protocol).toBe('local')
  })

  it('sends an elevated source, with a form to restore to, when ticked', async () => {
    const user = userEvent.setup()
    const onConnect = await openLocal()
    await user.click(adminBox())
    await user.click(screen.getByRole('button', { name: /^Connect$/ }))
    const [source, , options] = onConnect.mock.calls[0]
    expect(source).toEqual({ protocol: 'elevated', shellId: 'pwsh', profileId: null })
    expect(options.form).toMatchObject({
      protocol: 'local',
      local: { shellId: 'pwsh', elevated: true },
    })
  })
})
