// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionBrowser } from './SessionBrowser'
import type { SessionProfile } from '../lib/profiles'

afterEach(cleanup)

/**
 * Dismissing the context menu must not also click what's behind it. Two
 * overlapping guards: placement beside the row (see `menuAnchor`) limits
 * what a stray click can reach, and the backdrop stops a dismissing click
 * reaching anything.
 */

function profile(id: string, label: string): SessionProfile {
  return {
    id,
    label,
    folder: null,
    host: `${label}.example.net`,
    port: 22,
    protocol: 'ssh',
    username: 'tim',
    authType: 'agent',
    keyPath: null,
    hasCredential: false,
    jumpProfileId: null,
    termType: null,
    backspaceSendsCtrlH: null,
    autoReconnect: null,
    importRemoteHistory: null,
    keepaliveSeconds: null,
    wakeOnLan: null,
    serial: null,
    local: null,
  }
}

const sessions = [profile('a', 'alpha'), profile('b', 'bravo'), profile('c', 'charlie')]

function browser(props: Partial<Parameters<typeof SessionBrowser>[0]> = {}) {
  return (
    <SessionBrowser sessions={sessions} vaultUnlocked {...props}>
      <div>form</div>
    </SessionBrowser>
  )
}

describe('SessionBrowser context menu', () => {
  /**
   * jsdom has no layout and so no hit-testing: a click is dispatched at the
   * element you name, regardless of what covers it on screen. It therefore
   * cannot demonstrate the interception itself — that was verified against the
   * running app. What is asserted here is everything jsdom *can* see and that
   * the fix depends on: that an open menu puts a viewport-covering layer in
   * front of the list, and that a click on it closes the menu and selects
   * nothing. Take those away and the interception cannot happen either.
   */
  it('covers the list while the menu is open, and swallows the dismissing click', async () => {
    const onSelectSession = vi.fn()
    const { container } = render(browser({ onSelectSession }))

    expect(container.querySelector('[data-session-menu-backdrop]')).toBeNull()

    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByText('alpha') })
    expect(screen.getByText('Edit')).toBeTruthy()

    const backdrop = container.querySelector('[data-session-menu-backdrop]')
    expect(backdrop).not.toBeNull()
    // Covering the viewport is the whole mechanism: a backdrop that does not
    // sit over the rows lets the click through to them again.
    expect(backdrop!.className).toContain('fixed')
    expect(backdrop!.className).toContain('inset-0')

    await userEvent.click(backdrop!)

    expect(screen.queryByText('Edit')).toBeNull()
    expect(onSelectSession).not.toHaveBeenCalled()
  })

  it('closes on Escape without touching any session', async () => {
    const onSelectSession = vi.fn()
    render(browser({ onSelectSession }))

    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByText('alpha') })
    await userEvent.keyboard('{Escape}')

    // Escape dismisses too.
    expect(screen.queryByText('Edit')).toBeNull()
    expect(onSelectSession).not.toHaveBeenCalled()
  })

  it('still edits the profile whose menu was opened', async () => {
    const onEditSession = vi.fn()
    const onSelectSession = vi.fn()
    render(browser({ onEditSession, onSelectSession }))

    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByText('alpha') })
    await userEvent.click(screen.getByText('Edit'))

    // The right profile, and no stray selection of the row the item covered.
    expect(onEditSession).toHaveBeenCalledTimes(1)
    expect(onEditSession.mock.calls[0][0].label).toBe('alpha')
    expect(onSelectSession).not.toHaveBeenCalled()
  })

  it('still connects when a session is clicked with no menu open', async () => {
    const onSelectSession = vi.fn()
    render(browser({ onSelectSession }))

    await userEvent.click(screen.getByText('bravo'))

    expect(onSelectSession).toHaveBeenCalledTimes(1)
    expect(onSelectSession.mock.calls[0][0].label).toBe('bravo')
  })
})
