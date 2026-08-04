// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectDialog } from './ConnectDialog'
import type { SessionProfile } from '../lib/profiles'

afterEach(cleanup)

/**
 * The Wake-on-LAN group.
 *
 * Pinned because every interesting case here is a *conditional* — the field is
 * absent for protocols that don't wire waking, absent when a jump host makes
 * waking impossible, and its two qualifying inputs are absent until there's a
 * MAC for them to qualify. A field that appears when it shouldn't is worse
 * than cosmetic in the jump-host case: it would promise a packet the backend
 * deliberately never sends.
 */

const noop = () => {}

function dialog(props: Partial<Parameters<typeof ConnectDialog>[0]> = {}) {
  return (
    <ConnectDialog onConnect={noop} vaultUnlocked={false} {...props} />
  )
}

/** The MAC input, by its label. */
function macField() {
  return screen.queryByLabelText(/Wake-on-LAN/i)
}

describe('the Wake-on-LAN field', () => {
  it('is offered for an SSH session', () => {
    render(dialog())
    expect(macField()).toBeTruthy()
  })

  it('is not offered for telnet or serial, which have no wake wiring', async () => {
    render(dialog({ initial: { protocol: 'telnet' } }))
    expect(macField()).toBeNull()
    cleanup()
    render(dialog({ initial: { protocol: 'serial' } }))
    expect(macField()).toBeNull()
  })

  /** The backend refuses to wake a host behind a jump (a magic packet is a
   * local broadcast and the target isn't on this segment), so the form must
   * not offer a field that would do nothing. */
  it('disappears once a jump host is selected', async () => {
    const jump: SessionProfile = {
      id: 'jump-1',
      label: 'bastion',
      folder: null,
      host: 'bastion.example.net',
      port: 22,
      protocol: 'ssh',
      username: 'tim',
      authType: 'agent',
      keyPath: null,
      hasCredential: false,
      jumpProfileId: null,
      termType: null,
      backspaceSendsCtrlH: null,
      keepaliveSeconds: null,
      wakeOnLan: null,
      serial: null,
    }
    render(dialog({ sessions: [jump] }))
    expect(macField()).toBeTruthy()

    await userEvent.selectOptions(screen.getByLabelText(/Jump host/i), 'jump-1')
    expect(macField()).toBeNull()
  })

  /** Two more inputs on every SSH form would be noise for the majority of
   * sessions, which wake nothing. */
  it('reveals the broadcast and wait inputs only once a MAC is typed', async () => {
    render(dialog())
    expect(screen.queryByLabelText(/Broadcast to/i)).toBeNull()

    await userEvent.type(macField() as HTMLElement, 'aa:bb:cc:dd:ee:ff')

    expect(screen.getByLabelText(/Broadcast to/i)).toBeTruthy()
    expect(screen.getByLabelText(/Wait \(seconds\)/i)).toBeTruthy()
  })

  it('opens a saved session on the MAC it already had', () => {
    render(
      dialog({
        initial: {
          host: 'desktop.lan',
          wakeOnLan: { mac: 'aa:bb:cc:dd:ee:ff', broadcast: null, port: null, waitSeconds: null },
        },
      }),
    )
    expect((macField() as HTMLInputElement).value).toBe('aa:bb:cc:dd:ee:ff')
  })
})
