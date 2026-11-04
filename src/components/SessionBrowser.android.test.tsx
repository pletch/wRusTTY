// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionProfile } from '../lib/profiles'

vi.mock('../lib/platform', async (original) => ({
  ...(await original<typeof import('../lib/platform')>()),
  isAndroid: true,
}))

import { SessionBrowser } from './SessionBrowser'

const SAVED = {
  id: 'one',
  label: 'mint-box',
  folder: null,
  host: 'mint-box.home',
  port: 22,
  protocol: 'ssh',
  username: 'tim',
  authType: 'agent',
  keyPath: null,
} as unknown as SessionProfile

const FORM = <input aria-label="Host" />

describe('SessionBrowser on a phone', () => {
  afterEach(cleanup)

  function formShowing() {
    return !screen.getByLabelText('Host').parentElement!.classList.contains('hidden')
  }

  it('opens on the saved list, with the form behind its tab', () => {
    render(<SessionBrowser sessions={[SAVED]}>{FORM}</SessionBrowser>)
    expect(screen.getByText('mint-box')).toBeTruthy()
    expect(formShowing()).toBe(false)
    fireEvent.click(screen.getByText('New connection'))
    expect(formShowing()).toBe(true)
    expect(screen.queryByText('mint-box')).toBeNull()
  })

  it('keeps what was typed when looking at the list and back', () => {
    render(<SessionBrowser sessions={[SAVED]}>{FORM}</SessionBrowser>)
    fireEvent.click(screen.getByText('New connection'))
    const host = screen.getByLabelText('Host') as HTMLInputElement
    fireEvent.change(host, { target: { value: 'typed.example' } })
    fireEvent.click(screen.getByText('Saved'))
    fireEvent.click(screen.getByText('New connection'))
    expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('typed.example')
  })

  it('opens on the form when told to, as when editing', () => {
    render(
      <SessionBrowser startOnForm sessions={[SAVED]}>
        {FORM}
      </SessionBrowser>,
    )
    expect(formShowing()).toBe(true)
  })

  it('shows just the form when nothing is saved', () => {
    render(<SessionBrowser sessions={[]}>{FORM}</SessionBrowser>)
    expect(formShowing()).toBe(true)
    expect(screen.queryByText('Saved')).toBeNull()
  })
})
