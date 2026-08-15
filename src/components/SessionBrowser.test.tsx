// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionBrowser } from './SessionBrowser'
import type { SessionProfile } from '../lib/profiles'

afterEach(cleanup)

/**
 * Dismissing the context menu must not also be a click on what is behind it.
 *
 * Dismissal used to be a `window` click listener: it closed the menu, and the
 * very same click carried on to whatever was underneath. With the vault
 * unlocked that connects to the wrong host; with it locked the whole browser is
 * replaced by that host's unlock prompt, which reads as the app deciding to
 * open a session nobody asked for. Both were reproduced against the running app
 * before this was fixed.
 *
 * The menu no longer opens over the list at all (see `menuAnchor`), so the two
 * fixes overlap — deliberately. Placement decides what a stray click *can*
 * reach; the backdrop decides whether a dismissing click reaches anything.
 * Either alone leaves a way to act on a session by trying to close a menu.
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
    keepaliveSeconds: null,
    wakeOnLan: null,
    serial: null,
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

    // The menu had no keyboard dismissal at all before — the only ways out
    // were choosing an item or clicking away, and clicking away was the bug.
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
