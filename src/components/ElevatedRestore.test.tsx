// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ElevatedRestore } from './ElevatedRestore'

afterEach(cleanup)

function card(overrides: Partial<Parameters<typeof ElevatedRestore>[0]> = {}) {
  const props = {
    shellId: 'pwsh',
    onReopen: vi.fn(),
    onClose: vi.fn(),
    onEdit: vi.fn(),
    ...overrides,
  }
  render(<ElevatedRestore {...props} />)
  return props
}

describe('the restored administrator tab', () => {
  it('names the shell the way the tab did', () => {
    card()
    expect(screen.getByText('PowerShell · Administrator')).toBeTruthy()
  })

  it('prefers the tab’s own name when it had one', () => {
    card({ label: 'Build box' })
    expect(screen.getByText('Build box · Administrator')).toBeTruthy()
  })

  it('offers reopen, close, and the full form — each doing only its own thing', async () => {
    const user = userEvent.setup()
    const props = card()
    await user.click(screen.getByRole('button', { name: /Reopen as administrator/ }))
    expect(props.onReopen).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: /^Close$/ }))
    expect(props.onClose).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: /Change settings first/ }))
    expect(props.onEdit).toHaveBeenCalledOnce()
    expect(props.onReopen).toHaveBeenCalledOnce()
  })
})
